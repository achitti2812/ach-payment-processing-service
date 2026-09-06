import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { createRedisConnection } from "../config/redis.js";
import { WEBHOOK_QUEUE_NAME } from "../queues/webhook-queue.js";
import { PrismaWebhookDeliveryRepository } from "../repositories/prisma-webhook-delivery-repository.js";
import { WebhookDeliveryProcessor } from "../services/webhook-delivery-processor.js";
import { FetchWebhookHttpClient } from "../webhooks/webhook-http-client.js";
import { createWebhookWorker } from "./create-webhook-worker.js";

const redis = createRedisConnection("worker");
const processor = new WebhookDeliveryProcessor(
  new PrismaWebhookDeliveryRepository(prisma),
  new FetchWebhookHttpClient(),
  {
    retryBaseDelayMs: env.WEBHOOK_RETRY_BASE_DELAY_MS,
    maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    requestTimeoutMs: env.WEBHOOK_REQUEST_TIMEOUT_MS,
  },
);
const worker = createWebhookWorker(
  redis,
  processor,
  env.WEBHOOK_WORKER_CONCURRENCY,
);

worker.on("completed", (job, result) => {
  console.log(`Webhook job ${job.id} finished with ${result}`);
});
worker.on("failed", (job, error) => {
  console.error(`Webhook job ${job?.id ?? "unknown"} failed`, error);
});
worker.on("error", (error) => {
  console.error("Webhook worker error", error);
});

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await worker.close();
  await redis.quit();
  await prisma.$disconnect();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await worker.waitUntilReady();
console.log(
  `Webhook worker listening on ${WEBHOOK_QUEUE_NAME} with concurrency ${env.WEBHOOK_WORKER_CONCURRENCY}`,
);
