import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

import type {
  CreateWebhookSubscriptionParams,
  WebhookSubscriptionRecord,
  WebhookSubscriptionRepository,
} from "./webhook-subscription-repository.js";

const subscriptionSelect = {
  id: true,
  customerId: true,
  url: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WebhookSubscriptionSelect;

export class PrismaWebhookSubscriptionRepository
  implements WebhookSubscriptionRepository
{
  constructor(private readonly client: PrismaClient) {}

  async create(
    params: CreateWebhookSubscriptionParams,
  ): Promise<WebhookSubscriptionRecord> {
    return this.client.webhookSubscription.create({
      data: params,
      select: subscriptionSelect,
    });
  }

  async findEnabledByCustomer(
    customerId: string,
  ): Promise<WebhookSubscriptionRecord[]> {
    return this.client.webhookSubscription.findMany({
      where: { customerId, enabled: true },
      orderBy: { createdAt: "asc" },
      select: subscriptionSelect,
    });
  }

  async setEnabled(
    subscriptionId: string,
    enabled: boolean,
  ): Promise<WebhookSubscriptionRecord | null> {
    const updated = await this.client.webhookSubscription.updateMany({
      where: { id: subscriptionId },
      data: { enabled },
    });

    if (updated.count === 0) {
      return null;
    }

    return this.client.webhookSubscription.findUnique({
      where: { id: subscriptionId },
      select: subscriptionSelect,
    });
  }
}
