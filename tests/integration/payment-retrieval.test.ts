import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/config/prisma.js";
import { PaymentStatus } from "../../src/generated/prisma/enums.js";

const TEST_CUSTOMER_PREFIX = "IT-PAYMENT-READS-";
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

async function createPayment(amount = validPayment.amount) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/payments",
    headers: {
      "idempotency-key": randomUUID(),
      "x-correlation-id": "read-api-correlation",
    },
    payload: {
      ...validPayment,
      amount,
    },
  });

  expect(response.statusCode).toBe(202);
  return response.json() as { id: string };
}

beforeEach(async () => {
  await cleanPaymentTestData();
});

afterAll(async () => {
  await cleanPaymentTestData();
  await app.close();
});

describe("GET /v1/payments/:paymentId", () => {
  it("returns an existing payment with client-facing fields", async () => {
    const created = await createPayment();
    const response = await app.inject({
      method: "GET",
      url: `/v1/payments/${created.id}`,
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      id: created.id,
      customerId: CUSTOMER_ID,
      sourceAccount: "VA10001",
      destinationAccount: "EXT98765",
      amount: "250.00",
      reference: "PMT-1001",
      status: "PENDING",
      attemptCount: 0,
      maxAttempts: 5,
      failureCode: null,
      failureMessage: null,
      completedAt: null,
    });
  });

  it("returns 404 for an unknown payment", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/payments/${randomUUID()}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "Payment not found",
    });
  });

  it("returns the amount with exactly two decimal places", async () => {
    const created = await createPayment("250");
    const response = await app.inject({
      method: "GET",
      url: `/v1/payments/${created.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().amount).toBe("250.00");
  });

  it("does not expose payment implementation details", async () => {
    const created = await createPayment();
    const response = await app.inject({
      method: "GET",
      url: `/v1/payments/${created.id}`,
    });

    expect(Object.keys(response.json()).sort()).toEqual(
      [
        "amount",
        "attemptCount",
        "completedAt",
        "createdAt",
        "customerId",
        "destinationAccount",
        "failureCode",
        "failureMessage",
        "id",
        "maxAttempts",
        "reference",
        "sourceAccount",
        "status",
        "updatedAt",
      ].sort(),
    );
  });

  it("returns stable terminal payment details", async () => {
    const created = await createPayment();
    const completedAt = new Date("2026-09-06T12:00:00.000Z");
    await prisma.payment.update({
      where: { id: created.id },
      data: {
        status: PaymentStatus.COMPLETED,
        attemptCount: 1,
        bankExecutionId: `BANK-${created.id}`,
        completedAt,
      },
    });

    const first = await app.inject({
      method: "GET",
      url: `/v1/payments/${created.id}`,
    });
    const second = await app.inject({
      method: "GET",
      url: `/v1/payments/${created.id}`,
    });

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({
      status: "COMPLETED",
      attemptCount: 1,
      completedAt: completedAt.toISOString(),
    });
    expect(first.json()).not.toHaveProperty("bankExecutionId");
  });
});

describe("GET /v1/payments/:paymentId/events", () => {
  it("returns the initial pending audit event", async () => {
    const created = await createPayment();
    const response = await app.inject({
      method: "GET",
      url: `/v1/payments/${created.id}/events`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      paymentId: created.id,
      events: [
        {
          sequenceNumber: 1,
          fromStatus: null,
          toStatus: "PENDING",
          reason: "Payment submitted",
          actor: "api",
          correlationId: "read-api-correlation",
        },
      ],
    });
  });

  it("orders events by sequence number ascending", async () => {
    const created = await createPayment();

    await prisma.paymentEvent.create({
      data: {
        paymentId: created.id,
        sequenceNumber: 3,
        fromStatus: PaymentStatus.PROCESSING,
        toStatus: PaymentStatus.RETRYING,
        reason: "Temporary failure",
        actor: "test",
        correlationId: "sequence-3",
      },
    });
    await prisma.paymentEvent.create({
      data: {
        paymentId: created.id,
        sequenceNumber: 2,
        fromStatus: PaymentStatus.PENDING,
        toStatus: PaymentStatus.PROCESSING,
        reason: "Processing started",
        actor: "test",
        correlationId: "sequence-2",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/payments/${created.id}/events`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().events.map(({ sequenceNumber }: { sequenceNumber: number }) => sequenceNumber)).toEqual([
      1, 2, 3,
    ]);
  });

  it("enforces unique sequence numbers per payment", async () => {
    const created = await createPayment();

    await expect(
      prisma.paymentEvent.create({
        data: {
          paymentId: created.id,
          sequenceNumber: 1,
          fromStatus: null,
          toStatus: PaymentStatus.PENDING,
          reason: "Duplicate sequence",
          actor: "test",
          correlationId: "duplicate-sequence",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.paymentEvent.count({ where: { paymentId: created.id } })).toBe(1);
  });

  it("returns 404 for an unknown payment", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/payments/${randomUUID()}/events`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "Payment not found",
    });
  });

  it("returns only public audit fields", async () => {
    const created = await createPayment();
    const response = await app.inject({
      method: "GET",
      url: `/v1/payments/${created.id}/events`,
    });
    const body = response.json();

    expect(Object.keys(body).sort()).toEqual(["events", "paymentId"]);
    expect(Object.keys(body.events[0]).sort()).toEqual(
      [
        "actor",
        "correlationId",
        "createdAt",
        "fromStatus",
        "id",
        "reason",
        "sequenceNumber",
        "toStatus",
      ].sort(),
    );
    expect(response.body).not.toContain("sourceAccount");
    expect(response.body).not.toContain("destinationAccount");
    expect(response.body).not.toContain("amount");
  });
});

describe("payment read API validation and documentation", () => {
  it.each(["/v1/payments/not-a-uuid", "/v1/payments/not-a-uuid/events"])(
    "returns 400 for an invalid payment ID at %s",
    async (url) => {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        statusCode: 400,
        error: "Bad Request",
      });
    },
  );

  it("documents both read endpoints in OpenAPI", () => {
    const paths = app.swagger().paths;

    expect(paths?.["/v1/payments/{paymentId}"]?.get).toBeDefined();
    expect(paths?.["/v1/payments/{paymentId}/events"]?.get).toBeDefined();
    expect(
      Object.keys(paths?.["/v1/payments/{paymentId}"]?.get?.responses ?? {}).sort(),
    ).toEqual(["200", "400", "404"]);
    expect(
      Object.keys(
        paths?.["/v1/payments/{paymentId}/events"]?.get?.responses ?? {},
      ).sort(),
    ).toEqual(["200", "400", "404"]);
  });
});
