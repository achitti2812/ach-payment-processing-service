import { WEBHOOK_DELIVERIES_REQUESTED } from "../domain/outbox-event-types.js";
import type { OutboxRepository } from "../repositories/outbox-repository.js";
import type { WebhookEventRepository } from "../repositories/webhook-event-repository.js";

export interface WebhookMaterializationSummary {
  found: number;
  handled: number;
  deliveries: number;
  failed: number;
}

function paymentEventId(payload: unknown): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("paymentEventId" in payload) ||
    typeof payload.paymentEventId !== "string"
  ) {
    throw new Error("Invalid webhook deliveries outbox payload");
  }

  return payload.paymentEventId;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown materialization error").slice(
    0,
    2000,
  );
}

export class WebhookEventMaterializer {
  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly webhookEventRepository: WebhookEventRepository,
  ) {}

  async materializeBatch(limit: number): Promise<WebhookMaterializationSummary> {
    const events = await this.outboxRepository.findUnpublished(
      WEBHOOK_DELIVERIES_REQUESTED,
      limit,
    );
    const summary: WebhookMaterializationSummary = {
      found: events.length,
      handled: 0,
      deliveries: 0,
      failed: 0,
    };

    for (const event of events) {
      try {
        const result = await this.webhookEventRepository.materializeDeliveries(
          event.id,
          paymentEventId(event.payload),
          new Date(),
        );
        summary.handled += result.handled ? 1 : 0;
        summary.deliveries += result.deliveryCount;
      } catch (error) {
        await this.outboxRepository.recordPublishFailure(event.id, errorMessage(error));
        summary.failed += 1;
      }
    }

    return summary;
  }
}
