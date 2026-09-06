import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import {
  IdempotencyConflictError,
  InvalidPaymentRequestError,
  PaymentNotFoundError,
} from "../../domain/errors.js";
import type { PaymentService } from "../../services/payment-service.js";
import {
  getPaymentEventsSchema,
  getPaymentSchema,
  submitPaymentSchema,
  type PaymentParams,
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
  app.get<{ Params: PaymentParams }>(
    "/v1/payments/:paymentId",
    {
      schema: getPaymentSchema,
    },
    async (request, reply) => {
      try {
        const payment = await options.paymentService.getPayment(request.params.paymentId);
        return reply.code(200).send(payment);
      } catch (error) {
        if (error instanceof PaymentNotFoundError) {
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

  app.get<{ Params: PaymentParams }>(
    "/v1/payments/:paymentId/events",
    {
      schema: getPaymentEventsSchema,
    },
    async (request, reply) => {
      try {
        const history = await options.paymentService.getPaymentAuditHistory(
          request.params.paymentId,
        );
        return reply.code(200).send(history);
      } catch (error) {
        if (error instanceof PaymentNotFoundError) {
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
