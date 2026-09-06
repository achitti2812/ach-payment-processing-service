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

function thrownBankErrorResult(): BankPaymentResult {
  return {
    outcome: "TEMPORARY_FAILURE",
    code: "BANK_UNAVAILABLE",
    message: "The bank request failed temporarily",
  };
}

export class PaymentProcessor {
  constructor(
    private readonly repository: PaymentProcessingRepository,
    private readonly bankClient: BankClient,
  ) {}

  async processPayment(paymentId: string): Promise<PaymentProcessingOutcome> {
    const correlationId = paymentExecutionKey(paymentId);
    const claim = await this.repository.claimPendingPayment(paymentId, correlationId);

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
        completedAt: new Date(),
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
      });

      return transitioned ? "FAILED" : "SKIPPED";
    }

    const transitioned = await this.repository.transitionProcessingPayment({
      paymentId,
      toStatus: PaymentStatus.RETRYING,
      reason: "Payment temporarily failed",
      correlationId,
      bankExecutionId: null,
      failureCode: bankResult.code,
      failureMessage: bankResult.message,
      completedAt: null,
    });

    return transitioned ? "RETRYING" : "SKIPPED";
  }
}
