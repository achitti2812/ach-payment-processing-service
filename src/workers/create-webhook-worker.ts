import { DelayedError, Worker } from "bullmq";
import type Redis from "ioredis";

import {
  WEBHOOK_JOB_NAME,
  WEBHOOK_QUEUE_NAME,
  type WebhookJobData,
} from "../queues/webhook-queue.js";
import type {
  WebhookDeliveryOutcome,
  WebhookDeliveryProcessor,
} from "../services/webhook-delivery-processor.js";

export type WebhookWorker = Worker<
  WebhookJobData,
  WebhookDeliveryOutcome,
  typeof WEBHOOK_JOB_NAME
>;

export function createWebhookWorker(
  connection: Redis,
  processor: WebhookDeliveryProcessor,
  concurrency: number,
  queueName = WEBHOOK_QUEUE_NAME,
): WebhookWorker {
  return new Worker<WebhookJobData, WebhookDeliveryOutcome, typeof WEBHOOK_JOB_NAME>(
    queueName,
    async (job, token) => {
      const result = await processor.process(
        job.data.webhookDeliveryId,
        job.data.attemptNumber,
      );

      if (typeof result !== "string") {
        await job.moveToDelayed(result.nextAttemptAt.getTime(), token);
        throw new DelayedError();
      }

      return result;
    },
    { connection, concurrency },
  );
}
