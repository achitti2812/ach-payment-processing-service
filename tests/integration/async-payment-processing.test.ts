import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  BankClient,
  BankPaymentRequest,
  BankPaymentResult,
} from "../../src/bank/bank-client.js";
import { SimulatedBankClient } from "../../src/bank/simulated-bank-client.js";
import { prisma } from "../../src/config/prisma.js";
import { createRedisConnection } from "../../src/config/redis.js";
import { PaymentStatus } from "../../src/generated/prisma/enums.js";
import {
  BullMqPaymentJobPublisher,
  PAYMENT_JOB_NAME,
  PAYMENT_QUEUE_NAME,
  createPaymentQueue,
} from "../../src/queues/payment-queue.js";
import { PrismaOutboxRepository } from "../../src/repositories/prisma-outbox-repository.js";
import { PrismaPaymentProcessingRepository } from "../../src/repositories/prisma-payment-processing-repository.js";
import { OutboxDispatcher } from "../../src/services/outbox-dispatcher.js";
import {
  PAYMENT_PROCESS_REQUESTED,
} from "../../src/services/payment-service.js";
import {
  PaymentProcessor,
  paymentExecutionKey,
} from "../../src/services/payment-processor.js";
import { createPaymentWorker } from "../../src/workers/create-payment-worker.js";

const TEST_CUSTOMER_PREFIX = "IT-ASYNC-PAYMENTS-";
const TEST_OUTBOX_TYPE = `${PAYMENT_PROCESS_REQUESTED}_TEST_${randomUUID()}`;
const queueName = `${PAYMENT_QUEUE_NAME}-test-${randomUUID()}`;
const redis = createRedisConnection("producer");
const queue = createPaymentQueue(redis, queueName);
const outboxRepository = new PrismaOutboxRepository(prisma);
const paymentRepository = new PrismaPaymentProcessingRepository(prisma);

class RecordingBankClient implements BankClient {
  readonly requests: BankPaymentRequest[] = [];

  constructor(private readonly result: BankPaymentResult) {}

  async executePayment(request: BankPaymentRequest): Promise<BankPaymentResult> {
    this.requests.push(request);
    return this.result;
  }
}

async function createPendingPayment(reference: string, withOutbox = false) {
  return prisma.$transaction(async (transaction) => {
    const payment = await transaction.payment.create({
      data: {
        customerId: `${TEST_CUSTOMER_PREFIX}${randomUUID()}`,
        sourceAccount: "VA10001",
        destinationAccount: "EXT98765",
        amount: "250.00",
        reference,
        status: PaymentStatus.PENDING,
      },
    });

    await transaction.paymentEvent.create({
      data: {
        paymentId: payment.id,
        sequenceNumber: 1,
        fromStatus: null,
        toStatus: PaymentStatus.PENDING,
        reason: "Payment submitted",
        actor: "api",
        correlationId: `submission-${payment.id}`,
      },
    });

    if (withOutbox) {
      await transaction.outboxEvent.create({
        data: {
          type: TEST_OUTBOX_TYPE,
          aggregateId: payment.id,
          payload: { paymentId: payment.id },
        },
      });
    }

    return payment;
  });
}

async function cleanTestData(): Promise<void> {
  const paymentIds = (
    await prisma.payment.findMany({
      where: { customerId: { startsWith: TEST_CUSTOMER_PREFIX } },
      select: { id: true },
    })
  ).map(({ id }) => id);

  if (paymentIds.length > 0) {
    await prisma.$transaction([
      prisma.webhookDelivery.deleteMany({
        where: { paymentEvent: { paymentId: { in: paymentIds } } },
      }),
      prisma.idempotencyRecord.deleteMany({
        where: { paymentId: { in: paymentIds } },
      }),
      prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: paymentIds } },
      }),
      prisma.paymentEvent.deleteMany({
        where: { paymentId: { in: paymentIds } },
      }),
      prisma.payment.deleteMany({
        where: { id: { in: paymentIds } },
      }),
    ]);
  }
}

async function paymentWithEvents(paymentId: string) {
  return prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: {
      events: {
        orderBy: { sequenceNumber: "asc" },
      },
    },
  });
}

beforeAll(async () => {
  await queue.waitUntilReady();
});

beforeEach(async () => {
  await cleanTestData();
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await cleanTestData();
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.quit();
  await prisma.$disconnect();
});

describe("outbox dispatcher", () => {
  it("publishes an outbox event as a payment job before marking it published", async () => {
    const payment = await createPendingPayment("SUCCESS-OUTBOX", true);
    const dispatcher = new OutboxDispatcher(
      outboxRepository,
      new BullMqPaymentJobPublisher(queue),
      TEST_OUTBOX_TYPE,
    );

    const summary = await dispatcher.dispatchBatch(10);
    const job = await queue.getJob(payment.id);
    const outbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: payment.id },
    });

    expect(summary).toEqual({ found: 1, published: 1, failed: 0 });
    expect(job).not.toBeNull();
    expect(job?.id).toBe(payment.id);
    expect(job?.name).toBe(PAYMENT_JOB_NAME);
    expect(job?.data).toEqual({ paymentId: payment.id });
    expect(outbox.publishedAt).not.toBeNull();
    expect(outbox.publishAttempts).toBe(1);
    expect(outbox.lastError).toBeNull();
  });

  it("leaves publishedAt null and records a failed publication attempt", async () => {
    const payment = await createPendingPayment("SUCCESS-PUBLISH-FAIL", true);
    const dispatcher = new OutboxDispatcher(
      outboxRepository,
      {
        publish: async () => {
          throw new Error("Redis unavailable");
        },
      },
      TEST_OUTBOX_TYPE,
    );

    const summary = await dispatcher.dispatchBatch(10);
    const outbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: payment.id },
    });

    expect(summary).toEqual({ found: 1, published: 0, failed: 1 });
    expect(outbox.publishedAt).toBeNull();
    expect(outbox.publishAttempts).toBe(1);
    expect(outbox.lastError).toBe("Redis unavailable");
    expect(await queue.getJob(payment.id)).toBeUndefined();
  });

  it("deduplicates duplicate outbox publication by payment job ID", async () => {
    const payment = await createPendingPayment("SUCCESS-DUPLICATE", true);
    await prisma.outboxEvent.create({
      data: {
        type: TEST_OUTBOX_TYPE,
        aggregateId: payment.id,
        payload: { paymentId: payment.id },
      },
    });
    const dispatcher = new OutboxDispatcher(
      outboxRepository,
      new BullMqPaymentJobPublisher(queue),
      TEST_OUTBOX_TYPE,
    );

    const summary = await dispatcher.dispatchBatch(10);
    const jobs = await queue.getJobs(["wait", "active", "completed", "failed", "delayed"]);

    expect(summary).toEqual({ found: 2, published: 2, failed: 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(payment.id);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: payment.id, publishedAt: { not: null } },
      }),
    ).toBe(2);
  });
});

describe("payment processor", () => {
  it("transitions PENDING -> PROCESSING -> COMPLETED with complete audit history", async () => {
    const payment = await createPendingPayment("PAYMENT-SUCCESS");
    const processor = new PaymentProcessor(paymentRepository, new SimulatedBankClient());

    expect(await processor.processPayment(payment.id)).toBe("COMPLETED");

    const processed = await paymentWithEvents(payment.id);
    expect(processed).toMatchObject({
      status: PaymentStatus.COMPLETED,
      attemptCount: 1,
      failureCode: null,
      failureMessage: null,
    });
    expect(processed.bankExecutionId).toMatch(/^SIM-/);
    expect(processed.completedAt).not.toBeNull();
    expect(processed.events.map(({ toStatus }) => toStatus)).toEqual([
      PaymentStatus.PENDING,
      PaymentStatus.PROCESSING,
      PaymentStatus.COMPLETED,
    ]);
    expect(processed.events.map(({ sequenceNumber }) => sequenceNumber)).toEqual([1, 2, 3]);
  });

  it("transitions PENDING -> PROCESSING -> FAILED for permanent failure", async () => {
    const payment = await createPendingPayment("PAYMENT-PERM_FAIL");
    const bank = new RecordingBankClient({
      outcome: "PERMANENT_FAILURE",
      code: "ACCOUNT_CLOSED",
      message: "Destination account is closed",
    });
    const processor = new PaymentProcessor(paymentRepository, bank);

    expect(await processor.processPayment(payment.id)).toBe("FAILED");
    expect(await processor.processPayment(payment.id)).toBe("SKIPPED");

    const processed = await paymentWithEvents(payment.id);
    expect(processed).toMatchObject({
      status: PaymentStatus.FAILED,
      attemptCount: 1,
      bankExecutionId: null,
      failureCode: "ACCOUNT_CLOSED",
      failureMessage: "Destination account is closed",
      completedAt: null,
    });
    expect(bank.requests).toHaveLength(1);
    expect(processed.events.map(({ toStatus }) => toStatus)).toEqual([
      PaymentStatus.PENDING,
      PaymentStatus.PROCESSING,
      PaymentStatus.FAILED,
    ]);
  });

  it("transitions PENDING -> PROCESSING -> RETRYING for temporary failure", async () => {
    const payment = await createPendingPayment("PAYMENT-TEMP_FAIL");
    const processor = new PaymentProcessor(paymentRepository, new SimulatedBankClient());

    expect(await processor.processPayment(payment.id)).toBe("RETRYING");

    const processed = await paymentWithEvents(payment.id);
    expect(processed).toMatchObject({
      status: PaymentStatus.RETRYING,
      attemptCount: 1,
      bankExecutionId: null,
      failureCode: "BANK_TEMPORARY_UNAVAILABLE",
      completedAt: null,
      nextRetryAt: null,
    });
    expect(processed.events.map(({ toStatus }) => toStatus)).toEqual([
      PaymentStatus.PENDING,
      PaymentStatus.PROCESSING,
      PaymentStatus.RETRYING,
    ]);
  });

  it("does not process a completed payment again and uses a stable bank execution key", async () => {
    const payment = await createPendingPayment("PAYMENT-SUCCESS-STABLE");
    const bank = new RecordingBankClient({
      outcome: "SUCCESS",
      bankExecutionId: "BANK-EXECUTION-1",
    });
    const processor = new PaymentProcessor(paymentRepository, bank);

    expect(await processor.processPayment(payment.id)).toBe("COMPLETED");
    expect(await processor.processPayment(payment.id)).toBe("SKIPPED");

    expect(bank.requests).toHaveLength(1);
    expect(bank.requests[0]?.executionKey).toBe(paymentExecutionKey(payment.id));
    expect((await paymentWithEvents(payment.id)).events).toHaveLength(3);
  });
});

describe("BullMQ payment worker", () => {
  it("processes a published payment job end to end", async () => {
    const payment = await createPendingPayment("END-TO-END-SUCCESS", true);
    const workerRedis = createRedisConnection("worker");
    const processor = new PaymentProcessor(paymentRepository, new SimulatedBankClient());
    const worker = createPaymentWorker(workerRedis, processor, 1, queueName);
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker completion timed out")), 5000);

      worker.once("completed", (job) => {
        if (job.id === payment.id) {
          clearTimeout(timeout);
          resolve();
        }
      });
      worker.once("failed", (_job, error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    const dispatcher = new OutboxDispatcher(
      outboxRepository,
      new BullMqPaymentJobPublisher(queue),
      TEST_OUTBOX_TYPE,
    );

    try {
      await worker.waitUntilReady();
      await dispatcher.dispatchBatch(10);
      await completion;

      const processed = await paymentWithEvents(payment.id);
      expect(processed.status).toBe(PaymentStatus.COMPLETED);
      expect(processed.events.map(({ toStatus }) => toStatus)).toEqual([
        PaymentStatus.PENDING,
        PaymentStatus.PROCESSING,
        PaymentStatus.COMPLETED,
      ]);
    } finally {
      await worker.close();
      await workerRedis.quit();
    }
  });
});
