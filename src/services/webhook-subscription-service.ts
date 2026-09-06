import {
  InvalidWebhookSubscriptionError,
  WebhookSubscriptionNotFoundError,
} from "../domain/errors.js";
import type {
  WebhookSubscriptionRecord,
  WebhookSubscriptionRepository,
} from "../repositories/webhook-subscription-repository.js";

export interface CreateWebhookSubscriptionInput {
  customerId: string;
  url: string;
  signingSecret: string;
}

export interface WebhookSubscriptionResponse {
  id: string;
  customerId: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function requiredString(value: string, name: string, maxLength: number): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new InvalidWebhookSubscriptionError(`${name} is required`);
  }

  if (normalized.length > maxLength) {
    throw new InvalidWebhookSubscriptionError(
      `${name} must contain at most ${maxLength} characters`,
    );
  }

  return normalized;
}

function normalizedWebhookUrl(value: string, nodeEnv: string): string {
  const normalized = requiredString(value, "url", 2048);
  let url: URL;

  try {
    url = new URL(normalized);
  } catch {
    throw new InvalidWebhookSubscriptionError("url must be a valid absolute URL");
  }

  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const allowedLocalHttp = nodeEnv !== "production" && url.protocol === "http:" && isLoopback;

  if (url.protocol !== "https:" && !allowedLocalHttp) {
    throw new InvalidWebhookSubscriptionError(
      "url must use HTTPS; loopback HTTP is allowed outside production",
    );
  }

  if (url.username || url.password) {
    throw new InvalidWebhookSubscriptionError("url must not contain credentials");
  }

  return url.toString();
}

function response(record: WebhookSubscriptionRecord): WebhookSubscriptionResponse {
  return {
    id: record.id,
    customerId: record.customerId,
    url: record.url,
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export class WebhookSubscriptionService {
  constructor(
    private readonly repository: WebhookSubscriptionRepository,
    private readonly nodeEnv: string,
  ) {}

  async create(
    input: CreateWebhookSubscriptionInput,
  ): Promise<WebhookSubscriptionResponse> {
    const customerId = requiredString(input.customerId, "customerId", 255);
    const signingSecret = requiredString(input.signingSecret, "signingSecret", 1024);

    if (signingSecret.length < 16) {
      throw new InvalidWebhookSubscriptionError(
        "signingSecret must contain at least 16 characters",
      );
    }

    return response(
      await this.repository.create({
        customerId,
        url: normalizedWebhookUrl(input.url, this.nodeEnv),
        signingSecret,
      }),
    );
  }

  async listEnabled(customerId: string): Promise<WebhookSubscriptionResponse[]> {
    const normalizedCustomerId = requiredString(customerId, "customerId", 255);
    return (await this.repository.findEnabledByCustomer(normalizedCustomerId)).map(response);
  }

  async setEnabled(
    subscriptionId: string,
    enabled: boolean,
  ): Promise<WebhookSubscriptionResponse> {
    const subscription = await this.repository.setEnabled(subscriptionId, enabled);

    if (!subscription) {
      throw new WebhookSubscriptionNotFoundError();
    }

    return response(subscription);
  }
}
