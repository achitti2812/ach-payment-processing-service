import type { PaymentStatus, Prisma } from "../generated/prisma/client.js";

import type { NormalizedPaymentSubmission } from "../domain/payment.js";

export interface PaymentRecord {
  id: string;
  customerId: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: Prisma.Decimal;
  reference: string;
  status: PaymentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentDetailsRecord extends PaymentRecord {
  attemptCount: number;
  maxAttempts: number;
  failureCode: string | null;
  failureMessage: string | null;
  completedAt: Date | null;
}

export interface PaymentEventRecord {
  id: string;
  sequenceNumber: number;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus;
  reason: string;
  actor: string;
  correlationId: string;
  createdAt: Date;
}

export interface PaymentAuditHistoryRecord {
  id: string;
  events: PaymentEventRecord[];
}

export interface IdempotentPaymentRecord {
  requestHash: string;
  payment: PaymentRecord;
}

export interface CreatePaymentSubmissionParams {
  payment: NormalizedPaymentSubmission;
  idempotencyKey: string;
  requestHash: string;
  correlationId: string;
  outboxType: string;
}

export interface PaymentRepository {
  findByIdempotencyKey(
    customerId: string,
    idempotencyKey: string,
  ): Promise<IdempotentPaymentRecord | null>;

  createPaymentSubmission(params: CreatePaymentSubmissionParams): Promise<PaymentRecord>;

  findPaymentById(paymentId: string): Promise<PaymentDetailsRecord | null>;

  findPaymentAuditHistory(paymentId: string): Promise<PaymentAuditHistoryRecord | null>;
}
