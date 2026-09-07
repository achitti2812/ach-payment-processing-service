# API Design

The public API is intentionally small. It accepts payments, exposes their current state and ordered audit history, and manages webhook subscriptions. Processing, queue dispatch, and webhook delivery are internal worker concerns and do not add public endpoints.

When the API is running, the generated Swagger UI is available at `http://localhost:3000/docs`.

## Conventions

- Base URL for local development: `http://localhost:3000`
- Request and response media type: `application/json`
- Resource identifiers: UUID strings
- Timestamps: ISO 8601 UTC strings
- Amounts: decimal strings with at most two fractional digits on input and exactly two on output
- Unknown JSON properties are rejected by the request schemas
- Validation failures use Fastify's standard error shape:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Request validation failed"
}
```

Exact validation messages may be more specific. Clients should use the HTTP status as the stable contract rather than parsing the message text.

## Endpoint summary

| Method | Path | Purpose | Success | Client errors |
| --- | --- | --- | --- | --- |
| `GET` | `/health/live` | Confirm the API process is alive | `200` | — |
| `POST` | `/v1/payments` | Submit an idempotent payment | `202`; replay `200` | `400`, `409` |
| `GET` | `/v1/payments/:paymentId` | Read current payment state | `200` | `400`, `404` |
| `GET` | `/v1/payments/:paymentId/events` | Read ordered audit events | `200` | `400`, `404` |
| `POST` | `/v1/webhooks/subscriptions` | Register a webhook | `201` | `400` |
| `GET` | `/v1/webhooks/subscriptions/:customerId` | List enabled subscriptions | `200` | `400` |
| `PATCH` | `/v1/webhooks/subscriptions/:subscriptionId` | Enable or disable a subscription | `200` | `400`, `404` |

## Liveness

### `GET /health/live`

Response — `200 OK`:

```json
{
  "status": "ok"
}
```

This proves that the Fastify process can answer HTTP requests. It is not a deep PostgreSQL or Redis readiness check.

## Submit a payment

### `POST /v1/payments`

Required header:

```text
Idempotency-Key: payment-demo-1001
```

Request:

```json
{
  "customerId": "C12345",
  "sourceAccount": "VA10001",
  "destinationAccount": "EXT98765",
  "amount": "250.00",
  "reference": "SUCCESS-DEMO"
}
```

Validation rules:

- all five fields are required, trimmed, non-empty strings;
- identifiers and reference are limited to 255 characters;
- `amount` must be positive, contain at most two decimal places, and fit PostgreSQL `DECIMAL(18,2)`;
- `Idempotency-Key` must be non-empty after trimming and no longer than 255 characters.

New request response — `202 Accepted`:

```json
{
  "id": "1b882afa-019b-47f3-bd54-37c1cfe33929",
  "customerId": "C12345",
  "sourceAccount": "VA10001",
  "destinationAccount": "EXT98765",
  "amount": "250.00",
  "reference": "SUCCESS-DEMO",
  "status": "PENDING",
  "createdAt": "2026-09-06T12:00:00.000Z",
  "updatedAt": "2026-09-06T12:00:00.000Z"
}
```

The response means the request was durably accepted. It does not mean that bank execution is complete.

### Idempotency contract

The service normalizes the request before hashing it. String fields are trimmed, the decimal amount is represented with two fractional digits, and a fixed property order is serialized. SHA-256 is calculated over that canonical representation.

The idempotency namespace is `(customerId, Idempotency-Key)`:

- same scope and same normalized hash: return the original payment with `200 OK`;
- same scope and a different normalized hash: return `409 Conflict`;
- a different customer may independently use the same key.

For example, `"250"`, `"250.0"`, and `"250.00"` describe the same normalized amount. Concurrent submissions are resolved by the database uniqueness constraint, not by an in-memory lock.

Conflict response — `409 Conflict`:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "Idempotency key has already been used with a different request"
}
```

## Retrieve a payment

### `GET /v1/payments/:paymentId`

Response — `200 OK`:

```json
{
  "id": "1b882afa-019b-47f3-bd54-37c1cfe33929",
  "customerId": "C12345",
  "sourceAccount": "VA10001",
  "destinationAccount": "EXT98765",
  "amount": "250.00",
  "reference": "SUCCESS-DEMO",
  "status": "COMPLETED",
  "attemptCount": 1,
  "maxAttempts": 5,
  "failureCode": null,
  "failureMessage": null,
  "createdAt": "2026-09-06T12:00:00.000Z",
  "updatedAt": "2026-09-06T12:00:01.000Z",
  "completedAt": "2026-09-06T12:00:01.000Z"
}
```

Internal queue, outbox, request-hash, and webhook data are not part of this response. A malformed UUID returns `400 Bad Request`; a valid unknown UUID returns `404 Not Found`.

## Retrieve audit history

### `GET /v1/payments/:paymentId/events`

Response — `200 OK`:

```json
{
  "paymentId": "1b882afa-019b-47f3-bd54-37c1cfe33929",
  "events": [
    {
      "id": "70fd69e8-5236-4af9-9fa0-4e997a865e66",
      "sequenceNumber": 1,
      "fromStatus": null,
      "toStatus": "PENDING",
      "reason": "Payment submitted",
      "actor": "api",
      "correlationId": "c604d11f-93aa-43f8-a38d-b0ed5d50ff28",
      "createdAt": "2026-09-06T12:00:00.000Z"
    },
    {
      "id": "fbf93036-c327-4527-aad4-eb7f08fa6423",
      "sequenceNumber": 2,
      "fromStatus": "PENDING",
      "toStatus": "PROCESSING",
      "reason": "Payment processing started",
      "actor": "payment-worker",
      "correlationId": "c604d11f-93aa-43f8-a38d-b0ed5d50ff28",
      "createdAt": "2026-09-06T12:00:00.500Z"
    }
  ]
}
```

Events are sorted by `sequenceNumber` ascending. Metadata and account details are deliberately omitted. A malformed UUID returns `400`; a valid unknown payment returns `404`.

## Webhook subscriptions

### `POST /v1/webhooks/subscriptions`

Request:

```json
{
  "customerId": "C12345",
  "url": "https://example.test/hooks/payments",
  "signingSecret": "replace-with-a-long-random-secret"
}
```

Response — `201 Created`:

```json
{
  "id": "fa9cd600-49b7-4103-93af-64c32e258bfa",
  "customerId": "C12345",
  "url": "https://example.test/hooks/payments",
  "enabled": true,
  "createdAt": "2026-09-06T12:00:00.000Z",
  "updatedAt": "2026-09-06T12:00:00.000Z"
}
```

The signing secret must be between 16 and 1024 characters and is never returned. HTTPS is required except that loopback HTTP URLs such as `http://localhost:4000/success` and `http://127.0.0.1:4000/success` are accepted outside production. URLs containing credentials are rejected.

### `GET /v1/webhooks/subscriptions/:customerId`

Response — `200 OK`:

```json
{
  "subscriptions": [
    {
      "id": "fa9cd600-49b7-4103-93af-64c32e258bfa",
      "customerId": "C12345",
      "url": "https://example.test/hooks/payments",
      "enabled": true,
      "createdAt": "2026-09-06T12:00:00.000Z",
      "updatedAt": "2026-09-06T12:00:00.000Z"
    }
  ]
}
```

Only enabled subscriptions are listed. A customer with none receives an empty `subscriptions` array. The signing secret is never present.

### `PATCH /v1/webhooks/subscriptions/:subscriptionId`

Request:

```json
{
  "enabled": false
}
```

Response — `200 OK`:

```json
{
  "id": "fa9cd600-49b7-4103-93af-64c32e258bfa",
  "customerId": "C12345",
  "url": "https://example.test/hooks/payments",
  "enabled": false,
  "createdAt": "2026-09-06T12:00:00.000Z",
  "updatedAt": "2026-09-06T12:05:00.000Z"
}
```

A malformed subscription UUID returns `400`; an unknown UUID returns `404`.

## Outgoing webhook contract

For each payment status transition and enabled subscription, the service sends:

```json
{
  "eventId": "70fd69e8-5236-4af9-9fa0-4e997a865e66",
  "eventType": "payment.status_changed",
  "paymentId": "1b882afa-019b-47f3-bd54-37c1cfe33929",
  "customerId": "C12345",
  "fromStatus": "PROCESSING",
  "toStatus": "COMPLETED",
  "reason": "Payment completed",
  "occurredAt": "2026-09-06T12:00:01.000Z"
}
```

The service creates this object in the property order shown, serializes it once with `JSON.stringify`, and sends those exact UTF-8 bytes. It calculates:

```text
signatureHex = HMAC-SHA256(signingSecret, exactRawRequestBody)
```

Headers:

```text
Content-Type: application/json
X-Webhook-Signature: <lowercase hexadecimal digest>
X-Webhook-Event-Id: <PaymentEvent UUID>
X-Webhook-Timestamp: <ISO-8601 delivery-attempt time>
```

Receivers must calculate HMAC over the raw bytes they received, before parsing or reserializing the JSON, and compare signatures with a timing-safe comparison. The timestamp header records the attempt time but is not currently included in the signed material.

Any `2xx` response is success. Redirects, `4xx`, `5xx`, network errors, and timeouts are failures. Failures are retried using bounded exponential backoff and never alter payment state.

## OpenAPI consistency

Route-level JSON schemas drive validation and Swagger documentation. Swagger describes only safe public fields: it does not expose signing secrets, idempotency hashes, bank execution IDs, outbox payloads, or internal webhook delivery records.
