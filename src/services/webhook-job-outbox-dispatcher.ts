import { WEBHOOK_DELIVERY_REQUESTED } from "../domain/outbox-event-types.js";
import type { WebhookJobPublisher } from "../queues/webhook-queue.js";
import type { OutboxRepository } from "../repositories/outbox-repository.js";
import type { DispatchSummary } from "./outbox-dispatcher.js";

interface WebhookDeliveryOutboxPayload {
  webhookDeliveryId: string;
  attemptNumber: number;
  nextAttemptAt?: string;
}

function webhookDeliveryPayload(payload: unknown): WebhookDeliveryOutboxPayload {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("webhookDeliveryId" in payload) ||
    typeof payload.webhookDeliveryId !== "string" ||
    !("attemptNumber" in payload) ||
    !Number.isInteger(payload.attemptNumber)
  ) {
    throw new Error("Invalid webhook delivery outbox payload");
  }

  if (
    "nextAttemptAt" in payload &&
    (typeof payload.nextAttemptAt !== "string" ||
      Number.isNaN(Date.parse(payload.nextAttemptAt)))
  ) {
    throw new Error("Invalid webhook retry time");
  }

  return payload as unknown as WebhookDeliveryOutboxPayload;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown publication error").slice(
    0,
    2000,
  );
}

export class WebhookJobOutboxDispatcher {
  constructor(
    private readonly repository: OutboxRepository,
    private readonly publisher: WebhookJobPublisher,
  ) {}

  async dispatchBatch(limit: number): Promise<DispatchSummary> {
    const events = await this.repository.findUnpublished(
      WEBHOOK_DELIVERY_REQUESTED,
      limit,
    );
    const summary: DispatchSummary = {
      found: events.length,
      published: 0,
      failed: 0,
    };

    for (const event of events) {
      try {
        const payload = webhookDeliveryPayload(event.payload);
        const delayMs = payload.nextAttemptAt
          ? Math.max(0, Date.parse(payload.nextAttemptAt) - Date.now())
          : 0;
        await this.publisher.publish(
          payload.webhookDeliveryId,
          payload.attemptNumber,
          delayMs,
        );
        await this.repository.markPublished(event.id, new Date());
        summary.published += 1;
      } catch (error) {
        await this.repository.recordPublishFailure(event.id, errorMessage(error));
        summary.failed += 1;
      }
    }

    return summary;
  }
}
