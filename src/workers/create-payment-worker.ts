import { Worker } from "bullmq";
import type Redis from "ioredis";

import {
  PAYMENT_JOB_NAME,
  PAYMENT_QUEUE_NAME,
  type PaymentJobData,
} from "../queues/payment-queue.js";
import type {
  PaymentProcessingOutcome,
  PaymentProcessor,
} from "../services/payment-processor.js";

export type PaymentWorker = Worker<
  PaymentJobData,
  PaymentProcessingOutcome,
  typeof PAYMENT_JOB_NAME
>;

export function createPaymentWorker(
  connection: Redis,
  processor: PaymentProcessor,
  concurrency: number,
  queueName = PAYMENT_QUEUE_NAME,
): PaymentWorker {
  return new Worker<PaymentJobData, PaymentProcessingOutcome, typeof PAYMENT_JOB_NAME>(
    queueName,
    async (job) => processor.processPayment(job.data.paymentId),
    {
      connection,
      concurrency,
    },
  );
}
