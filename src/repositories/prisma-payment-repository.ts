import {
  PaymentStatus,
  Prisma,
  type PrismaClient,
} from "../generated/prisma/client.js";

import { IdempotencyKeyAlreadyExistsError } from "../domain/errors.js";
import type {
  CreatePaymentSubmissionParams,
  IdempotentPaymentRecord,
  PaymentAuditHistoryRecord,
  PaymentDetailsRecord,
  PaymentRecord,
  PaymentRepository,
} from "./payment-repository.js";

const paymentSelect = {
  id: true,
  customerId: true,
  sourceAccount: true,
  destinationAccount: true,
  amount: true,
  reference: true,
  status: true,
  attemptCount: true,
  maxAttempts: true,
  failureCode: true,
  failureMessage: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
} satisfies Prisma.PaymentSelect;

const paymentEventSelect = {
  id: true,
  sequenceNumber: true,
  fromStatus: true,
  toStatus: true,
  reason: true,
  actor: true,
  correlationId: true,
  createdAt: true,
} satisfies Prisma.PaymentEventSelect;

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly client: PrismaClient) {}

  async findByIdempotencyKey(
    customerId: string,
    idempotencyKey: string,
  ): Promise<IdempotentPaymentRecord | null> {
    return this.client.idempotencyRecord.findUnique({
      where: {
        customerId_idempotencyKey: {
          customerId,
          idempotencyKey,
        },
      },
      select: {
        requestHash: true,
        payment: {
          select: paymentSelect,
        },
      },
    });
  }

  async findPaymentById(paymentId: string): Promise<PaymentDetailsRecord | null> {
    return this.client.payment.findUnique({
      where: { id: paymentId },
      select: paymentSelect,
    });
  }

  async findPaymentAuditHistory(
    paymentId: string,
  ): Promise<PaymentAuditHistoryRecord | null> {
    return this.client.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        events: {
          orderBy: { sequenceNumber: "asc" },
          select: paymentEventSelect,
        },
      },
    });
  }

  async createPaymentSubmission(
    params: CreatePaymentSubmissionParams,
  ): Promise<PaymentRecord> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const payment = await transaction.payment.create({
          data: {
            ...params.payment,
            status: PaymentStatus.PENDING,
          },
          select: paymentSelect,
        });

        await transaction.idempotencyRecord.create({
          data: {
            customerId: params.payment.customerId,
            idempotencyKey: params.idempotencyKey,
            requestHash: params.requestHash,
            paymentId: payment.id,
          },
        });

        await transaction.paymentEvent.create({
          data: {
            paymentId: payment.id,
            sequenceNumber: 1,
            fromStatus: null,
            toStatus: PaymentStatus.PENDING,
            actor: "api",
            reason: "Payment submitted",
            correlationId: params.correlationId,
          },
        });

        await transaction.outboxEvent.create({
          data: {
            type: params.outboxType,
            aggregateId: payment.id,
            payload: {
              paymentId: payment.id,
            },
          },
        });

        return payment;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new IdempotencyKeyAlreadyExistsError({ cause: error });
      }

      throw error;
    }
  }
}
