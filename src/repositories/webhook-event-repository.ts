export interface WebhookEventMaterializationResult {
  handled: boolean;
  deliveryCount: number;
}

export interface WebhookEventRepository {
  materializeDeliveries(
    outboxEventId: string,
    paymentEventId: string,
    publishedAt: Date,
  ): Promise<WebhookEventMaterializationResult>;
}
