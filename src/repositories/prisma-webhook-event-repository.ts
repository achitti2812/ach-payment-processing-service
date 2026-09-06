import type { PrismaClient } from "../generated/prisma/client.js";

import {
  WEBHOOK_DELIVERIES_REQUESTED,
  WEBHOOK_DELIVERY_REQUESTED,
} from "../domain/outbox-event-types.js";
import type {
  WebhookEventMaterializationResult,
  WebhookEventRepository,
} from "./webhook-event-repository.js";

export class PrismaWebhookEventRepository implements WebhookEventRepository {
  constructor(private readonly client: PrismaClient) {}

  async materializeDeliveries(
    outboxEventId: string,
    paymentEventId: string,
    publishedAt: Date,
  ): Promise<WebhookEventMaterializationResult> {
    return this.client.$transaction(async (transaction) => {
      const sourceOutbox = await transaction.outboxEvent.findFirst({
        where: {
          id: outboxEventId,
          type: WEBHOOK_DELIVERIES_REQUESTED,
          publishedAt: null,
        },
        select: { id: true },
      });

      if (!sourceOutbox) {
        return { handled: false, deliveryCount: 0 };
      }

      const paymentEvent = await transaction.paymentEvent.findUnique({
        where: { id: paymentEventId },
        select: {
          id: true,
          payment: { select: { customerId: true } },
        },
      });

      if (!paymentEvent) {
        throw new Error(`Payment event ${paymentEventId} was not found`);
      }

      const subscriptions = await transaction.webhookSubscription.findMany({
        where: {
          customerId: paymentEvent.payment.customerId,
          enabled: true,
        },
        select: { id: true },
      });

      if (subscriptions.length > 0) {
        await transaction.webhookDelivery.createMany({
          data: subscriptions.map(({ id }) => ({
            subscriptionId: id,
            paymentEventId,
          })),
          skipDuplicates: true,
        });

        const deliveries = await transaction.webhookDelivery.findMany({
          where: {
            paymentEventId,
            subscriptionId: { in: subscriptions.map(({ id }) => id) },
          },
          select: { id: true },
        });

        await transaction.outboxEvent.createMany({
          data: deliveries.map(({ id }) => ({
            type: WEBHOOK_DELIVERY_REQUESTED,
            aggregateId: id,
            payload: {
              webhookDeliveryId: id,
              attemptNumber: 1,
            },
          })),
        });
      }

      await transaction.outboxEvent.update({
        where: { id: outboxEventId },
        data: {
          publishedAt,
          publishAttempts: { increment: 1 },
          lastError: null,
        },
      });

      return {
        handled: true,
        deliveryCount: subscriptions.length,
      };
    });
  }
}
