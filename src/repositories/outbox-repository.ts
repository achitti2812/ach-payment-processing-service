export interface UnpublishedOutboxEvent {
  id: string;
  aggregateId: string;
}

export interface OutboxRepository {
  findUnpublished(type: string, limit: number): Promise<UnpublishedOutboxEvent[]>;
  markPublished(eventId: string, publishedAt: Date): Promise<void>;
  recordPublishFailure(eventId: string, error: string): Promise<void>;
}
