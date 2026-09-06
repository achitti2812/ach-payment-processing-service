import { PaymentStatus } from "../../generated/prisma/enums.js";

export interface CreateWebhookSubscriptionBody {
  customerId: string;
  url: string;
  signingSecret: string;
}

export interface WebhookCustomerParams {
  customerId: string;
}

export interface WebhookSubscriptionParams {
  subscriptionId: string;
}

export interface UpdateWebhookSubscriptionBody {
  enabled: boolean;
}

const errorResponseSchema = {
  type: "object",
  required: ["statusCode", "error", "message"],
  properties: {
    statusCode: { type: "integer" },
    error: { type: "string" },
    message: { type: "string" },
  },
} as const;

const subscriptionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "customerId", "url", "enabled", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    customerId: { type: "string" },
    url: { type: "string", format: "uri" },
    enabled: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const webhookStatusChangedPayloadSchema = {
  type: "object" as const,
  additionalProperties: false,
  description:
    "Outgoing webhook body. X-Webhook-Signature is the hexadecimal HMAC-SHA256 of the exact UTF-8 JSON request body.",
  required: [
    "eventId",
    "eventType",
    "paymentId",
    "customerId",
    "fromStatus",
    "toStatus",
    "reason",
    "occurredAt",
  ],
  properties: {
    eventId: { type: "string" as const, format: "uuid" },
    eventType: { type: "string" as const, enum: ["payment.status_changed"] },
    paymentId: { type: "string" as const, format: "uuid" },
    customerId: { type: "string" as const },
    fromStatus: {
      type: "string" as const,
      enum: Object.values(PaymentStatus),
      nullable: true,
    },
    toStatus: { type: "string" as const, enum: Object.values(PaymentStatus) },
    reason: { type: "string" as const },
    occurredAt: { type: "string" as const, format: "date-time" },
  },
};

export const createWebhookSubscriptionSchema = {
  tags: ["webhooks"],
  summary: "Create a signed webhook subscription",
  description:
    "The signing secret is write-only. Outgoing requests include X-Webhook-Signature, X-Webhook-Event-Id, and X-Webhook-Timestamp headers.",
  body: {
    type: "object",
    additionalProperties: false,
    required: ["customerId", "url", "signingSecret"],
    properties: {
      customerId: { type: "string", minLength: 1, maxLength: 255, pattern: "\\S" },
      url: { type: "string", format: "uri", maxLength: 2048 },
      signingSecret: {
        type: "string",
        minLength: 16,
        maxLength: 1024,
        writeOnly: true,
      },
    },
  },
  response: {
    201: subscriptionResponseSchema,
    400: errorResponseSchema,
  },
} as const;

export const listWebhookSubscriptionsSchema = {
  tags: ["webhooks"],
  summary: "List enabled webhook subscriptions for a customer",
  params: {
    type: "object",
    additionalProperties: false,
    required: ["customerId"],
    properties: {
      customerId: { type: "string", minLength: 1, maxLength: 255 },
    },
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["subscriptions"],
      properties: {
        subscriptions: { type: "array", items: subscriptionResponseSchema },
      },
    },
    400: errorResponseSchema,
  },
} as const;

export const updateWebhookSubscriptionSchema = {
  tags: ["webhooks"],
  summary: "Enable or disable a webhook subscription",
  params: {
    type: "object",
    additionalProperties: false,
    required: ["subscriptionId"],
    properties: {
      subscriptionId: { type: "string", format: "uuid" },
    },
  },
  body: {
    type: "object",
    additionalProperties: false,
    required: ["enabled"],
    properties: { enabled: { type: "boolean" } },
  },
  response: {
    200: subscriptionResponseSchema,
    400: errorResponseSchema,
    404: errorResponseSchema,
  },
} as const;
