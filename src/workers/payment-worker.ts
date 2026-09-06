import { SimulatedBankClient } from "../bank/simulated-bank-client.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { createRedisConnection } from "../config/redis.js";
import { PAYMENT_QUEUE_NAME } from "../queues/payment-queue.js";
import { PrismaPaymentProcessingRepository } from "../repositories/prisma-payment-processing-repository.js";
import { PaymentProcessor } from "../services/payment-processor.js";
import { createPaymentWorker } from "./create-payment-worker.js";

const redis = createRedisConnection("worker");
const processor = new PaymentProcessor(
  new PrismaPaymentProcessingRepository(prisma),
  new SimulatedBankClient(),
);

const worker = createPaymentWorker(
  redis,
  processor,
  env.PAYMENT_WORKER_CONCURRENCY,
);

worker.on("completed", (job, result) => {
  console.log(`Payment job ${job.id} finished with ${result}`);
});

worker.on("failed", (job, error) => {
  console.error(`Payment job ${job?.id ?? "unknown"} failed`, error);
});

worker.on("error", (error) => {
  console.error("Payment worker error", error);
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

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

await worker.waitUntilReady();
console.log(
  `Payment worker listening on ${PAYMENT_QUEUE_NAME} with concurrency ${env.PAYMENT_WORKER_CONCURRENCY}`,
);
