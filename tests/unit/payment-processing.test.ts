import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SimulatedBankClient } from "../../src/bank/simulated-bank-client.js";
import { InvalidPaymentStateTransitionError } from "../../src/domain/errors.js";
import {
  assertPaymentTransition,
  isPaymentTransitionAllowed,
} from "../../src/domain/payment-state-machine.js";
import { PaymentStatus } from "../../src/generated/prisma/enums.js";
import {
  calculateRetryDelay,
  paymentExecutionKey,
} from "../../src/services/payment-processor.js";

describe("payment state machine", () => {
  it.each([
    [PaymentStatus.PENDING, PaymentStatus.PROCESSING],
    [PaymentStatus.PROCESSING, PaymentStatus.COMPLETED],
    [PaymentStatus.PROCESSING, PaymentStatus.FAILED],
    [PaymentStatus.PROCESSING, PaymentStatus.RETRYING],
    [PaymentStatus.RETRYING, PaymentStatus.PROCESSING],
  ])("allows %s -> %s", (from, to) => {
    expect(isPaymentTransitionAllowed(from, to)).toBe(true);
    expect(() => assertPaymentTransition(from, to)).not.toThrow();
  });

  it("rejects an invalid state transition", () => {
    expect(() =>
      assertPaymentTransition(PaymentStatus.PENDING, PaymentStatus.COMPLETED),
    ).toThrow(InvalidPaymentStateTransitionError);
  });
});

describe("simulated bank adapter", () => {
  const bank = new SimulatedBankClient();

  function request(
    reference: string,
    attemptNumber = 1,
    executionKey = paymentExecutionKey(randomUUID()),
  ) {
    return {
      paymentId: randomUUID(),
      sourceAccount: "VA10001",
      destinationAccount: "EXT98765",
      amount: "250.00",
      reference,
      executionKey,
      attemptNumber,
    };
  }

  it("returns deterministic outcomes from the reference", async () => {
    await expect(bank.executePayment(request("PAYMENT-SUCCESS"))).resolves.toMatchObject({
      outcome: "SUCCESS",
    });
    await expect(bank.executePayment(request("PAYMENT-PERM_FAIL"))).resolves.toMatchObject({
      outcome: "PERMANENT_FAILURE",
      code: "BANK_PAYMENT_REJECTED",
    });
    await expect(bank.executePayment(request("PAYMENT-TEMP_FAIL"))).resolves.toMatchObject({
      outcome: "TEMPORARY_FAILURE",
      code: "BANK_TEMPORARY_UNAVAILABLE",
    });
  });

  it("returns the same bank execution ID for the same execution key", async () => {
    const executionKey = paymentExecutionKey(randomUUID());
    const first = await bank.executePayment(request("SUCCESS-1", 1, executionKey));
    const second = await bank.executePayment(request("SUCCESS-2", 2, executionKey));

    expect(first).toEqual(second);
    expect(paymentExecutionKey("payment-id")).toBe(paymentExecutionKey("payment-id"));
  });

  it("supports deterministic eventual success after temporary failures", async () => {
    await expect(bank.executePayment(request("TEMP_FAIL_ONCE", 1))).resolves.toMatchObject({
      outcome: "TEMPORARY_FAILURE",
    });
    await expect(bank.executePayment(request("TEMP_FAIL_ONCE", 2))).resolves.toMatchObject({
      outcome: "SUCCESS",
    });
    await expect(bank.executePayment(request("TEMP_FAIL_TWICE", 2))).resolves.toMatchObject({
      outcome: "TEMPORARY_FAILURE",
    });
    await expect(bank.executePayment(request("TEMP_FAIL_TWICE", 3))).resolves.toMatchObject({
      outcome: "SUCCESS",
    });
  });
});

describe("retry backoff", () => {
  it.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
  ])("calculates attempt %i as %i ms", (attemptNumber, expectedDelay) => {
    expect(calculateRetryDelay(1000, attemptNumber)).toBe(expectedDelay);
  });

  it("rejects invalid inputs", () => {
    expect(() => calculateRetryDelay(0, 1)).toThrow();
    expect(() => calculateRetryDelay(1000, 0)).toThrow();
  });
});
