import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import {
  IdempotencyConflictError,
  InvalidPaymentRequestError,
} from "../../domain/errors.js";
import type { PaymentService } from "../../services/payment-service.js";
import {
  submitPaymentSchema,
  type SubmitPaymentBody,
  type SubmitPaymentHeaders,
} from "../schemas/payments.js";

interface PaymentRouteOptions {
  paymentService: PaymentService;
}

export const paymentRoutes: FastifyPluginAsync<PaymentRouteOptions> = async (
  app,
  options,
) => {
  app.post<{
    Body: SubmitPaymentBody;
    Headers: SubmitPaymentHeaders;
  }>(
    "/v1/payments",
    {
      schema: submitPaymentSchema,
    },
    async (request, reply) => {
      try {
        const result = await options.paymentService.submitPayment(
          request.body,
          request.headers["idempotency-key"],
          request.headers["x-correlation-id"] ?? randomUUID(),
        );

        return reply.code(result.replayed ? 200 : 202).send(result.payment);
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          return reply.code(409).send({
            statusCode: 409,
            error: "Conflict",
            message: error.message,
          });
        }

        if (error instanceof InvalidPaymentRequestError) {
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
};
