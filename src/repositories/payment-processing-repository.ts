import type { PaymentStatus, Prisma } from "../generated/prisma/client.js";

export interface PaymentForProcessing {
  id: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: Prisma.Decimal;
  reference: string;
  attemptNumber: number;
  maxAttempts: number;
}

export type PaymentClaimResult =
  | {
      outcome: "CLAIMED";
      payment: PaymentForProcessing;
    }
  | {
      outcome: "SKIPPED";
      status: PaymentStatus;
    }
  | {
      outcome: "NOT_FOUND";
    };

export interface ProcessingTransitionParams {
  paymentId: string;
  toStatus: PaymentStatus;
  reason: string;
  correlationId: string;
  bankExecutionId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  completedAt: Date | null;
  nextRetryAt: Date | null;
  retrySchedule?: {
    nextAttemptNumber: number;
  };
}

export interface PaymentProcessingRepository {
  claimPaymentAttempt(
    paymentId: string,
    expectedAttemptNumber: number | undefined,
    correlationId: string,
    claimedAt: Date,
  ): Promise<PaymentClaimResult>;
  transitionProcessingPayment(params: ProcessingTransitionParams): Promise<boolean>;
}
