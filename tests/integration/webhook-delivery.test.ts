import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  WebhookHttpClient,
  WebhookHttpResponse,
} from "../../src/webhooks/webhook-http-client.js";
import { buildApp } from "../../src/app.js";
import { SimulatedBankClient } from "../../src/bank/simulated-bank-client.js";
import { prisma } from "../../src/config/prisma.js";
import { createRedisConnection } from "../../src/config/redis.js";
import {
  WEBHOOK_DELIVERIES_REQUESTED,
  WEBHOOK_DELIVERY_REQUESTED,
} from "../../src/domain/outbox-event-types.js";
import {
  PaymentStatus,
  WebhookDeliveryStatus,
} from "../../src/generated/prisma/enums.js";
import {
  BullMqWebhookJobPublisher,
  WEBHOOK_QUEUE_NAME,
  createWebhookQueue,
} from "../../src/queues/webhook-queue.js";
import { PrismaOutboxRepository } from "../../src/repositories/prisma-outbox-repository.js";
import { PrismaPaymentProcessingRepository } from "../../src/repositories/prisma-payment-processing-repository.js";
import { PrismaWebhookDeliveryRepository } from "../../src/repositories/prisma-webhook-delivery-repository.js";
import { PrismaWebhookEventRepository } from "../../src/repositories/prisma-webhook-event-repository.js";
import { PaymentProcessor } from "../../src/services/payment-processor.js";
import { WebhookDeliveryProcessor } from "../../src/services/webhook-delivery-processor.js";
import { WebhookEventMaterializer } from "../../src/services/webhook-event-materializer.js";
import { WebhookJobOutboxDispatcher } from "../../src/services/webhook-job-outbox-dispatcher.js";
import { createWebhookWorker } from "../../src/workers/create-webhook-worker.js";

const TEST_CUSTOMER_PREFIX = "IT-WEBHOOK-DELIVERY-";
const signingSecret = "delivery-integration-signing-secret";
const queueName = `${WEBHOOK_QUEUE_NAME}-test-${randomUUID()}`;
const redis = createRedisConnection("producer");
const queue = createWebhookQueue(redis, queueName);
const outboxRepository = new PrismaOutboxRepository(prisma);
const eventRepository = new PrismaWebhookEventRepository(prisma);
const deliveryRepository = new PrismaWebhookDeliveryRepository(prisma);
const app = await buildApp({ logger: false });
await app.ready();

interface RecordedRequest {
  url: string;
  body: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
}

class SequenceHttpClient implements WebhookHttpClient {
  readonly requests: RecordedRequest[] = [];

  constructor(private readonly outcomes: Array<number | Error>) {}

  async post(
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<WebhookHttpResponse> {
    this.requests.push({ url, body, headers, timeoutMs });
    const outcome = this.outcomes.shift() ?? 200;

    if (outcome instanceof Error) {
      throw outcome;
    }

    return { status: outcome };
  }
}

async function cleanTestData(): Promise<void> {
  const paymentIds = (
    await prisma.payment.findMany({
      where: { customerId: { startsWith: TEST_CUSTOMER_PREFIX } },
      select: { id: true },
    })
  ).map(({ id }) => id);
  const subscriptionIds = (
    await prisma.webhookSubscription.findMany({
      where: { customerId: { startsWith: TEST_CUSTOMER_PREFIX } },
      select: { id: true },
    })
  ).map(({ id }) => id);
  const deliveryIds = (
    await prisma.webhookDelivery.findMany({
      where: {
        OR: [
          { subscriptionId: { in: subscriptionIds } },
          { paymentEvent: { paymentId: { in: paymentIds } } },
        ],
      },
      select: { id: true },
    })
  ).map(({ id }) => id);

  await prisma.$transaction([
    prisma.outboxEvent.deleteMany({
      where: { aggregateId: { in: [...paymentIds, ...deliveryIds] } },
    }),
    prisma.webhookDelivery.deleteMany({ where: { id: { in: deliveryIds } } }),
    prisma.idempotencyRecord.deleteMany({ where: { paymentId: { in: paymentIds } } }),
    prisma.paymentEvent.deleteMany({ where: { paymentId: { in: paymentIds } } }),
    prisma.payment.deleteMany({ where: { id: { in: paymentIds } } }),
    prisma.webhookSubscription.deleteMany({ where: { id: { in: subscriptionIds } } }),
  ]);
}

async function createFixture(options: { enabled?: boolean } = {}) {
  const customerId = `${TEST_CUSTOMER_PREFIX}${randomUUID()}`;
  const subscription = await prisma.webhookSubscription.create({
    data: {
      customerId,
      url: "https://webhook.test/status",
      signingSecret,
      enabled: options.enabled ?? true,
    },
  });
  const payment = await prisma.payment.create({
    data: {
      customerId,
      sourceAccount: "VA10001",
      destinationAccount: "EXT98765",
      amount: "250.00",
      reference: "WEBHOOK-TEST",
      status: PaymentStatus.PROCESSING,
    },
  });
  const paymentEvent = await prisma.paymentEvent.create({
    data: {
      paymentId: payment.id,
      sequenceNumber: 1,
      fromStatus: PaymentStatus.PENDING,
      toStatus: PaymentStatus.PROCESSING,
      reason: "Payment processing started",
      actor: "payment-worker",
      correlationId: `webhook-${payment.id}`,
    },
  });
  await prisma.outboxEvent.create({
    data: {
      type: WEBHOOK_DELIVERIES_REQUESTED,
      aggregateId: payment.id,
      payload: { paymentEventId: paymentEvent.id },
    },
  });

  return { customerId, subscription, payment, paymentEvent };
}

async function materialize(): Promise<void> {
  const materializer = new WebhookEventMaterializer(outboxRepository, eventRepository);
  await materializer.materializeBatch(100);
}

async function deliveryFor(paymentEventId: string) {
  return prisma.webhookDelivery.findFirstOrThrow({ where: { paymentEventId } });
}

async function makeAttemptDue(webhookDeliveryId: string): Promise<void> {
  await prisma.webhookDelivery.update({
    where: { id: webhookDeliveryId },
    data: { nextAttemptAt: new Date(Date.now() - 1) },
  });
}

function processor(httpClient: WebhookHttpClient, maxAttempts = 3) {
  return new WebhookDeliveryProcessor(deliveryRepository, httpClient, {
    retryBaseDelayMs: 60_000,
    maxAttempts,
    requestTimeoutMs: 5000,
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
  await app.close();
});

describe("webhook delivery creation", () => {
  it("creates one delivery and delivery-job outbox for an enabled subscription", async () => {
    const fixture = await createFixture();

    await materialize();

    const delivery = await deliveryFor(fixture.paymentEvent.id);
    expect(delivery).toMatchObject({
      subscriptionId: fixture.subscription.id,
      status: WebhookDeliveryStatus.PENDING,
      attemptCount: 0,
    });
    expect(
      await prisma.outboxEvent.findFirst({
        where: {
          type: WEBHOOK_DELIVERY_REQUESTED,
          aggregateId: delivery.id,
        },
      }),
    ).toMatchObject({
      payload: { webhookDeliveryId: delivery.id, attemptNumber: 1 },
      publishedAt: null,
    });
  });

  it("does not create a delivery for a disabled subscription", async () => {
    const fixture = await createFixture({ enabled: false });

    await materialize();

    expect(
      await prisma.webhookDelivery.count({
        where: { paymentEventId: fixture.paymentEvent.id },
      }),
    ).toBe(0);
  });

  it("does not duplicate a delivery when event handling is replayed", async () => {
    const fixture = await createFixture();
    await prisma.outboxEvent.create({
      data: {
        type: WEBHOOK_DELIVERIES_REQUESTED,
        aggregateId: fixture.payment.id,
        payload: { paymentEventId: fixture.paymentEvent.id },
      },
    });

    await materialize();

    expect(
      await prisma.webhookDelivery.count({
        where: {
          subscriptionId: fixture.subscription.id,
          paymentEventId: fixture.paymentEvent.id,
        },
      }),
    ).toBe(1);
  });
});

describe("webhook delivery processing", () => {
  it("records a successful 2xx delivery and never sends it again", async () => {
    const fixture = await createFixture();
    await materialize();
    const delivery = await deliveryFor(fixture.paymentEvent.id);
    const httpClient = new SequenceHttpClient([204]);
    const deliveryProcessor = processor(httpClient);

    expect(await deliveryProcessor.process(delivery.id, 1)).toBe("DELIVERED");
    expect(await deliveryProcessor.process(delivery.id, 1)).toBe("SKIPPED");

    const delivered = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(delivered).toMatchObject({
      status: WebhookDeliveryStatus.DELIVERED,
      attemptCount: 1,
      lastHttpStatus: 204,
      lastError: null,
      nextAttemptAt: null,
    });
    expect(delivered.deliveredAt).not.toBeNull();
    expect(httpClient.requests).toHaveLength(1);
    expect(httpClient.requests[0]?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Webhook-Event-Id": fixture.paymentEvent.id,
    });
    expect(httpClient.requests[0]?.headers["X-Webhook-Signature"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(JSON.parse(httpClient.requests[0]?.body ?? "{}")).toEqual({
      eventId: fixture.paymentEvent.id,
      eventType: "payment.status_changed",
      paymentId: fixture.payment.id,
      customerId: fixture.customerId,
      fromStatus: "PENDING",
      toStatus: "PROCESSING",
      reason: "Payment processing started",
      occurredAt: fixture.paymentEvent.createdAt.toISOString(),
    });
  });

  it("records failure, rejects an early retry, then succeeds when due", async () => {
    const fixture = await createFixture();
    await materialize();
    const delivery = await deliveryFor(fixture.paymentEvent.id);
    const httpClient = new SequenceHttpClient([500, 200]);
    const deliveryProcessor = processor(httpClient);

    expect(await deliveryProcessor.process(delivery.id, 1)).toBe("RETRYING");
    expect(await deliveryProcessor.process(delivery.id, 2)).toMatchObject({
      outcome: "NOT_DUE",
    });
    expect(httpClient.requests).toHaveLength(1);

    const retrying = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(retrying).toMatchObject({
      status: WebhookDeliveryStatus.RETRYING,
      attemptCount: 1,
      lastHttpStatus: 500,
    });
    expect(retrying.nextAttemptAt).not.toBeNull();
    expect(retrying.lastError).toContain("HTTP 500");

    await makeAttemptDue(delivery.id);
    expect(await deliveryProcessor.process(delivery.id, 2)).toBe("DELIVERED");
    expect(
      await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({
      status: WebhookDeliveryStatus.DELIVERED,
      attemptCount: 2,
      lastHttpStatus: 200,
      lastError: null,
      nextAttemptAt: null,
    });
  });

  it("handles network failure and exhausts retries without changing payment", async () => {
    const fixture = await createFixture();
    await materialize();
    const delivery = await deliveryFor(fixture.paymentEvent.id);
    const httpClient = new SequenceHttpClient([
      new Error("connection refused"),
      503,
      503,
    ]);
    const deliveryProcessor = processor(httpClient, 3);

    expect(await deliveryProcessor.process(delivery.id, 1)).toBe("RETRYING");
    await makeAttemptDue(delivery.id);
    expect(await deliveryProcessor.process(delivery.id, 2)).toBe("RETRYING");
    await makeAttemptDue(delivery.id);
    expect(await deliveryProcessor.process(delivery.id, 3)).toBe("FAILED");
    expect(await deliveryProcessor.process(delivery.id, 4)).toBe("SKIPPED");

    const failed = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(failed).toMatchObject({
      status: WebhookDeliveryStatus.FAILED,
      attemptCount: 3,
      lastHttpStatus: 503,
      nextAttemptAt: null,
    });
    expect(httpClient.requests).toHaveLength(3);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } }))
        .status,
    ).toBe(PaymentStatus.PROCESSING);
  });

  it("claims a duplicate attempt once and ignores its stale replay", async () => {
    const fixture = await createFixture();
    await materialize();
    const delivery = await deliveryFor(fixture.paymentEvent.id);
    const httpClient = new SequenceHttpClient([500, 500]);
    const deliveryProcessor = processor(httpClient);

    expect(await deliveryProcessor.process(delivery.id, 1)).toBe("RETRYING");
    await makeAttemptDue(delivery.id);
    const outcomes = await Promise.all([
      deliveryProcessor.process(delivery.id, 2),
      deliveryProcessor.process(delivery.id, 2),
    ]);
    expect(outcomes.sort()).toEqual(["RETRYING", "SKIPPED"]);
    expect(httpClient.requests).toHaveLength(2);

    await makeAttemptDue(delivery.id);
    expect(await deliveryProcessor.process(delivery.id, 2)).toBe("SKIPPED");
    expect(httpClient.requests).toHaveLength(2);
  });

  it("stops without an HTTP attempt when a subscription was disabled", async () => {
    const fixture = await createFixture();
    await materialize();
    const delivery = await deliveryFor(fixture.paymentEvent.id);
    await prisma.webhookSubscription.update({
      where: { id: fixture.subscription.id },
      data: { enabled: false },
    });
    const httpClient = new SequenceHttpClient([200]);

    expect(await processor(httpClient).process(delivery.id, 1)).toBe("DISABLED");
    expect(httpClient.requests).toHaveLength(0);
  });
});

describe("webhook BullMQ pipeline", () => {
  it("publishes and processes a delayed retry that eventually succeeds", async () => {
    const fixture = await createFixture();
    await materialize();
    const delivery = await deliveryFor(fixture.paymentEvent.id);
    const httpClient = new SequenceHttpClient([503, 200]);
    const deliveryProcessor = new WebhookDeliveryProcessor(
      deliveryRepository,
      httpClient,
      {
        retryBaseDelayMs: 25,
        maxAttempts: 3,
        requestTimeoutMs: 5000,
      },
    );
    const workerRedis = createRedisConnection("worker");
    const worker = createWebhookWorker(workerRedis, deliveryProcessor, 1, queueName);
    const dispatcher = new WebhookJobOutboxDispatcher(
      outboxRepository,
      new BullMqWebhookJobPublisher(queue),
    );
    const deadline = Date.now() + 5000;

    try {
      await worker.waitUntilReady();

      while (Date.now() < deadline) {
        await dispatcher.dispatchBatch(100);
        const current = await prisma.webhookDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
        });

        if (current.status === WebhookDeliveryStatus.DELIVERED) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(
        await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ).toMatchObject({
        status: WebhookDeliveryStatus.DELIVERED,
        attemptCount: 2,
        lastHttpStatus: 200,
        nextAttemptAt: null,
      });
      expect(httpClient.requests).toHaveLength(2);
      expect(await queue.getJob(`${delivery.id}-attempt-1`)).not.toBeNull();
      expect(await queue.getJob(`${delivery.id}-attempt-2`)).not.toBeNull();
    } finally {
      await worker.close();
      await workerRedis.quit();
    }
  });

  it("submits and processes a payment, then delivers every status event", async () => {
    const customerId = `${TEST_CUSTOMER_PREFIX}${randomUUID()}`;
    await prisma.webhookSubscription.create({
      data: {
        customerId,
        url: "https://webhook.test/status",
        signingSecret,
      },
    });
    const submission = await app.inject({
      method: "POST",
      url: "/v1/payments",
      headers: { "idempotency-key": randomUUID() },
      payload: {
        customerId,
        sourceAccount: "VA10001",
        destinationAccount: "EXT98765",
        amount: "250.00",
        reference: "WEBHOOK-END-TO-END-SUCCESS",
      },
    });
    const paymentId = submission.json().id as string;
    const paymentProcessor = new PaymentProcessor(
      new PrismaPaymentProcessingRepository(prisma),
      new SimulatedBankClient(),
    );
    expect(await paymentProcessor.processPayment(paymentId)).toBe("COMPLETED");

    await materialize();
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { paymentEvent: { paymentId } },
    });
    expect(deliveries).toHaveLength(3);

    const httpClient = new SequenceHttpClient([200, 200, 200]);
    const deliveryProcessor = processor(httpClient);
    const workerRedis = createRedisConnection("worker");
    const worker = createWebhookWorker(workerRedis, deliveryProcessor, 1, queueName);
    const dispatcher = new WebhookJobOutboxDispatcher(
      outboxRepository,
      new BullMqWebhookJobPublisher(queue),
    );
    const deadline = Date.now() + 5000;

    try {
      await worker.waitUntilReady();
      await dispatcher.dispatchBatch(100);

      while (Date.now() < deadline) {
        const delivered = await prisma.webhookDelivery.count({
          where: {
            id: { in: deliveries.map(({ id }) => id) },
            status: WebhookDeliveryStatus.DELIVERED,
          },
        });

        if (delivered === deliveries.length) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(
        await prisma.webhookDelivery.count({
          where: {
            id: { in: deliveries.map(({ id }) => id) },
            status: WebhookDeliveryStatus.DELIVERED,
          },
        }),
      ).toBe(3);
      expect(httpClient.requests).toHaveLength(3);
      const payloads = httpClient.requests.map(({ body }) => JSON.parse(body));
      expect(payloads.map(({ toStatus }) => toStatus).sort()).toEqual(
        ["PENDING", "PROCESSING", "COMPLETED"].sort(),
      );
      expect(payloads.every((payload) => !("sourceAccount" in payload))).toBe(true);
      expect(payloads.every((payload) => !("destinationAccount" in payload))).toBe(true);
    } finally {
      await worker.close();
      await workerRedis.quit();
    }
  });
});
