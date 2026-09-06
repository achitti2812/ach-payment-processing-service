import Redis from "ioredis";

import { env } from "./env.js";

export type RedisConnectionPurpose = "producer" | "worker";

export function createRedisConnection(purpose: RedisConnectionPurpose): Redis {
  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is required");
  }

  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: purpose === "worker" ? null : 1,
  });
}
