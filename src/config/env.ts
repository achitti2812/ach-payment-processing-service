import "dotenv/config";

const port = Number(process.env.PORT ?? 3000);

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

export const env = Object.freeze({
  NODE_ENV: process.env.NODE_ENV ?? "development",
  HOST: process.env.HOST ?? "0.0.0.0",
  PORT: port,
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  OUTBOX_POLL_INTERVAL_MS: positiveInteger(
    process.env.OUTBOX_POLL_INTERVAL_MS,
    1000,
    "OUTBOX_POLL_INTERVAL_MS",
  ),
  OUTBOX_BATCH_SIZE: positiveInteger(
    process.env.OUTBOX_BATCH_SIZE,
    100,
    "OUTBOX_BATCH_SIZE",
  ),
  PAYMENT_WORKER_CONCURRENCY: positiveInteger(
    process.env.PAYMENT_WORKER_CONCURRENCY,
    5,
    "PAYMENT_WORKER_CONCURRENCY",
  ),
});
