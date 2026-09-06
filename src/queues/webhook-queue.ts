import { Queue, type JobsOptions } from "bullmq";
import type Redis from "ioredis";

export const WEBHOOK_QUEUE_NAME = "webhook-delivery";
export const WEBHOOK_JOB_NAME = "deliver-webhook";

export interface WebhookJobData {
  webhookDeliveryId: string;
  attemptNumber: number;
}

export type WebhookQueue = Queue<WebhookJobData, void, typeof WEBHOOK_JOB_NAME>;

const webhookJobOptions: JobsOptions = {
  removeOnComplete: false,
  removeOnFail: false,
};

export function webhookDeliveryJobId(
  webhookDeliveryId: string,
  attemptNumber: number,
): string {
  return `${webhookDeliveryId}-attempt-${attemptNumber}`;
}

export function createWebhookQueue(
  connection: Redis,
  queueName = WEBHOOK_QUEUE_NAME,
): WebhookQueue {
  return new Queue<WebhookJobData, void, typeof WEBHOOK_JOB_NAME>(queueName, {
    connection,
    defaultJobOptions: webhookJobOptions,
  });
}

export interface WebhookJobPublisher {
  publish(
    webhookDeliveryId: string,
    attemptNumber: number,
    delayMs: number,
  ): Promise<void>;
}

export class BullMqWebhookJobPublisher implements WebhookJobPublisher {
  constructor(private readonly queue: WebhookQueue) {}

  async publish(
    webhookDeliveryId: string,
    attemptNumber: number,
    delayMs: number,
  ): Promise<void> {
    await this.queue.add(
      WEBHOOK_JOB_NAME,
      { webhookDeliveryId, attemptNumber },
      {
        jobId: webhookDeliveryJobId(webhookDeliveryId, attemptNumber),
        delay: Math.max(0, delayMs),
      },
    );
  }
}
