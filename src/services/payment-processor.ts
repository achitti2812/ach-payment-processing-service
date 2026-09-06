import type { BankClient, BankPaymentResult } from "../bank/bank-client.js";
import { PaymentStatus } from "../generated/prisma/enums.js";
import type { PaymentProcessingRepository } from "../repositories/payment-processing-repository.js";

export type PaymentProcessingOutcome =
  | "COMPLETED"
  | "FAILED"
  | "RETRYING"
  | "SKIPPED"
  | "NOT_FOUND";

export function paymentExecutionKey(paymentId: string): string {
  return `payment-${paymentId}`;
}

export function calculateRetryDelay(
  baseDelayMs: number,
  failedAttemptNumber: number,
): number {
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 1) {
    throw new Error("baseDelayMs must be a positive integer");
  }

  if (!Number.isInteger(failedAttemptNumber) || failedAttemptNumber < 1) {
    throw new Error("failedAttemptNumber must be a positive integer");
  }

  return baseDelayMs * 2 ** (failedAttemptNumber - 1);
}

export interface PaymentProcessorOptions {
  retryBaseDelayMs?: number;
  now?: () => Date;
}

function thrownBankErrorResult(): BankPaymentResult {
  return {
    outcome: "TEMPORARY_FAILURE",
    code: "BANK_UNAVAILABLE",
    message: "The bank request failed temporarily",
  };
}

export class PaymentProcessor {
  private readonly retryBaseDelayMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly repository: PaymentProcessingRepository,
    private readonly bankClient: BankClient,
    options: PaymentProcessorOptions = {},
  ) {
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.now = options.now ?? (() => new Date());
  }

  async processPayment(
    paymentId: string,
    expectedAttemptNumber?: number,
  ): Promise<PaymentProcessingOutcome> {
    const correlationId = paymentExecutionKey(paymentId);
    const claim = await this.repository.claimPaymentAttempt(
      paymentId,
      expectedAttemptNumber,
      correlationId,
      this.now(),
    );

    if (claim.outcome === "NOT_FOUND") {
      return "NOT_FOUND";
    }

    if (claim.outcome === "SKIPPED") {
      return "SKIPPED";
    }

    let bankResult: BankPaymentResult;

    try {
      bankResult = await this.bankClient.executePayment({
        paymentId: claim.payment.id,
        sourceAccount: claim.payment.sourceAccount,
        destinationAccount: claim.payment.destinationAccount,
        amount: claim.payment.amount.toFixed(2),
        reference: claim.payment.reference,
        executionKey: paymentExecutionKey(claim.payment.id),
        attemptNumber: claim.payment.attemptNumber,
      });
    } catch {
      bankResult = thrownBankErrorResult();
    }

    if (bankResult.outcome === "SUCCESS") {
      const transitioned = await this.repository.transitionProcessingPayment({
        paymentId,
        toStatus: PaymentStatus.COMPLETED,
        reason: "Payment completed",
        correlationId,
        bankExecutionId: bankResult.bankExecutionId ?? null,
        failureCode: null,
        failureMessage: null,
        completedAt: this.now(),
        nextRetryAt: null,
      });

      return transitioned ? "COMPLETED" : "SKIPPED";
    }

    if (bankResult.outcome === "PERMANENT_FAILURE") {
      const transitioned = await this.repository.transitionProcessingPayment({
        paymentId,
        toStatus: PaymentStatus.FAILED,
        reason: "Payment permanently failed",
        correlationId,
        bankExecutionId: null,
        failureCode: bankResult.code,
        failureMessage: bankResult.message,
        completedAt: null,
        nextRetryAt: null,
      });

      return transitioned ? "FAILED" : "SKIPPED";
    }

    if (claim.payment.attemptNumber >= claim.payment.maxAttempts) {
      const transitioned = await this.repository.transitionProcessingPayment({
        paymentId,
        toStatus: PaymentStatus.FAILED,
        reason: "Payment failed after retry exhaustion",
        correlationId,
        bankExecutionId: null,
        failureCode: "RETRY_EXHAUSTED",
        failureMessage: `Retry attempts exhausted after ${claim.payment.attemptNumber} attempts: ${bankResult.message}`,
        completedAt: null,
        nextRetryAt: null,
      });

      return transitioned ? "FAILED" : "SKIPPED";
    }

    const delayMs = calculateRetryDelay(
      this.retryBaseDelayMs,
      claim.payment.attemptNumber,
    );
    const nextRetryAt = new Date(this.now().getTime() + delayMs);
    const nextAttemptNumber = claim.payment.attemptNumber + 1;
    const transitioned = await this.repository.transitionProcessingPayment({
      paymentId,
      toStatus: PaymentStatus.RETRYING,
      reason: "Temporary bank failure; retry scheduled",
      correlationId,
      bankExecutionId: null,
      failureCode: bankResult.code,
      failureMessage: bankResult.message,
      completedAt: null,
      nextRetryAt,
      retrySchedule: {
        nextAttemptNumber,
      },
    });

    return transitioned ? "RETRYING" : "SKIPPED";
  }
}
