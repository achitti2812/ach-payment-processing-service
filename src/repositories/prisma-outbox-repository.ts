import type { PrismaClient } from "../generated/prisma/client.js";

import type {
  OutboxRepository,
  UnpublishedOutboxEvent,
} from "./outbox-repository.js";

export class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly client: PrismaClient) {}

  async findUnpublished(type: string, limit: number): Promise<UnpublishedOutboxEvent[]> {
    return this.client.outboxEvent.findMany({
      where: {
        type,
        publishedAt: null,
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: {
        id: true,
        aggregateId: true,
      },
    });
  }

  async markPublished(eventId: string, publishedAt: Date): Promise<void> {
    await this.client.outboxEvent.updateMany({
      where: {
        id: eventId,
        publishedAt: null,
      },
      data: {
        publishedAt,
        publishAttempts: { increment: 1 },
        lastError: null,
      },
    });
  }

  async recordPublishFailure(eventId: string, error: string): Promise<void> {
    await this.client.outboxEvent.updateMany({
      where: {
        id: eventId,
        publishedAt: null,
      },
      data: {
        publishAttempts: { increment: 1 },
        lastError: error,
      },
    });
  }
}
