import {
  PaymentStatus,
  type PrismaClient,
} from "../generated/prisma/client.js";

import { assertPaymentTransition } from "../domain/payment-state-machine.js";
import type {
  PaymentClaimResult,
  PaymentProcessingRepository,
  ProcessingTransitionParams,
} from "./payment-processing-repository.js";

export class PrismaPaymentProcessingRepository implements PaymentProcessingRepository {
  constructor(private readonly client: PrismaClient) {}

  async claimPendingPayment(
    paymentId: string,
    correlationId: string,
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
        },
      });

      if (!payment) {
        return { outcome: "NOT_FOUND" };
      }

      if (payment.status !== PaymentStatus.PENDING) {
        return { outcome: "SKIPPED", status: payment.status };
      }

      assertPaymentTransition(PaymentStatus.PENDING, PaymentStatus.PROCESSING);

      const claimed = await transaction.payment.updateMany({
        where: {
          id: paymentId,
          status: PaymentStatus.PENDING,
        },
        data: {
          status: PaymentStatus.PROCESSING,
          attemptCount: { increment: 1 },
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
          fromStatus: PaymentStatus.PENDING,
          toStatus: PaymentStatus.PROCESSING,
          reason: "Payment processing started",
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
        },
      };
    });
  }

  async transitionProcessingPayment(params: ProcessingTransitionParams): Promise<boolean> {
    assertPaymentTransition(PaymentStatus.PROCESSING, params.toStatus);

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
          nextRetryAt: null,
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

      return true;
    });
  }
}
