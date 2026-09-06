import { createHash } from "node:crypto";

import { Prisma } from "../generated/prisma/client.js";

import { InvalidPaymentRequestError } from "./errors.js";

export interface PaymentSubmissionInput {
  customerId: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
  reference: string;
}

export interface NormalizedPaymentSubmission {
  customerId: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
  reference: string;
}

const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/;

function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new InvalidPaymentRequestError(`${field} is required`);
  }

  if (normalized.length > 255) {
    throw new InvalidPaymentRequestError(`${field} must contain at most 255 characters`);
  }

  return normalized;
}

function normalizeAmount(value: string): string {
  if (!AMOUNT_PATTERN.test(value)) {
    throw new InvalidPaymentRequestError(
      "amount must be a positive decimal string with at most 2 decimal places",
    );
  }

  const amount = new Prisma.Decimal(value);

  if (!amount.greaterThan(0)) {
    throw new InvalidPaymentRequestError("amount must be positive");
  }

  const normalized = amount.toFixed(2);
  const integerDigits = normalized.split(".")[0]?.length ?? 0;

  if (integerDigits > 16) {
    throw new InvalidPaymentRequestError("amount exceeds the supported range");
  }

  return normalized;
}

export function normalizePaymentSubmission(
  input: PaymentSubmissionInput,
): NormalizedPaymentSubmission {
  return {
    customerId: normalizeRequiredString(input.customerId, "customerId"),
    sourceAccount: normalizeRequiredString(input.sourceAccount, "sourceAccount"),
    destinationAccount: normalizeRequiredString(
      input.destinationAccount,
      "destinationAccount",
    ),
    amount: normalizeAmount(input.amount),
    reference: normalizeRequiredString(input.reference, "reference"),
  };
}

export function hashPaymentSubmission(input: NormalizedPaymentSubmission): string {
  const canonicalPayload = JSON.stringify({
    amount: input.amount,
    customerId: input.customerId,
    destinationAccount: input.destinationAccount,
    reference: input.reference,
    sourceAccount: input.sourceAccount,
  });

  return createHash("sha256").update(canonicalPayload).digest("hex");
}
