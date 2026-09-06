import { Queue, type JobsOptions } from "bullmq";
import type Redis from "ioredis";

export const PAYMENT_QUEUE_NAME = "payment-processing";
export const PAYMENT_JOB_NAME = "process-payment";

export interface PaymentJobData {
  paymentId: string;
  attemptNumber?: number;
}

export type PaymentQueue = Queue<PaymentJobData, void, typeof PAYMENT_JOB_NAME>;

const paymentJobOptions: JobsOptions = {
  removeOnComplete: false,
  removeOnFail: false,
};

export function createPaymentQueue(
  connection: Redis,
  queueName = PAYMENT_QUEUE_NAME,
): PaymentQueue {
  return new Queue<PaymentJobData, void, typeof PAYMENT_JOB_NAME>(queueName, {
    connection,
    defaultJobOptions: paymentJobOptions,
  });
}

export interface PaymentJobPublisher {
  publish(paymentId: string): Promise<void>;
  publishRetry?(
    paymentId: string,
    nextAttemptNumber: number,
    delayMs: number,
  ): Promise<void>;
}

export function paymentRetryJobId(
  paymentId: string,
  attemptNumber: number,
): string {
  return `${paymentId}-attempt-${attemptNumber}`;
}

export class BullMqPaymentJobPublisher implements PaymentJobPublisher {
  constructor(private readonly queue: PaymentQueue) {}

  async publish(paymentId: string): Promise<void> {
    await this.queue.add(
      PAYMENT_JOB_NAME,
      { paymentId },
      {
        jobId: paymentId,
      },
    );
  }

  async publishRetry(
    paymentId: string,
    nextAttemptNumber: number,
    delayMs: number,
  ): Promise<void> {
    await this.queue.add(
      PAYMENT_JOB_NAME,
      { paymentId, attemptNumber: nextAttemptNumber },
      {
        jobId: paymentRetryJobId(paymentId, nextAttemptNumber),
        delay: Math.max(0, delayMs),
      },
    );
  }
}
