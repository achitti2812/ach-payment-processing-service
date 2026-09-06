import type { PaymentJobPublisher } from "../queues/payment-queue.js";
import type { OutboxRepository } from "../repositories/outbox-repository.js";
import { PAYMENT_PROCESS_REQUESTED } from "./payment-service.js";

export interface DispatchSummary {
  found: number;
  published: number;
  failed: number;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown publication error";
  return message.slice(0, 2000);
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
        await this.publisher.publish(event.aggregateId);
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
