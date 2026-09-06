import { createHmac, timingSafeEqual } from "node:crypto";

import type { PaymentStatus } from "../generated/prisma/client.js";

export const WEBHOOK_EVENT_TYPE = "payment.status_changed";

export interface PaymentStatusChangedWebhookPayload {
  eventId: string;
  eventType: typeof WEBHOOK_EVENT_TYPE;
  paymentId: string;
  customerId: string;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus;
  reason: string;
  occurredAt: string;
}

export function serializeWebhookPayload(
  payload: PaymentStatusChangedWebhookPayload,
): string {
  return JSON.stringify(payload);
}

export function signWebhookBody(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signWebhookBody(secret, rawBody), "hex");
  const received = Buffer.from(signature, "hex");

  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function calculateWebhookRetryDelay(
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
