import {
  WebhookDeliveryStatus,
  type PrismaClient,
} from "../generated/prisma/client.js";

import { WEBHOOK_DELIVERY_REQUESTED } from "../domain/outbox-event-types.js";
import type {
  WebhookDeliveryClaimResult,
  WebhookDeliveryFailureParams,
  WebhookDeliveryRepository,
} from "./webhook-delivery-repository.js";

const claimableStatuses: WebhookDeliveryStatus[] = [
  WebhookDeliveryStatus.PENDING,
  WebhookDeliveryStatus.RETRYING,
];

export class PrismaWebhookDeliveryRepository
  implements WebhookDeliveryRepository
{
  constructor(private readonly client: PrismaClient) {}

  async claimAttempt(
    webhookDeliveryId: string,
    expectedAttemptNumber: number,
    maxAttempts: number,
    claimedAt: Date,
  ): Promise<WebhookDeliveryClaimResult> {
    return this.client.$transaction(async (transaction) => {
      const delivery = await transaction.webhookDelivery.findUnique({
        where: { id: webhookDeliveryId },
        select: {
          id: true,
          status: true,
          attemptCount: true,
          nextAttemptAt: true,
          subscription: {
            select: {
              enabled: true,
              url: true,
              signingSecret: true,
            },
          },
          paymentEvent: {
            select: {
              id: true,
              paymentId: true,
              fromStatus: true,
              toStatus: true,
              reason: true,
              createdAt: true,
              payment: { select: { customerId: true } },
            },
          },
        },
      });

      if (!delivery) {
        return { outcome: "NOT_FOUND" };
      }

      if (!claimableStatuses.includes(delivery.status)) {
        return { outcome: "SKIPPED", status: delivery.status };
      }

      if (!delivery.subscription.enabled) {
        await transaction.webhookDelivery.updateMany({
          where: {
            id: delivery.id,
            status: delivery.status,
            attemptCount: delivery.attemptCount,
          },
          data: {
            status: WebhookDeliveryStatus.FAILED,
            nextAttemptAt: null,
            lastError: "Webhook subscription is disabled",
          },
        });
        return { outcome: "DISABLED" };
      }

      const nextAttemptNumber = delivery.attemptCount + 1;
      const initialAttemptIsEligible =
        delivery.status === WebhookDeliveryStatus.PENDING &&
        delivery.attemptCount === 0;
      const retryIsEligible =
        delivery.status === WebhookDeliveryStatus.RETRYING &&
        delivery.nextAttemptAt !== null &&
        delivery.nextAttemptAt <= claimedAt;

      if (
        delivery.status === WebhookDeliveryStatus.RETRYING &&
        expectedAttemptNumber === nextAttemptNumber &&
        nextAttemptNumber <= maxAttempts &&
        delivery.nextAttemptAt !== null &&
        delivery.nextAttemptAt > claimedAt
      ) {
        return {
          outcome: "NOT_DUE",
          nextAttemptAt: delivery.nextAttemptAt,
        };
      }

      if (
        (!initialAttemptIsEligible && !retryIsEligible) ||
        expectedAttemptNumber !== nextAttemptNumber ||
        nextAttemptNumber > maxAttempts
      ) {
        return { outcome: "SKIPPED", status: delivery.status };
      }

      const claimed = await transaction.webhookDelivery.updateMany({
        where: {
          id: delivery.id,
          status: delivery.status,
          attemptCount: delivery.attemptCount,
          subscription: { enabled: true },
          ...(delivery.status === WebhookDeliveryStatus.RETRYING
            ? { nextAttemptAt: { lte: claimedAt } }
            : {}),
        },
        data: {
          attemptCount: { increment: 1 },
          nextAttemptAt: null,
        },
      });

      if (claimed.count === 0) {
        return { outcome: "SKIPPED", status: delivery.status };
      }

      return {
        outcome: "CLAIMED",
        delivery: {
          id: delivery.id,
          attemptNumber: nextAttemptNumber,
          url: delivery.subscription.url,
          signingSecret: delivery.subscription.signingSecret,
          paymentEvent: {
            id: delivery.paymentEvent.id,
            paymentId: delivery.paymentEvent.paymentId,
            customerId: delivery.paymentEvent.payment.customerId,
            fromStatus: delivery.paymentEvent.fromStatus,
            toStatus: delivery.paymentEvent.toStatus,
            reason: delivery.paymentEvent.reason,
            createdAt: delivery.paymentEvent.createdAt,
          },
        },
      };
    });
  }

  async markDelivered(
    webhookDeliveryId: string,
    attemptNumber: number,
    httpStatus: number,
    deliveredAt: Date,
  ): Promise<boolean> {
    const updated = await this.client.webhookDelivery.updateMany({
      where: {
        id: webhookDeliveryId,
        status: { in: claimableStatuses },
        attemptCount: attemptNumber,
      },
      data: {
        status: WebhookDeliveryStatus.DELIVERED,
        deliveredAt,
        nextAttemptAt: null,
        lastHttpStatus: httpStatus,
        lastError: null,
      },
    });

    return updated.count === 1;
  }

  async recordFailure(params: WebhookDeliveryFailureParams): Promise<boolean> {
    return this.client.$transaction(async (transaction) => {
      const updated = await transaction.webhookDelivery.updateMany({
        where: {
          id: params.webhookDeliveryId,
          status: { in: claimableStatuses },
          attemptCount: params.attemptNumber,
        },
        data: {
          status: params.status,
          nextAttemptAt: params.nextAttemptAt,
          lastHttpStatus: params.lastHttpStatus,
          lastError: params.lastError.slice(0, 2000),
        },
      });

      if (updated.count === 0) {
        return false;
      }

      if (
        params.status === WebhookDeliveryStatus.RETRYING &&
        params.nextAttemptAt &&
        params.nextAttemptNumber
      ) {
        await transaction.outboxEvent.create({
          data: {
            type: WEBHOOK_DELIVERY_REQUESTED,
            aggregateId: params.webhookDeliveryId,
            payload: {
              webhookDeliveryId: params.webhookDeliveryId,
              attemptNumber: params.nextAttemptNumber,
              nextAttemptAt: params.nextAttemptAt.toISOString(),
            },
          },
        });
      }

      return true;
    });
  }
}
