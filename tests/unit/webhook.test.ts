import { describe, expect, it } from "vitest";

import {
  calculateWebhookRetryDelay,
  serializeWebhookPayload,
  signWebhookBody,
  verifyWebhookSignature,
  type PaymentStatusChangedWebhookPayload,
} from "../../src/domain/webhook.js";
import { PaymentStatus } from "../../src/generated/prisma/enums.js";

const payload: PaymentStatusChangedWebhookPayload = {
  eventId: "18ca0b18-f236-4ae8-a233-d676dcfc45b7",
  eventType: "payment.status_changed",
  paymentId: "1680dc0d-6e8b-48bf-8fa0-1561c0747d72",
  customerId: "C12345",
  fromStatus: PaymentStatus.PROCESSING,
  toStatus: PaymentStatus.COMPLETED,
  reason: "Payment completed",
  occurredAt: "2026-09-06T12:00:00.000Z",
};

describe("webhook signing", () => {
  it("produces a deterministic HMAC-SHA256 signature", () => {
    const body = serializeWebhookPayload(payload);
    const first = signWebhookBody("a-strong-test-secret", body);
    const second = signWebhookBody("a-strong-test-secret", body);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when the serialized payload changes", () => {
    const original = signWebhookBody(
      "a-strong-test-secret",
      serializeWebhookPayload(payload),
    );
    const changed = signWebhookBody(
      "a-strong-test-secret",
      serializeWebhookPayload({ ...payload, reason: "Different reason" }),
    );

    expect(changed).not.toBe(original);
  });

  it("verifies only with the correct secret", () => {
    const body = serializeWebhookPayload(payload);
    const signature = signWebhookBody("a-strong-test-secret", body);

    expect(verifyWebhookSignature("a-strong-test-secret", body, signature)).toBe(true);
    expect(verifyWebhookSignature("the-wrong-test-secret", body, signature)).toBe(false);
  });
});

describe("webhook retry backoff", () => {
  it.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
  ])("calculates failed attempt %i as %i ms", (attempt, expected) => {
    expect(calculateWebhookRetryDelay(1000, attempt)).toBe(expected);
  });
});
