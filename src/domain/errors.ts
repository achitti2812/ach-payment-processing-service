export class InvalidPaymentRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPaymentRequestError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key has already been used with a different request payload");
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyKeyAlreadyExistsError extends Error {
  constructor(options?: ErrorOptions) {
    super("The idempotency key was created by a concurrent request", options);
    this.name = "IdempotencyKeyAlreadyExistsError";
  }
}

export class PaymentNotFoundError extends Error {
  constructor() {
    super("Payment not found");
    this.name = "PaymentNotFoundError";
  }
}

export class InvalidPaymentStateTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid payment state transition: ${from} -> ${to}`);
    this.name = "InvalidPaymentStateTransitionError";
  }
}

export class InvalidWebhookSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWebhookSubscriptionError";
  }
}

export class WebhookSubscriptionNotFoundError extends Error {
  constructor() {
    super("Webhook subscription not found");
    this.name = "WebhookSubscriptionNotFoundError";
  }
}
