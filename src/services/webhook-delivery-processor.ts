import { WebhookDeliveryStatus } from "../generated/prisma/enums.js";
import {
  WEBHOOK_EVENT_TYPE,
  calculateWebhookRetryDelay,
  serializeWebhookPayload,
  signWebhookBody,
  type PaymentStatusChangedWebhookPayload,
} from "../domain/webhook.js";
import type { WebhookDeliveryRepository } from "../repositories/webhook-delivery-repository.js";
import type { WebhookHttpClient } from "../webhooks/webhook-http-client.js";

export type WebhookDeliveryOutcome =
  | "DELIVERED"
  | "RETRYING"
  | "FAILED"
  | "DISABLED"
  | "SKIPPED"
  | "NOT_FOUND";

export type WebhookDeliveryResult =
  | WebhookDeliveryOutcome
  | { outcome: "NOT_DUE"; nextAttemptAt: Date };

export interface WebhookDeliveryProcessorOptions {
  retryBaseDelayMs: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  now?: () => Date;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError"
      ? "Webhook request timed out"
      : error.message;
  }

  return "Webhook request failed";
}

export class WebhookDeliveryProcessor {
  private readonly now: () => Date;

  constructor(
    private readonly repository: WebhookDeliveryRepository,
    private readonly httpClient: WebhookHttpClient,
    private readonly options: WebhookDeliveryProcessorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async process(
    webhookDeliveryId: string,
    expectedAttemptNumber: number,
  ): Promise<WebhookDeliveryResult> {
    const claim = await this.repository.claimAttempt(
      webhookDeliveryId,
      expectedAttemptNumber,
      this.options.maxAttempts,
      this.now(),
    );

    if (claim.outcome === "NOT_DUE") {
      return claim;
    }

    if (claim.outcome !== "CLAIMED") {
      return claim.outcome;
    }

    const { delivery } = claim;
    const payload: PaymentStatusChangedWebhookPayload = {
      eventId: delivery.paymentEvent.id,
      eventType: WEBHOOK_EVENT_TYPE,
      paymentId: delivery.paymentEvent.paymentId,
      customerId: delivery.paymentEvent.customerId,
      fromStatus: delivery.paymentEvent.fromStatus,
      toStatus: delivery.paymentEvent.toStatus,
      reason: delivery.paymentEvent.reason,
      occurredAt: delivery.paymentEvent.createdAt.toISOString(),
    };
    const rawBody = serializeWebhookPayload(payload);
    const timestamp = this.now().toISOString();
    let httpStatus: number | null = null;
    let failure: string | null = null;

    try {
      const response = await this.httpClient.post(
        delivery.url,
        rawBody,
        {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signWebhookBody(delivery.signingSecret, rawBody),
          "X-Webhook-Event-Id": delivery.paymentEvent.id,
          "X-Webhook-Timestamp": timestamp,
        },
        this.options.requestTimeoutMs,
      );
      httpStatus = response.status;

      if (response.status >= 200 && response.status < 300) {
        const delivered = await this.repository.markDelivered(
          delivery.id,
          delivery.attemptNumber,
          response.status,
          this.now(),
        );
        return delivered ? "DELIVERED" : "SKIPPED";
      }

      failure = `Webhook endpoint returned HTTP ${response.status}`;
    } catch (error) {
      failure = errorMessage(error);
    }

    if (delivery.attemptNumber >= this.options.maxAttempts) {
      const failed = await this.repository.recordFailure({
        webhookDeliveryId: delivery.id,
        attemptNumber: delivery.attemptNumber,
        status: WebhookDeliveryStatus.FAILED,
        nextAttemptAt: null,
        lastHttpStatus: httpStatus,
        lastError: failure,
      });
      return failed ? "FAILED" : "SKIPPED";
    }

    const delayMs = calculateWebhookRetryDelay(
      this.options.retryBaseDelayMs,
      delivery.attemptNumber,
    );
    const nextAttemptAt = new Date(this.now().getTime() + delayMs);
    const retrying = await this.repository.recordFailure({
      webhookDeliveryId: delivery.id,
      attemptNumber: delivery.attemptNumber,
      status: WebhookDeliveryStatus.RETRYING,
      nextAttemptAt,
      lastHttpStatus: httpStatus,
      lastError: failure,
      nextAttemptNumber: delivery.attemptNumber + 1,
    });

    return retrying ? "RETRYING" : "SKIPPED";
  }
}
