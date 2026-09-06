import { PaymentStatus } from "../../generated/prisma/enums.js";

export interface SubmitPaymentBody {
  customerId: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
  reference: string;
}

export interface SubmitPaymentHeaders {
  "idempotency-key": string;
  "x-correlation-id"?: string;
}

const requiredStringSchema = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  pattern: "\\S",
} as const;

const paymentResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "customerId",
    "sourceAccount",
    "destinationAccount",
    "amount",
    "reference",
    "status",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    customerId: { type: "string" },
    sourceAccount: { type: "string" },
    destinationAccount: { type: "string" },
    amount: { type: "string", pattern: "^\\d+\\.\\d{2}$" },
    reference: { type: "string" },
    status: { type: "string", enum: Object.values(PaymentStatus) },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["statusCode", "error", "message"],
  properties: {
    statusCode: { type: "integer" },
    error: { type: "string" },
    message: { type: "string" },
  },
} as const;

export const submitPaymentSchema = {
  tags: ["payments"],
  summary: "Submit an ACH payment for asynchronous processing",
  headers: {
    type: "object",
    required: ["idempotency-key"],
    properties: {
      "idempotency-key": requiredStringSchema,
      "x-correlation-id": requiredStringSchema,
    },
  },
  body: {
    type: "object",
    additionalProperties: false,
    required: [
      "customerId",
      "sourceAccount",
      "destinationAccount",
      "amount",
      "reference",
    ],
    properties: {
      customerId: requiredStringSchema,
      sourceAccount: requiredStringSchema,
      destinationAccount: requiredStringSchema,
      amount: {
        type: "string",
        pattern: "^\\d+(?:\\.\\d{1,2})?$",
      },
      reference: requiredStringSchema,
    },
  },
  response: {
    200: paymentResponseSchema,
    202: paymentResponseSchema,
    400: errorResponseSchema,
    409: errorResponseSchema,
  },
} as const;
