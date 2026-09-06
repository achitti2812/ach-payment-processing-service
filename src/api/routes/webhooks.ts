import type { FastifyPluginAsync } from "fastify";

import {
  InvalidWebhookSubscriptionError,
  WebhookSubscriptionNotFoundError,
} from "../../domain/errors.js";
import type { WebhookSubscriptionService } from "../../services/webhook-subscription-service.js";
import {
  createWebhookSubscriptionSchema,
  listWebhookSubscriptionsSchema,
  updateWebhookSubscriptionSchema,
  type CreateWebhookSubscriptionBody,
  type UpdateWebhookSubscriptionBody,
  type WebhookCustomerParams,
  type WebhookSubscriptionParams,
} from "../schemas/webhooks.js";

interface WebhookRouteOptions {
  webhookSubscriptionService: WebhookSubscriptionService;
}

export const webhookRoutes: FastifyPluginAsync<WebhookRouteOptions> = async (
  app,
  options,
) => {
  app.post<{ Body: CreateWebhookSubscriptionBody }>(
    "/v1/webhooks/subscriptions",
    { schema: createWebhookSubscriptionSchema },
    async (request, reply) => {
      try {
        const subscription = await options.webhookSubscriptionService.create(request.body);
        return reply.code(201).send(subscription);
      } catch (error) {
        if (error instanceof InvalidWebhookSubscriptionError) {
          return reply.code(400).send({
            statusCode: 400,
            error: "Bad Request",
            message: error.message,
          });
        }

        throw error;
      }
    },
  );

  app.get<{ Params: WebhookCustomerParams }>(
    "/v1/webhooks/subscriptions/:customerId",
    { schema: listWebhookSubscriptionsSchema },
    async (request, reply) => {
      try {
        const subscriptions = await options.webhookSubscriptionService.listEnabled(
          request.params.customerId,
        );
        return reply.code(200).send({ subscriptions });
      } catch (error) {
        if (error instanceof InvalidWebhookSubscriptionError) {
          return reply.code(400).send({
            statusCode: 400,
            error: "Bad Request",
            message: error.message,
          });
        }

        throw error;
      }
    },
  );

  app.patch<{
    Params: WebhookSubscriptionParams;
    Body: UpdateWebhookSubscriptionBody;
  }>(
    "/v1/webhooks/subscriptions/:subscriptionId",
    { schema: updateWebhookSubscriptionSchema },
    async (request, reply) => {
      try {
        const subscription = await options.webhookSubscriptionService.setEnabled(
          request.params.subscriptionId,
          request.body.enabled,
        );
        return reply.code(200).send(subscription);
      } catch (error) {
        if (error instanceof WebhookSubscriptionNotFoundError) {
          return reply.code(404).send({
            statusCode: 404,
            error: "Not Found",
            message: error.message,
          });
        }

        throw error;
      }
    },
  );
};
