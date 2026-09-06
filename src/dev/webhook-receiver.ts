import Fastify from "fastify";

import { verifyWebhookSignature } from "../domain/webhook.js";

const port = Number(process.env.WEBHOOK_RECEIVER_PORT ?? 4000);
const secret = process.env.WEBHOOK_RECEIVER_SECRET;
const app = Fastify({ logger: true });

app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_request, body, done) => done(null, body),
);

async function receiveWebhook(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<void> {
  const signature = headers["x-webhook-signature"];
  const signatureValue = Array.isArray(signature) ? signature[0] : signature;

  console.log("Webhook headers", {
    signature: signatureValue,
    eventId: headers["x-webhook-event-id"],
    timestamp: headers["x-webhook-timestamp"],
  });
  console.log("Webhook payload", JSON.parse(rawBody));

  if (secret && signatureValue) {
    console.log(
      "Webhook signature valid",
      verifyWebhookSignature(secret, rawBody, signatureValue),
    );
  }
}

app.post<{ Body: string }>("/success", async (request, reply) => {
  await receiveWebhook(request.body, request.headers);
  return reply.code(200).send({ received: true });
});

app.post<{ Body: string }>("/fail", async (request, reply) => {
  await receiveWebhook(request.body, request.headers);
  return reply.code(500).send({ received: false });
});

await app.listen({ host: "127.0.0.1", port });
console.log(`Development webhook receiver listening on http://localhost:${port}`);
