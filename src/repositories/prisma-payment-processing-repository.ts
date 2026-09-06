import {
  PaymentStatus,
  type PrismaClient,
} from "../generated/prisma/client.js";

import { PAYMENT_RETRY_REQUESTED } from "../domain/outbox-event-types.js";
import { assertPaymentTransition } from "../domain/payment-state-machine.js";
import type {
  PaymentClaimResult,
  PaymentProcessingRepository,
  ProcessingTransitionParams,
} from "./payment-processing-repository.js";

export class PrismaPaymentProcessingRepository implements PaymentProcessingRepository {
  constructor(private readonly client: PrismaClient) {}

  async claimPaymentAttempt(
    paymentId: string,
    expectedAttemptNumber: number | undefined,
    correlationId: string,
    claimedAt: Date,
  ): Promise<PaymentClaimResult> {
    return this.client.$transaction(async (transaction) => {
      const payment = await transaction.payment.findUnique({
        where: { id: paymentId },
        select: {
          id: true,
          sourceAccount: true,
          destinationAccount: true,
          amount: true,
          reference: true,
          status: true,
          attemptCount: true,
          maxAttempts: true,
          nextRetryAt: true,
        },
      });

      if (!payment) {
        return { outcome: "NOT_FOUND" };
      }

      const isInitialAttempt =
        payment.status === PaymentStatus.PENDING && payment.attemptCount === 0;
      const isDueRetry =
        payment.status === PaymentStatus.RETRYING &&
        expectedAttemptNumber !== undefined &&
        expectedAttemptNumber === payment.attemptCount + 1 &&
        payment.nextRetryAt !== null &&
        payment.nextRetryAt <= claimedAt;

      if (!isInitialAttempt && !isDueRetry) {
        return { outcome: "SKIPPED", status: payment.status };
      }

      const nextAttemptNumber = payment.attemptCount + 1;

      if (
        nextAttemptNumber > payment.maxAttempts ||
        (expectedAttemptNumber !== undefined && expectedAttemptNumber !== nextAttemptNumber)
      ) {
        return { outcome: "SKIPPED", status: payment.status };
      }

      const fromStatus = isInitialAttempt
        ? PaymentStatus.PENDING
        : PaymentStatus.RETRYING;
      assertPaymentTransition(fromStatus, PaymentStatus.PROCESSING);

      const claimed = isInitialAttempt
        ? await transaction.payment.updateMany({
            where: {
              id: paymentId,
              status: PaymentStatus.PENDING,
              attemptCount: payment.attemptCount,
            },
            data: {
              status: PaymentStatus.PROCESSING,
              attemptCount: { increment: 1 },
              nextRetryAt: null,
            },
          })
        : await transaction.payment.updateMany({
            where: {
              id: paymentId,
              status: PaymentStatus.RETRYING,
              attemptCount: payment.attemptCount,
              nextRetryAt: { lte: claimedAt },
            },
            data: {
              status: PaymentStatus.PROCESSING,
              attemptCount: { increment: 1 },
              nextRetryAt: null,
            },
          });

      if (claimed.count === 0) {
        return { outcome: "SKIPPED", status: payment.status };
      }

      const sequence = await transaction.paymentEvent.aggregate({
        where: { paymentId },
        _max: { sequenceNumber: true },
      });

      await transaction.paymentEvent.create({
        data: {
          paymentId,
          sequenceNumber: (sequence._max.sequenceNumber ?? 0) + 1,
          fromStatus,
          toStatus: PaymentStatus.PROCESSING,
          reason: isInitialAttempt
            ? "Payment processing started"
            : "Payment retry started",
          actor: "payment-worker",
          correlationId,
        },
      });

      return {
        outcome: "CLAIMED",
        payment: {
          id: payment.id,
          sourceAccount: payment.sourceAccount,
          destinationAccount: payment.destinationAccount,
          amount: payment.amount,
          reference: payment.reference,
          attemptNumber: nextAttemptNumber,
          maxAttempts: payment.maxAttempts,
        },
      };
    });
  }

  async transitionProcessingPayment(params: ProcessingTransitionParams): Promise<boolean> {
    assertPaymentTransition(PaymentStatus.PROCESSING, params.toStatus);

    if (
      params.toStatus === PaymentStatus.RETRYING &&
      (!params.nextRetryAt || !params.retrySchedule)
    ) {
      throw new Error("A retry transition requires a retry time and schedule");
    }

    return this.client.$transaction(async (transaction) => {
      const transitioned = await transaction.payment.updateMany({
        where: {
          id: params.paymentId,
          status: PaymentStatus.PROCESSING,
        },
        data: {
          status: params.toStatus,
          bankExecutionId: params.bankExecutionId,
          failureCode: params.failureCode,
          failureMessage: params.failureMessage,
          completedAt: params.completedAt,
          nextRetryAt: params.nextRetryAt,
        },
      });

      if (transitioned.count === 0) {
        return false;
      }

      const sequence = await transaction.paymentEvent.aggregate({
        where: { paymentId: params.paymentId },
        _max: { sequenceNumber: true },
      });

      await transaction.paymentEvent.create({
        data: {
          paymentId: params.paymentId,
          sequenceNumber: (sequence._max.sequenceNumber ?? 0) + 1,
          fromStatus: PaymentStatus.PROCESSING,
          toStatus: params.toStatus,
          reason: params.reason,
          actor: "payment-worker",
          correlationId: params.correlationId,
        },
      });

      if (params.toStatus === PaymentStatus.RETRYING && params.retrySchedule) {
        await transaction.outboxEvent.create({
          data: {
            type: PAYMENT_RETRY_REQUESTED,
            aggregateId: params.paymentId,
            payload: {
              paymentId: params.paymentId,
              nextAttemptNumber: params.retrySchedule.nextAttemptNumber,
              nextRetryAt: params.nextRetryAt?.toISOString(),
            },
          },
        });
      }

      return true;
    });
  }
}
