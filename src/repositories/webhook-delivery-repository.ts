import type {
  PaymentStatus,
  WebhookDeliveryStatus,
} from "../generated/prisma/client.js";

export interface ClaimedWebhookDelivery {
  id: string;
  attemptNumber: number;
  url: string;
  signingSecret: string;
  paymentEvent: {
    id: string;
    paymentId: string;
    customerId: string;
    fromStatus: PaymentStatus | null;
    toStatus: PaymentStatus;
    reason: string;
    createdAt: Date;
  };
}

export type WebhookDeliveryClaimResult =
  | { outcome: "CLAIMED"; delivery: ClaimedWebhookDelivery }
  | { outcome: "DISABLED" }
  | { outcome: "NOT_DUE"; nextAttemptAt: Date }
  | { outcome: "SKIPPED"; status: WebhookDeliveryStatus }
  | { outcome: "NOT_FOUND" };

export interface WebhookDeliveryFailureParams {
  webhookDeliveryId: string;
  attemptNumber: number;
  status: WebhookDeliveryStatus;
  nextAttemptAt: Date | null;
  lastHttpStatus: number | null;
  lastError: string;
  nextAttemptNumber?: number;
}

export interface WebhookDeliveryRepository {
  claimAttempt(
    webhookDeliveryId: string,
    expectedAttemptNumber: number,
    maxAttempts: number,
    claimedAt: Date,
  ): Promise<WebhookDeliveryClaimResult>;
  markDelivered(
    webhookDeliveryId: string,
    attemptNumber: number,
    httpStatus: number,
    deliveredAt: Date,
  ): Promise<boolean>;
  recordFailure(params: WebhookDeliveryFailureParams): Promise<boolean>;
}
