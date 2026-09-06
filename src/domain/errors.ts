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
