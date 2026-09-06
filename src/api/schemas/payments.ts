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

export interface PaymentParams {
  paymentId: string;
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

const paymentIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["paymentId"],
  properties: {
    paymentId: { type: "string", format: "uuid" },
  },
} as const;

const paymentDetailsResponseSchema = {
  ...paymentResponseSchema,
  required: [
    ...paymentResponseSchema.required,
    "attemptCount",
    "maxAttempts",
    "failureCode",
    "failureMessage",
    "completedAt",
  ],
  properties: {
    ...paymentResponseSchema.properties,
    attemptCount: { type: "integer", minimum: 0 },
    maxAttempts: { type: "integer", minimum: 1 },
    failureCode: { type: "string", nullable: true },
    failureMessage: { type: "string", nullable: true },
    completedAt: { type: "string", format: "date-time", nullable: true },
  },
} as const;

const paymentEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "sequenceNumber",
    "fromStatus",
    "toStatus",
    "reason",
    "actor",
    "correlationId",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    sequenceNumber: { type: "integer", minimum: 1 },
    fromStatus: {
      type: "string",
      enum: Object.values(PaymentStatus),
      nullable: true,
    },
    toStatus: { type: "string", enum: Object.values(PaymentStatus) },
    reason: { type: "string" },
    actor: { type: "string" },
    correlationId: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const paymentAuditHistoryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["paymentId", "events"],
  properties: {
    paymentId: { type: "string", format: "uuid" },
    events: {
      type: "array",
      items: paymentEventResponseSchema,
    },
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

export const getPaymentSchema = {
  tags: ["payments"],
  summary: "Retrieve a payment by ID",
  params: paymentIdParamsSchema,
  response: {
    200: paymentDetailsResponseSchema,
    400: errorResponseSchema,
    404: errorResponseSchema,
  },
} as const;

export const getPaymentEventsSchema = {
  tags: ["payments"],
  summary: "Retrieve a payment's audit history",
  params: paymentIdParamsSchema,
  response: {
    200: paymentAuditHistoryResponseSchema,
    400: errorResponseSchema,
    404: errorResponseSchema,
  },
} as const;
