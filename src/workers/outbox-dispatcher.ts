import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { createRedisConnection } from "../config/redis.js";
import {
  BullMqPaymentJobPublisher,
  createPaymentQueue,
} from "../queues/payment-queue.js";
import { PrismaOutboxRepository } from "../repositories/prisma-outbox-repository.js";
import { OutboxDispatcher } from "../services/outbox-dispatcher.js";

const redis = createRedisConnection("producer");
const queue = createPaymentQueue(redis);
const repository = new PrismaOutboxRepository(prisma);
const dispatcher = new OutboxDispatcher(
  repository,
  new BullMqPaymentJobPublisher(queue),
);

let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

console.log("Outbox dispatcher started");

try {
  while (!stopping) {
    try {
      const summary = await dispatcher.dispatchBatch(env.OUTBOX_BATCH_SIZE);

      if (summary.found === 0 || summary.failed > 0) {
        await wait(env.OUTBOX_POLL_INTERVAL_MS);
      }
    } catch (error) {
      console.error("Outbox dispatch batch failed", error);
      await wait(env.OUTBOX_POLL_INTERVAL_MS);
    }
  }
} finally {
  await queue.close();
  await redis.quit();
  await prisma.$disconnect();
}
