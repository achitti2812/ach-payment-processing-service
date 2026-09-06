import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/config/prisma.js";
import { PrismaPaymentRepository } from "../../src/repositories/prisma-payment-repository.js";

const TEST_CUSTOMER_PREFIX = "IT-PAYMENTS-";
const CUSTOMER_ID = `${TEST_CUSTOMER_PREFIX}C12345`;

const validPayment = {
  customerId: CUSTOMER_ID,
  sourceAccount: "VA10001",
  destinationAccount: "EXT98765",
  amount: "250.00",
  reference: "PMT-1001",
};

const app = await buildApp({ logger: false });
await app.ready();

async function cleanPaymentTestData(): Promise<void> {
  const paymentIds = (
    await prisma.payment.findMany({
      where: {
        customerId: {
          startsWith: TEST_CUSTOMER_PREFIX,
        },
      },
      select: { id: true },
    })
  ).map(({ id }) => id);

  if (paymentIds.length === 0) {
    return;
  }

  await prisma.$transaction([
    prisma.webhookDelivery.deleteMany({
      where: {
        paymentEvent: {
          paymentId: { in: paymentIds },
        },
      },
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

async function submitPayment(
  idempotencyKey: string,
  payload: typeof validPayment = validPayment,
  correlationId?: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/payments",
    headers: {
      "idempotency-key": idempotencyKey,
      ...(correlationId ? { "x-correlation-id": correlationId } : {}),
    },
    payload,
  });
}

beforeEach(async () => {
  await cleanPaymentTestData();
});

afterAll(async () => {
  await cleanPaymentTestData();
  await app.close();
});

describe("POST /v1/payments", () => {
  it("creates a pending payment and returns 202", async () => {
    const response = await submitPayment("successful-submission");
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(body).toMatchObject({
      customerId: CUSTOMER_ID,
      sourceAccount: "VA10001",
      destinationAccount: "EXT98765",
      amount: "250.00",
      reference: "PMT-1001",
      status: "PENDING",
    });
    expect(body.id).toEqual(expect.any(String));
    expect(body.createdAt).toEqual(expect.any(String));
    expect(body.updatedAt).toEqual(expect.any(String));
    expect(Object.keys(body).sort()).toEqual(
      [
        "amount",
        "createdAt",
        "customerId",
        "destinationAccount",
        "id",
        "reference",
        "sourceAccount",
        "status",
        "updatedAt",
      ].sort(),
    );
  });

  it("documents the payment submission endpoint in OpenAPI", () => {
    expect(app.swagger().paths?.["/v1/payments"]?.post).toBeDefined();
  });

  it("rejects a request without an Idempotency-Key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/payments",
      payload: validPayment,
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.payment.count({ where: { customerId: CUSTOMER_ID } })).toBe(0);
  });

  it.each(["0", "-1.00", "12.345"])("rejects invalid amount %s", async (amount) => {
    const response = await submitPayment("invalid-amount", {
      ...validPayment,
      amount,
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.payment.count({ where: { customerId: CUSTOMER_ID } })).toBe(0);
  });

  it("returns the original payment for the same key and normalized payload", async () => {
    const firstResponse = await submitPayment("same-request");
    const replayResponse = await submitPayment("same-request", {
      ...validPayment,
      amount: "250",
    });

    expect(firstResponse.statusCode).toBe(202);
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json()).toEqual(firstResponse.json());
    expect(await prisma.payment.count({ where: { customerId: CUSTOMER_ID } })).toBe(1);
  });

  it("returns 409 when the same key is reused for a different payload", async () => {
    const firstResponse = await submitPayment("conflicting-request");
    const conflictResponse = await submitPayment("conflicting-request", {
      ...validPayment,
      reference: "PMT-1002",
    });

    expect(firstResponse.statusCode).toBe(202);
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toMatchObject({
      statusCode: 409,
      error: "Conflict",
    });
    expect(await prisma.payment.count({ where: { customerId: CUSTOMER_ID } })).toBe(1);
  });

  it("creates the initial audit event and minimal outbox event", async () => {
    const correlationId = "correlation-payment-submitted";
    const response = await submitPayment("audit-and-outbox", validPayment, correlationId);
    const paymentId = response.json().id as string;

    const paymentEvent = await prisma.paymentEvent.findUnique({
      where: {
        paymentId_sequenceNumber: {
          paymentId,
          sequenceNumber: 1,
        },
      },
    });
    const outboxEvent = await prisma.outboxEvent.findFirst({
      where: { aggregateId: paymentId },
    });

    expect(paymentEvent).toMatchObject({
      paymentId,
      sequenceNumber: 1,
      fromStatus: null,
      toStatus: "PENDING",
      actor: "api",
      reason: "Payment submitted",
      correlationId,
    });
    expect(outboxEvent).toMatchObject({
      type: "PAYMENT_PROCESS_REQUESTED",
      aggregateId: paymentId,
      payload: { paymentId },
      publishedAt: null,
      publishAttempts: 0,
    });
  });

  it("rolls back all records when the final outbox insert fails", async () => {
    const repository = new PrismaPaymentRepository(prisma);
    const rollbackCorrelationId = "rollback-correlation";
    const invalidOutboxType = "x".repeat(101);

    await expect(
      repository.createPaymentSubmission({
        payment: {
          ...validPayment,
          customerId: `${TEST_CUSTOMER_PREFIX}ROLLBACK`,
        },
        idempotencyKey: "rollback-request",
        requestHash: "a".repeat(64),
        correlationId: rollbackCorrelationId,
        outboxType: invalidOutboxType,
      }),
    ).rejects.toThrow();

    expect(
      await prisma.payment.count({
        where: { customerId: `${TEST_CUSTOMER_PREFIX}ROLLBACK` },
      }),
    ).toBe(0);
    expect(
      await prisma.idempotencyRecord.count({
        where: { customerId: `${TEST_CUSTOMER_PREFIX}ROLLBACK` },
      }),
    ).toBe(0);
    expect(
      await prisma.paymentEvent.count({
        where: { correlationId: rollbackCorrelationId },
      }),
    ).toBe(0);
    expect(
      await prisma.outboxEvent.count({
        where: { type: invalidOutboxType },
      }),
    ).toBe(0);
  });

  it("creates only one payment under concurrent duplicate submissions", async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => submitPayment("concurrent-request")),
    );
    const responseIds = new Set(responses.map((response) => response.json().id));
    const [paymentId] = responseIds;

    expect(responses.filter(({ statusCode }) => statusCode === 202)).toHaveLength(1);
    expect(responses.filter(({ statusCode }) => statusCode === 200)).toHaveLength(5);
    expect(responseIds.size).toBe(1);
    expect(await prisma.payment.count({ where: { customerId: CUSTOMER_ID } })).toBe(1);
    expect(
      await prisma.idempotencyRecord.count({
        where: {
          customerId: CUSTOMER_ID,
          idempotencyKey: "concurrent-request",
        },
      }),
    ).toBe(1);
    expect(await prisma.paymentEvent.count({ where: { paymentId } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: paymentId } })).toBe(1);
  });
});
