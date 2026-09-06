import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/config/prisma.js";

const TEST_CUSTOMER_PREFIX = "IT-WEBHOOK-SUBSCRIPTIONS-";
const customerId = `${TEST_CUSTOMER_PREFIX}${randomUUID()}`;
const signingSecret = "integration-test-signing-secret";
const app = await buildApp({ logger: false });
await app.ready();

async function cleanTestData(): Promise<void> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { customerId: { startsWith: TEST_CUSTOMER_PREFIX } },
    select: {
      id: true,
      deliveries: { select: { id: true } },
    },
  });
  const subscriptionIds = subscriptions.map(({ id }) => id);
  const deliveryIds = subscriptions.flatMap(({ deliveries }) =>
    deliveries.map(({ id }) => id),
  );

  if (deliveryIds.length > 0) {
    await prisma.outboxEvent.deleteMany({
      where: { aggregateId: { in: deliveryIds } },
    });
  }

  if (subscriptionIds.length > 0) {
    await prisma.webhookDelivery.deleteMany({
      where: { subscriptionId: { in: subscriptionIds } },
    });
    await prisma.webhookSubscription.deleteMany({
      where: { id: { in: subscriptionIds } },
    });
  }
}

beforeEach(cleanTestData);

afterAll(async () => {
  await cleanTestData();
  await app.close();
});

describe("webhook subscription API", () => {
  it("creates an enabled subscription without returning its signing secret", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/subscriptions",
      payload: {
        customerId,
        url: "http://localhost:4000/success",
        signingSecret,
      },
    });
    const body = response.json();

    expect(response.statusCode).toBe(201);
    expect(body).toMatchObject({
      customerId,
      url: "http://localhost:4000/success",
      enabled: true,
    });
    expect(body).not.toHaveProperty("signingSecret");
    expect(
      await prisma.webhookSubscription.findUniqueOrThrow({
        where: { id: body.id },
        select: { signingSecret: true },
      }),
    ).toEqual({ signingSecret });
  });

  it.each([
    "not-a-url",
    "http://example.com/webhooks",
    "ftp://example.com/webhooks",
    "https://user:password@example.com/webhooks",
  ])("rejects invalid or insecure URL %s", async (url) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/subscriptions",
      payload: { customerId, url, signingSecret },
    });

    expect(response.statusCode).toBe(400);
  });

  it("lists only active customer subscriptions and supports disabling", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/webhooks/subscriptions",
      payload: {
        customerId,
        url: "https://example.com/webhook-one",
        signingSecret,
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/webhooks/subscriptions",
      payload: {
        customerId,
        url: "https://example.com/webhook-two",
        signingSecret,
      },
    });

    const disabled = await app.inject({
      method: "PATCH",
      url: `/v1/webhooks/subscriptions/${first.json().id}`,
      payload: { enabled: false },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/v1/webhooks/subscriptions/${customerId}`,
    });

    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ enabled: false });
    expect(disabled.json()).not.toHaveProperty("signingSecret");
    expect(listed.statusCode).toBe(200);
    expect(listed.json().subscriptions).toHaveLength(1);
    expect(listed.json().subscriptions[0].url).toBe(
      "https://example.com/webhook-two",
    );
    expect(listed.body).not.toContain(signingSecret);

    const enabled = await app.inject({
      method: "PATCH",
      url: `/v1/webhooks/subscriptions/${first.json().id}`,
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true });
    expect(enabled.json()).not.toHaveProperty("signingSecret");
  });

  it("returns an empty active list for a customer without subscriptions", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/webhooks/subscriptions/${TEST_CUSTOMER_PREFIX}NONE`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ subscriptions: [] });
  });

  it("returns 404 for an unknown valid subscription ID", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/webhooks/subscriptions/${randomUUID()}`,
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "Webhook subscription not found",
    });
  });

  it("returns 400 for a malformed subscription ID", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/webhooks/subscriptions/not-a-uuid",
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      error: "Bad Request",
    });
  });

  it("documents subscription APIs and the outgoing payload", () => {
    const document = app.swagger();
    const createOperation = document.paths?.["/v1/webhooks/subscriptions"]?.post;
    const listOperation =
      document.paths?.["/v1/webhooks/subscriptions/{customerId}"]?.get;
    const updateOperation =
      document.paths?.["/v1/webhooks/subscriptions/{subscriptionId}"]?.patch;

    expect(createOperation).toBeDefined();
    expect(listOperation).toBeDefined();
    expect(updateOperation).toBeDefined();
    expect(Object.keys(createOperation?.responses ?? {}).sort()).toEqual([
      "201",
      "400",
    ]);
    expect(Object.keys(listOperation?.responses ?? {}).sort()).toEqual(["200", "400"]);
    expect(Object.keys(updateOperation?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "404",
    ]);
    expect(JSON.stringify(createOperation?.responses?.["201"])).not.toContain(
      "signingSecret",
    );
    expect(document.components?.schemas?.PaymentStatusChangedWebhook).toBeDefined();
  });
});
