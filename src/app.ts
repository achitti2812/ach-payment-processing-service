import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import { healthRoutes } from "./api/routes/health.js";
import { paymentRoutes } from "./api/routes/payments.js";
import { webhookRoutes } from "./api/routes/webhooks.js";
import { webhookStatusChangedPayloadSchema } from "./api/schemas/webhooks.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { PrismaPaymentRepository } from "./repositories/prisma-payment-repository.js";
import { PrismaWebhookSubscriptionRepository } from "./repositories/prisma-webhook-subscription-repository.js";
import { PaymentService } from "./services/payment-service.js";
import { WebhookSubscriptionService } from "./services/webhook-subscription-service.js";

export interface BuildAppOptions {
  logger?: boolean;
}

const paymentRepository = new PrismaPaymentRepository(prisma);
const paymentService = new PaymentService(paymentRepository);
const webhookSubscriptionService = new WebhookSubscriptionService(
  new PrismaWebhookSubscriptionRepository(prisma),
  env.NODE_ENV,
);

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "ACH Payment Processing Service",
        description: "API documentation for the ACH payment processing service.",
        version: "0.1.0",
      },
      components: {
        schemas: {
          PaymentStatusChangedWebhook: webhookStatusChangedPayloadSchema,
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  await app.register(healthRoutes);
  await app.register(paymentRoutes, { paymentService });
  await app.register(webhookRoutes, { webhookSubscriptionService });

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return app;
}
