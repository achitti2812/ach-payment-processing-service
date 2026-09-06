import type { PaymentJobPublisher } from "../queues/payment-queue.js";
import type { OutboxRepository } from "../repositories/outbox-repository.js";
import {
  PAYMENT_PROCESS_REQUESTED,
  PAYMENT_RETRY_REQUESTED,
} from "../domain/outbox-event-types.js";

export interface DispatchSummary {
  found: number;
  published: number;
  failed: number;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown publication error";
  return message.slice(0, 2000);
}

interface RetryOutboxPayload {
  paymentId: string;
  nextAttemptNumber: number;
  nextRetryAt: string;
}

function retryPayload(payload: unknown): RetryOutboxPayload {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("paymentId" in payload) ||
    typeof payload.paymentId !== "string" ||
    !("nextAttemptNumber" in payload) ||
    !Number.isInteger(payload.nextAttemptNumber) ||
    !("nextRetryAt" in payload) ||
    typeof payload.nextRetryAt !== "string" ||
    Number.isNaN(Date.parse(payload.nextRetryAt))
  ) {
    throw new Error("Invalid payment retry outbox payload");
  }

  return payload as unknown as RetryOutboxPayload;
}

export class OutboxDispatcher {
  constructor(
    private readonly repository: OutboxRepository,
    private readonly publisher: PaymentJobPublisher,
    private readonly eventType = PAYMENT_PROCESS_REQUESTED,
  ) {}

  async dispatchBatch(limit: number): Promise<DispatchSummary> {
    const events = await this.repository.findUnpublished(this.eventType, limit);
    const summary: DispatchSummary = {
      found: events.length,
      published: 0,
      failed: 0,
    };

    for (const event of events) {
      try {
        if (this.eventType === PAYMENT_RETRY_REQUESTED) {
          if (!this.publisher.publishRetry) {
            throw new Error("The payment job publisher does not support retries");
          }

          const payload = retryPayload(event.payload);
          const delayMs = Math.max(0, Date.parse(payload.nextRetryAt) - Date.now());
          await this.publisher.publishRetry(
            payload.paymentId,
            payload.nextAttemptNumber,
            delayMs,
          );
        } else {
          await this.publisher.publish(event.aggregateId);
        }
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
