export interface WebhookSubscriptionRecord {
  id: string;
  customerId: string;
  url: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWebhookSubscriptionParams {
  customerId: string;
  url: string;
  signingSecret: string;
}

export interface WebhookSubscriptionRepository {
  create(
    params: CreateWebhookSubscriptionParams,
  ): Promise<WebhookSubscriptionRecord>;
  findEnabledByCustomer(customerId: string): Promise<WebhookSubscriptionRecord[]>;
  setEnabled(
    subscriptionId: string,
    enabled: boolean,
  ): Promise<WebhookSubscriptionRecord | null>;
}
