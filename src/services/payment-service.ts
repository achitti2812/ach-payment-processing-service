import type { PaymentStatus } from "../generated/prisma/client.js";

import {
  IdempotencyConflictError,
  IdempotencyKeyAlreadyExistsError,
  InvalidPaymentRequestError,
  PaymentNotFoundError,
} from "../domain/errors.js";
import {
  hashPaymentSubmission,
  normalizePaymentSubmission,
  type PaymentSubmissionInput,
} from "../domain/payment.js";
import type {
  IdempotentPaymentRecord,
  PaymentAuditHistoryRecord,
  PaymentDetailsRecord,
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

export interface PaymentDetailsResponse extends PaymentResponse {
  attemptCount: number;
  maxAttempts: number;
  failureCode: string | null;
  failureMessage: string | null;
  completedAt: string | null;
}

export interface PaymentEventResponse {
  id: string;
  sequenceNumber: number;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus;
  reason: string;
  actor: string;
  correlationId: string;
  createdAt: string;
}

export interface PaymentAuditHistoryResponse {
  paymentId: string;
  events: PaymentEventResponse[];
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

function toPaymentDetailsResponse(payment: PaymentDetailsRecord): PaymentDetailsResponse {
  return {
    ...toPaymentResponse(payment),
    attemptCount: payment.attemptCount,
    maxAttempts: payment.maxAttempts,
    failureCode: payment.failureCode,
    failureMessage: payment.failureMessage,
    completedAt: payment.completedAt?.toISOString() ?? null,
  };
}

function toPaymentAuditHistoryResponse(
  payment: PaymentAuditHistoryRecord,
): PaymentAuditHistoryResponse {
  return {
    paymentId: payment.id,
    events: payment.events.map((event) => ({
      id: event.id,
      sequenceNumber: event.sequenceNumber,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      reason: event.reason,
      actor: event.actor,
      correlationId: event.correlationId,
      createdAt: event.createdAt.toISOString(),
    })),
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

  async getPayment(paymentId: string): Promise<PaymentDetailsResponse> {
    const payment = await this.repository.findPaymentById(paymentId);

    if (!payment) {
      throw new PaymentNotFoundError();
    }

    return toPaymentDetailsResponse(payment);
  }

  async getPaymentAuditHistory(paymentId: string): Promise<PaymentAuditHistoryResponse> {
    const payment = await this.repository.findPaymentAuditHistory(paymentId);

    if (!payment) {
      throw new PaymentNotFoundError();
    }

    return toPaymentAuditHistoryResponse(payment);
  }

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
