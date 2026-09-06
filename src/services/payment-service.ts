import type { PaymentStatus } from "../generated/prisma/client.js";

import {
  IdempotencyConflictError,
  IdempotencyKeyAlreadyExistsError,
  InvalidPaymentRequestError,
} from "../domain/errors.js";
import {
  hashPaymentSubmission,
  normalizePaymentSubmission,
  type PaymentSubmissionInput,
} from "../domain/payment.js";
import type {
  IdempotentPaymentRecord,
  PaymentRecord,
  PaymentRepository,
} from "../repositories/payment-repository.js";

export const PAYMENT_PROCESS_REQUESTED = "PAYMENT_PROCESS_REQUESTED";

export interface PaymentResponse {
  id: string;
  customerId: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
  reference: string;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentSubmissionResult {
  payment: PaymentResponse;
  replayed: boolean;
}

function toPaymentResponse(payment: PaymentRecord): PaymentResponse {
  return {
    id: payment.id,
    customerId: payment.customerId,
    sourceAccount: payment.sourceAccount,
    destinationAccount: payment.destinationAccount,
    amount: payment.amount.toFixed(2),
    reference: payment.reference,
    status: payment.status,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

function resolveExistingPayment(
  existing: IdempotentPaymentRecord,
  requestHash: string,
): PaymentSubmissionResult {
  if (existing.requestHash !== requestHash) {
    throw new IdempotencyConflictError();
  }

  return {
    payment: toPaymentResponse(existing.payment),
    replayed: true,
  };
}

function normalizeHeader(value: string, name: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new InvalidPaymentRequestError(`${name} is required`);
  }

  if (normalized.length > 255) {
    throw new InvalidPaymentRequestError(`${name} must contain at most 255 characters`);
  }

  return normalized;
}

export class PaymentService {
  constructor(private readonly repository: PaymentRepository) {}

  async submitPayment(
    input: PaymentSubmissionInput,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<PaymentSubmissionResult> {
    const payment = normalizePaymentSubmission(input);
    const normalizedIdempotencyKey = normalizeHeader(
      idempotencyKey,
      "Idempotency-Key",
    );
    const normalizedCorrelationId = normalizeHeader(correlationId, "X-Correlation-Id");
    const requestHash = hashPaymentSubmission(payment);

    const existing = await this.repository.findByIdempotencyKey(
      payment.customerId,
      normalizedIdempotencyKey,
    );

    if (existing) {
      return resolveExistingPayment(existing, requestHash);
    }

    try {
      const created = await this.repository.createPaymentSubmission({
        payment,
        idempotencyKey: normalizedIdempotencyKey,
        requestHash,
        correlationId: normalizedCorrelationId,
        outboxType: PAYMENT_PROCESS_REQUESTED,
      });

      return {
        payment: toPaymentResponse(created),
        replayed: false,
      };
    } catch (error) {
      if (!(error instanceof IdempotencyKeyAlreadyExistsError)) {
        throw error;
      }

      const concurrentResult = await this.repository.findByIdempotencyKey(
        payment.customerId,
        normalizedIdempotencyKey,
      );

      if (!concurrentResult) {
        throw error;
      }

      return resolveExistingPayment(concurrentResult, requestHash);
    }
  }
}
