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
}
