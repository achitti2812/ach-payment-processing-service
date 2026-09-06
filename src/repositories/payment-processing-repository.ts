import type { PaymentStatus, Prisma } from "../generated/prisma/client.js";

export interface PaymentForProcessing {
  id: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: Prisma.Decimal;
  reference: string;
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
}

export interface PaymentProcessingRepository {
  claimPendingPayment(paymentId: string, correlationId: string): Promise<PaymentClaimResult>;
  transitionProcessingPayment(params: ProcessingTransitionParams): Promise<boolean>;
}
