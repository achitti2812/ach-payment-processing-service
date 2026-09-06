import type { Prisma } from "../generated/prisma/client.js";

import { WEBHOOK_DELIVERIES_REQUESTED } from "../domain/outbox-event-types.js";

export async function createWebhookDeliveriesOutboxEvent(
  transaction: Prisma.TransactionClient,
  paymentId: string,
  paymentEventId: string,
): Promise<void> {
  await transaction.outboxEvent.create({
    data: {
      type: WEBHOOK_DELIVERIES_REQUESTED,
      aggregateId: paymentId,
      payload: { paymentEventId },
    },
  });
}
