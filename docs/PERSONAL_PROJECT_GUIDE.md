# Personal Project Guide: ACH Payment Processing Service

> This is a personal study guide, not a formal assignment deliverable. It explains the project in deliberately simple language so you can understand it, run it, and talk about it confidently.

## 1. What problem are we solving?

ACH is a common way to move money between bank accounts in the United States. This project accepts an instruction to make that kind of payment.

Imagine this request:

> Customer A wants to move $250 from account X to account Y.

The customer sends our API the customer ID, the two account identifiers, the amount, and a reference. Our service safely records the request, arranges for it to be processed, tells the customer its current status, and keeps a history of everything that happened.

Why not make the POST endpoint call the bank and wait?

- A bank can be slow or temporarily unavailable.
- The customer's HTTP connection can time out even though the bank is still working.
- A client may resend the request and accidentally cause a second payment.
- A busy period could tie up every API connection with slow bank calls.
- Retrying and recovery are easier when work is stored and handled separately.

Instead, the API does the small, reliable part first: it validates and saves a `PENDING` payment. A background worker performs the bank call later. That is what “asynchronous processing” means here.

## 2. Every technology in simple words

### Node.js

**What it is:** Node.js runs JavaScript outside a browser.

**Why we use it:** It runs the API, dispatcher, payment worker, webhook worker, and test receiver.

**Without it:** Our TypeScript would have no runtime after it is compiled to JavaScript. We would need a different runtime and probably another programming language.

Think of Node.js as the engine that runs the application.

### TypeScript

**What it is:** TypeScript is JavaScript with compile-time types.

**Why we use it:** It catches mistakes such as passing a webhook job where a payment job is expected. It also makes interfaces between routes, services, repositories, and the bank adapter clear.

**Without it:** The service could still use JavaScript, but more mistakes would appear only while it was running.

The technically correct detail is that TypeScript checks the program and compiles it to JavaScript. Its types do not exist at runtime, so Fastify schemas still validate real HTTP input.

### Fastify

**What it is:** Fastify is the web framework.

**Why we use it:** It listens for HTTP requests, matches routes, validates inputs, sends responses, and generates OpenAPI documentation from route schemas.

**Without it:** We would have to write low-level HTTP parsing, routing, error handling, and validation ourselves or choose another framework.

Think of Fastify as the reception desk for the service.

### PostgreSQL

**What it is:** PostgreSQL is the relational database and durable source of truth.

**Why we use it:** It stores payments, idempotency keys, audit events, outbox events, subscriptions, and delivery attempts. Transactions and unique constraints give us strong safety guarantees.

**Without it:** Redis alone would not be an appropriate payment ledger. We would lose the relational constraints, transactions, and durable queryable history this design relies on.

Think of PostgreSQL as the official record book.

### Prisma

**What it is:** Prisma is the database toolkit and ORM used by the TypeScript code.

**Why we use it:** `schema.prisma` defines the models, migrations create the database objects, and the generated Prisma Client gives type-safe database queries.

**Without it:** We could use raw SQL or another database library, but we would write more mapping and type code ourselves.

Prisma is the translator between our TypeScript objects and PostgreSQL tables. PostgreSQL is still the actual database.

### Redis

**What it is:** Redis is a fast in-memory data server that can also persist data.

**Why we use it:** BullMQ stores its queues, delayed jobs, and worker coordination in Redis.

**Without it:** BullMQ would not work. We would need another message broker or a database-only job mechanism.

Redis is the conveyor belt, not the official payment record.

### BullMQ

**What it is:** BullMQ is a Node.js queue library built on Redis.

**Why we use it:** It moves payment and webhook jobs to workers and can hold delayed retry jobs until their due time.

**Without it:** We would need to build queue claiming, delay timing, and worker delivery ourselves or use another broker.

Think of a BullMQ job as a work ticket on the conveyor belt.

### Docker and Docker Compose

**What they are:** Docker runs software in isolated containers. Docker Compose starts a group of related containers from one file.

**Why we use them:** Reviewers can start the expected PostgreSQL and Redis versions without installing and configuring those servers directly on their computers.

**Without them:** Every developer would need compatible local database and Redis installations and matching configuration.

The Node processes run on the Mac in this setup. PostgreSQL and Redis run in containers.

### Vitest

**What it is:** Vitest is the automated test runner.

**Why we use it:** It runs fast unit tests and infrastructure-backed integration tests with a consistent API.

**Without it:** We could use another test runner, but without automated tests it would be much harder to trust concurrency, retries, and failure paths.

### Swagger and OpenAPI

**What they are:** OpenAPI is a machine-readable HTTP API description. Swagger UI turns it into an interactive web page.

**Why we use them:** A reviewer can see and try every public endpoint at `/docs`.

**Without them:** Consumers would depend only on prose or source code, which is easier to misunderstand and harder to test interactively.

## 3. Project folder structure

Here are the important areas and what each one owns:

```text
src/
  api/             HTTP routes and schemas
  bank/            bank interface and local simulator
  config/          environment, Prisma, and Redis setup
  domain/          business types, validation helpers, and state rules
  queues/          BullMQ queue names, job shapes, and publishers
  repositories/    persistence interfaces and Prisma implementations
  services/        application workflows and policies
  webhooks/        outgoing HTTP client
  workers/         long-running queue/dispatcher process entry points
  dev/             development-only webhook receiver
  generated/       generated Prisma Client; not committed
prisma/             database schema and migrations
tests/              unit and integration tests
docs/               reviewer docs and this learning guide
```

Important files:

- `src/index.ts` starts the API.
- `src/app.ts` assembles Fastify, Swagger, routes, and dependencies.
- `src/api/routes/payments.ts` handles payment HTTP routes.
- `src/api/schemas/payments.ts` describes and validates payment HTTP data.
- `src/api/routes/webhooks.ts` handles subscription routes.
- `src/api/schemas/webhooks.ts` validates subscription data.
- `src/services/payment-service.ts` implements submission idempotency and read responses.
- `src/services/payment-processor.ts` claims attempts and handles bank outcomes.
- `src/services/outbox-dispatcher.ts` publishes payment outbox work.
- `src/services/webhook-event-materializer.ts` creates deliveries from payment events.
- `src/services/webhook-delivery-processor.ts` signs, sends, and records webhooks.
- `src/repositories/prisma-payment-repository.ts` persists submission and read data.
- `src/repositories/prisma-payment-processing-repository.ts` owns atomic payment claims/transitions.
- `src/bank/simulated-bank-client.ts` produces deterministic bank results.
- `src/queues/payment-queue.ts` and `src/queues/webhook-queue.ts` define queue jobs.
- `src/workers/outbox-dispatcher.ts`, `payment-worker.ts`, and `webhook-worker.ts` start the background processes.
- `src/dev/webhook-receiver.ts` is a local test endpoint.
- `prisma/schema.prisma` is the database blueprint.

The interfaces in `src/repositories/` and `src/bank/bank-client.ts` let the core services be tested without always using a real database, Redis instance, or HTTP endpoint.

## 4. The database from zero

These terms are related, but they are not the same:

- **PostgreSQL** is the actual running database server.
- **Prisma** is the tool our code uses to describe and access PostgreSQL.
- **`prisma/schema.prisma`** is the blueprint for tables, fields, relationships, indexes, and enums.
- **A migration** is versioned SQL/history that creates or changes the database structure.
- **Prisma Client** is generated TypeScript code used to query those tables.

### `Payment`

This is the current snapshot of a payment.

Example in plain English:

```text
id: 1111...
customerId: C12345
from: VA10001
to: EXT98765
amount: 250.00
reference: SUCCESS-DEMO
status: COMPLETED
attemptCount: 1
maxAttempts: 5
```

The amount uses `DECIMAL(18,2)`, not a floating-point number. That avoids binary rounding mistakes in money. `attemptCount` says how many bank attempts workers actually claimed.

### `IdempotencyRecord`

This remembers which request was accepted for a customer and idempotency key.

```text
customerId: C12345
idempotencyKey: demo-payment-1
requestHash: SHA-256 of the normalized request
paymentId: 1111...
```

The database only allows one `(customerId, idempotencyKey)` pair. That remains true even if two API processes race.

### `PaymentEvent`

This is one line in the audit history.

```text
paymentId: 1111...
sequenceNumber: 3
fromStatus: PROCESSING
toStatus: COMPLETED
reason: Payment completed
actor: payment-worker
```

Each payment has unique sequence numbers, so its story has one unambiguous order.

### `OutboxEvent`

This is durable “work still needs to be sent” data.

```text
type: PAYMENT_PROCESS_REQUESTED
aggregateId: 1111...
payload: { paymentId: 1111... }
publishedAt: null
publishAttempts: 0
```

`publishedAt: null` means the dispatcher has not successfully sent the work yet. An outbox row is stored in PostgreSQL, so a Redis problem does not erase the intent.

### `WebhookSubscription`

This says where a customer wants status notifications.

```text
customerId: C12345
url: http://localhost:4000/success
signingSecret: stored internally, never returned
enabled: true
```

One customer can have more than one subscription.

### `WebhookDelivery`

This tracks sending one payment event to one subscription.

```text
subscriptionId: 2222...
paymentEventId: 3333...
status: DELIVERED
attemptCount: 1
lastHttpStatus: 200
deliveredAt: 2026-09-06T12:00:02Z
```

The pair `(subscriptionId, paymentEventId)` is unique. Repeating fan-out cannot create two logical deliveries for the same event and destination.

## 5. One successful payment from beginning to end

Use `reference: "SUCCESS-DEMO"`.

1. **The client sends `POST /v1/payments`.** `src/api/routes/payments.ts` receives it. `src/api/schemas/payments.ts` checks the body, header, lengths, and format.
2. **The service normalizes it.** `src/services/payment-service.ts` calls helpers in `src/domain/payment.ts`. Whitespace is trimmed and `250`, `250.0`, and `250.00` become the same decimal value.
3. **The service checks idempotency.** It hashes the canonical request with SHA-256 and looks up the customer/key pair.
4. **One database transaction saves four records.** `src/repositories/prisma-payment-repository.ts` creates the `Payment`, `IdempotencyRecord`, initial `PaymentEvent`, and `PAYMENT_PROCESS_REQUESTED` `OutboxEvent` together.
5. **The API returns `202` with `PENDING`.** The payment is safely accepted, but no bank call has happened yet.
6. **The outbox dispatcher finds the row.** `src/workers/outbox-dispatcher.ts` repeatedly calls the dispatcher services. `src/services/outbox-dispatcher.ts` publishes a job.
7. **BullMQ carries the job.** `src/queues/payment-queue.ts` puts `{ paymentId }` on the `payment-processing` queue.
8. **The payment worker receives it.** `src/workers/payment-worker.ts` wires the queue worker to `PaymentProcessor`.
9. **The attempt is claimed.** `src/repositories/prisma-payment-processing-repository.ts` conditionally changes `PENDING` to `PROCESSING`, increments `attemptCount` to 1, and writes an audit event in one transaction.
10. **The bank adapter is called.** `src/services/payment-processor.ts` calls the interface from `src/bank/bank-client.ts`. `src/bank/simulated-bank-client.ts` sees `SUCCESS` and returns success.
11. **The payment completes.** The repository changes `PROCESSING` to `COMPLETED`, stores the bank execution ID and `completedAt`, and writes the next audit event.
12. **Webhook intent follows every event.** Creating each `PaymentEvent` also creates a webhook-materialization outbox event.
13. **The dispatcher materializes deliveries.** `src/services/webhook-event-materializer.ts` finds enabled subscriptions and creates one `WebhookDelivery` plus delivery outbox work for each.
14. **The webhook job is published.** `src/services/webhook-job-outbox-dispatcher.ts` sends the delivery identifier to `webhook-delivery`.
15. **The webhook worker sends it.** `src/services/webhook-delivery-processor.ts` loads the event/payment/subscription data, creates the safe payload, signs the exact JSON, and uses `src/webhooks/webhook-http-client.ts` to POST it.
16. **The result is recorded.** A `2xx` response changes the delivery to `DELIVERED`. Payment processing never waits for this and is not reversed if the webhook fails.

The same general webhook path happens for `PENDING`, `PROCESSING`, and `COMPLETED`, so a subscriber receives each status change.

## 6. Walk through `TEMP_FAIL_ONCE`

Suppose the reference contains `TEMP_FAIL_ONCE`.

1. The first claim changes `PENDING -> PROCESSING` and `attemptCount` becomes 1.
2. `SimulatedBankClient` uses the reference and attempt number. On attempt 1 it returns a temporary failure.
3. `PaymentProcessor` calculates the delay:

   ```text
   PAYMENT_RETRY_BASE_DELAY_MS * 2^(1 - 1)
   ```

   With a 1000 ms base, that is 1000 ms.
4. The repository changes `PROCESSING -> RETRYING`, stores `nextRetryAt`, writes an audit event, and creates a `PAYMENT_RETRY_REQUESTED` outbox event in one transaction.
5. The outbox dispatcher creates a delayed BullMQ job for attempt 2.
6. Before `nextRetryAt`, a worker is not allowed to claim it. If the job arrives early, the worker moves the job back to the correct delayed time.
7. At the due time, the repository changes `RETRYING -> PROCESSING`, clears `nextRetryAt`, and increments `attemptCount` to 2.
8. The simulator succeeds on attempt 2.
9. The repository changes `PROCESSING -> COMPLETED` and clears retry-related timing state.

The visible history is:

```text
null -> PENDING
PENDING -> PROCESSING
PROCESSING -> RETRYING
RETRYING -> PROCESSING
PROCESSING -> COMPLETED
```

## 7. Walk through `TEMP_FAIL` exhaustion

`TEMP_FAIL` fails temporarily every time. With `maxAttempts = 5`:

```text
attempt 1 -> temporary failure -> RETRYING
attempt 2 -> temporary failure -> RETRYING
attempt 3 -> temporary failure -> RETRYING
attempt 4 -> temporary failure -> RETRYING
attempt 5 -> temporary failure -> FAILED
```

There is no attempt 6. `maxAttempts` includes the original attempt.

At attempt 5, `PaymentProcessor` recognizes that the limit has been reached. It changes the payment from `PROCESSING` to `FAILED`, sets `failureCode` to `RETRY_EXHAUSTED`, stores a useful final message, and clears `nextRetryAt`.

The first four retry delays with a 1000 ms base are 1, 2, 4, and 8 seconds. A delayed job exists only for the next permitted attempt.

## 8. Idempotency, deeply but simply

Idempotency means a repeated request has the same logical effect as sending it once.

This is essential for payments. A mobile app may submit a $250 payment, lose its connection before seeing the response, and try again. We want to return the existing payment, not move another $250.

Example:

```text
Customer: C12345
Idempotency-Key: checkout-900
Amount: 250.00
```

- Sending that request twice returns the same payment.
- Sending the same customer/key with amount `300.00` returns `409 Conflict`.
- Another customer may use `checkout-900`; the key is customer-scoped.

The important layers are:

1. **Normalization:** trim strings and make equivalent money strings canonical.
2. **Request hash:** SHA-256 creates a fixed fingerprint of the normalized fields.
3. **Database record:** the key, hash, and original payment ID are remembered.
4. **Unique constraint:** only one row can exist for a customer/key, even under concurrency.
5. **Conflict handling:** if another request wins the race, the loser loads the winning record and compares hashes.
6. **Downstream execution key:** every bank call uses `payment-<paymentId>`, giving a real bank integration a stable key for its own idempotency.

Short interview answer:

> I require a customer-scoped idempotency key, normalize the request, and store a SHA-256 request hash with the payment. A database unique constraint resolves concurrent submissions. The same key and hash returns the original payment; the same key with different data returns 409. Workers also use conditional database claims, deterministic job IDs, and a stable bank execution key so duplicate queue delivery does not mean duplicate execution.

## 9. Transactional outbox, deeply but simply

### Naive-person explanation

Imagine writing “make this payment” in the official book and then putting a task card on a conveyor belt. If the application crashes between those actions, the payment is in the book but no worker knows about it.

The outbox is a “task card still needs sending” page inside the same official book. Saving the payment and that page is one all-or-nothing action. Another process can send the card later.

### Engineer explanation

PostgreSQL commit and Redis publication are a dual write. They cannot share the ordinary PostgreSQL transaction. The API therefore commits business state and an `OutboxEvent` atomically. A dispatcher polls unpublished outbox rows, publishes deterministic BullMQ jobs, and sets `publishedAt` only after success. Failures retain the row and record `publishAttempts` and `lastError`.

At-least-once publication means duplicates remain possible. Deterministic queue IDs plus database-level conditional claims make consumers idempotent.

### 30-second interview explanation

> I used a transactional outbox to avoid losing work between PostgreSQL and Redis. The payment, audit event, and outbox intent commit in one database transaction. A separate dispatcher publishes that intent to BullMQ and only then marks it published. Publication can be retried, and deterministic job IDs and conditional worker claims make duplicates safe.

## 10. Redis and BullMQ clearly

- A **queue** is a named line of work. This project has `payment-processing` and `webhook-delivery`.
- A **job** is one work item and a small payload, such as `{ paymentId }`.
- A **delayed job** stays in Redis until a future time.
- A **job ID** identifies logical queue work and helps BullMQ reject duplicates while that ID is retained.
- A **worker** listens to a queue and executes jobs.
- **Concurrency** is how many jobs a worker process may handle at once.

Redis/BullMQ does not decide whether a payment is `RETRYING` or complete. PostgreSQL does. A worker treats a queue job as a request to inspect and conditionally claim current database state.

If a duplicate job appears, the database claim asks questions such as:

- Is the payment in the expected state?
- Is this the expected attempt number?
- Is the retry due?
- Is the payment already terminal?

Only one matching worker can update and claim the row. Others skip. This matters because no real distributed queue should be assumed to deliver every logical message exactly once forever.

## 11. The workers

### Outbox dispatcher

Started by `npm run worker:outbox`, implemented by `src/workers/outbox-dispatcher.ts`.

It continuously polls PostgreSQL for:

- new payment work;
- payment retry work;
- payment events that need webhook delivery rows;
- webhook delivery jobs.

It publishes or materializes them and records success/failure. It does not call the bank or customer endpoint.

### Payment worker

Started by `npm run worker:payment`, assembled in `src/workers/payment-worker.ts` and `src/workers/create-payment-worker.ts`.

It listens to `payment-processing`, asks `PaymentProcessor` to claim a payment attempt, calls the bank adapter, and stores the resulting transition. It also moves genuinely early retry jobs back to their due time.

### Webhook worker

Started by `npm run worker:webhook`, assembled in `src/workers/webhook-worker.ts` and `src/workers/create-webhook-worker.ts`.

It listens to `webhook-delivery`, conditionally claims one HTTP attempt, builds and signs the payload, sends it, then records success or schedules another attempt.

They run separately from the API so slow or failing external calls do not consume API request capacity. They can also be restarted and scaled independently.

## 12. The simulated bank

There is no real banking partner in this assignment. `src/bank/bank-client.ts` defines the interface a real adapter would implement. `src/bank/simulated-bank-client.ts` implements it for local development and tests.

The reference controls a repeatable result:

| Reference marker | Simulator behavior |
| --- | --- |
| `SUCCESS` | Succeeds immediately |
| `PERM_FAIL` | Permanently fails immediately |
| `TEMP_FAIL` | Temporarily fails on every attempt |
| `TEMP_FAIL_ONCE` | Fails attempt 1, succeeds attempt 2 |
| `TEMP_FAIL_TWICE` | Fails attempts 1 and 2, succeeds attempt 3 |

These markers are test controls. A production system would never decide a bank result from a payment reference. A real adapter would call a partner API, authenticate, use timeouts, pass the stable execution key, and translate partner responses into success, permanent failure, or temporary failure.

Deterministic behavior is valuable because the same input always follows the same branch, so tests do not fail randomly.

## 13. Payment states

- **`PENDING`:** saved and waiting for its first processing attempt.
- **`PROCESSING`:** a worker has claimed a bank attempt.
- **`RETRYING`:** the last attempt had a temporary problem and the next one has a due time.
- **`COMPLETED`:** the simulated bank accepted/executed it.
- **`FAILED`:** a permanent error occurred or temporary retries were exhausted.

Allowed transitions:

```text
PENDING -> PROCESSING
RETRYING -> PROCESSING
PROCESSING -> COMPLETED
PROCESSING -> FAILED
PROCESSING -> RETRYING
```

`COMPLETED` and `FAILED` are terminal. The state machine in `src/domain/payment-state-machine.ts` rejects transitions that do not make sense. This prevents bugs such as completing a payment that nobody claimed or retrying one that is already completed.

## 14. Auditability

Auditability means being able to answer: “What happened, in what order, why, and which component did it?”

`PaymentEvent` records every transition. `sequenceNumber` gives each payment a strict local order:

```text
1: null -> PENDING
2: PENDING -> PROCESSING
3: PROCESSING -> RETRYING
4: RETRYING -> PROCESSING
5: PROCESSING -> COMPLETED
```

Each event also has a reason, actor, correlation ID, and timestamp. The payment update and event insert happen in the same database transaction, so the current status cannot change without its corresponding history row.

Financial systems care because support, operations, customers, auditors, and engineers may all need to reconstruct a payment's path. The public audit API returns useful transition fields but deliberately excludes account data and internal metadata.

## 15. Webhooks from zero

A webhook is an HTTP request one system sends to another when something happens.

The simple analogy is:

> Instead of the customer repeatedly asking “Is my payment done?”, our system calls the URL they gave us when the status changes.

The pieces are:

- A **subscription** connects a customer to a webhook URL and secret.
- A **payment event** is the change that should be reported.
- A **`WebhookDelivery`** tracks sending one event to one subscription.
- The **webhook queue** carries delivery work.
- The **webhook worker** performs the HTTP request.
- The **payload** is the safe JSON event body.
- **Retries** give a temporarily unavailable customer endpoint another chance.

The flow is:

```text
PaymentEvent saved
-> webhook materialization outbox
-> one WebhookDelivery per enabled subscription
-> webhook delivery outbox
-> BullMQ job
-> webhook worker
-> customer URL
```

The payload includes payment/customer/event IDs, old and new status, reason, and event time. It excludes account identifiers, signing secrets, outbox fields, and internal metadata.

Webhook delivery is isolated from payment processing. A payment may correctly become `COMPLETED` even while the customer's server is returning `500`. The webhook delivery retries and records its own status; it never changes the payment.

## 16. HMAC signing

### Simple explanation

The customer gives us a private shared secret when registering a webhook. Before sending JSON, we combine that secret with the exact message to make a special fingerprint. The customer makes the fingerprint again. Matching fingerprints mean the sender knew the secret and the message was not changed on the way.

We send the fingerprint, but we never send the secret itself.

### Technical explanation

The service creates the payload in a stable property order and serializes it once with `JSON.stringify`. It calculates:

```text
HMAC-SHA256(signingSecret, exact UTF-8 raw JSON body)
```

The lowercase hexadecimal result goes in `X-Webhook-Signature`. `X-Webhook-Event-Id` identifies the event and `X-Webhook-Timestamp` records when that delivery attempt was made.

The receiver must calculate HMAC over the exact raw body bytes before parsing or reserializing JSON. Changing whitespace or property order creates different bytes and therefore a different signature. `verifyWebhookSignature` in `src/domain/webhook.ts` uses a timing-safe comparison.

HMAC provides integrity and shared-secret authentication. HTTPS is still required in production because it also protects the request in transit. The current timestamp is not part of the signed material; signing timestamp plus body and enforcing a tolerance window would strengthen replay protection in production.

## 17. Concurrency and race conditions

A race condition happens when two pieces of work read the same old state and both try to act before either sees the other's update.

### Two duplicate API submissions

Both might initially see no idempotency record. The database unique constraint allows only one `(customerId, idempotencyKey)` winner. The losing request reloads that row: it returns the original payment if hashes match, or `409` if they differ.

### Two payment workers

Both may receive jobs for the same attempt. The repository performs a conditional database update. Only one can change the expected state/attempt and increment `attemptCount`; only that worker calls the bank. The other gets `SKIPPED`.

### Two webhook workers

They use the same pattern. Only one worker can claim the expected delivery attempt. The other cannot make an HTTP call for that logical attempt.

### Two outbox dispatchers

The same outbox intent can potentially be published more than once. Deterministic job IDs suppress duplicate logical queue work while jobs are retained, and the final consumer claim checks PostgreSQL. Webhook materialization also has the unique `(subscriptionId, paymentEventId)` constraint.

These layers do not pretend that distributed delivery is magically “exactly once.” They make repeated delivery safe through idempotency and atomic database conditions.

## 18. Failure scenarios

| Scenario | What happens | Why it is safe |
| --- | --- | --- |
| Duplicate API request | Same data returns original; changed data returns `409` | Customer/key uniqueness plus request hash |
| Bank temporary failure | Payment becomes `RETRYING` and a delayed attempt is created | State, due time, audit, and retry intent commit together |
| Bank permanent failure | Payment becomes terminal `FAILED` immediately | Permanent problems are not retried |
| Redis publication failure | Outbox stays unpublished; attempt/error are recorded | Durable PostgreSQL intent is not lost |
| Duplicate queue job | Extra worker claim is skipped | Expected state and attempt are checked atomically |
| Webhook returns `500` | Delivery becomes `RETRYING` or final `FAILED` | Payment status is independent |
| Webhook times out | Same as another transient webhook failure | Timeout is bounded and recorded |
| Subscription is disabled | No new delivery is materialized; existing work is stopped without sending | Enabled state is checked at fan-out and claim time |
| Payment retry exhaustion | Final allowed temporary failure becomes `FAILED` with `RETRY_EXHAUSTED` | `attemptCount` cannot exceed `maxAttempts` |
| Invalid payment transition | State machine/repository rejects it | Only defined lifecycle changes are permitted |

### Known crash-after-claim limitation

There is one important take-home tradeoff: a process could crash after it changes a record to `PROCESSING` but before it stores the external result. Conditional claiming prevents two live workers from claiming the same attempt, but there is no claim lease and reconciliation job to recover an indefinitely stuck claim.

A production design would add claim timestamps/lease expiry plus a reconciliation or reaper process. The bank execution key must remain stable so recovery can safely ask or retry the downstream operation. This is a known next step, not a reason the demonstrated outbox and duplicate protections are invalid.

## 19. Every public API

The full contract is in `docs/api-design.md` and Swagger at `http://localhost:3000/docs`.

### Check liveness

```bash
curl http://localhost:3000/health/live
```

```json
{ "status": "ok" }
```

Status: `200`.

### Submit a payment

```bash
curl -i -X POST http://localhost:3000/v1/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: study-payment-1' \
  -d '{
    "customerId":"C12345",
    "sourceAccount":"VA10001",
    "destinationAccount":"EXT98765",
    "amount":"250.00",
    "reference":"SUCCESS-DEMO"
  }'
```

The response has the public payment fields and initially says `PENDING`. New work returns `202`; an identical replay returns `200`; invalid input returns `400`; key reuse with different data returns `409`.

### Retrieve payment status

```bash
PAYMENT_ID='replace-with-returned-payment-uuid'
curl "http://localhost:3000/v1/payments/$PAYMENT_ID"
```

The response contains status, attempt counts, client-facing failure information, and timestamps. Malformed UUID: `400`. Unknown valid UUID: `404`.

### Retrieve payment audit history

```bash
PAYMENT_ID='replace-with-returned-payment-uuid'
curl "http://localhost:3000/v1/payments/$PAYMENT_ID/events"
```

The `events` array is ordered by `sequenceNumber`. It never includes source/destination accounts or internal event metadata. Malformed UUID: `400`. Unknown: `404`.

### Create a webhook subscription

```bash
curl -i -X POST http://localhost:3000/v1/webhooks/subscriptions \
  -H 'Content-Type: application/json' \
  -d '{
    "customerId":"C12345",
    "url":"http://localhost:4000/success",
    "signingSecret":"local-webhook-secret"
  }'
```

The response returns `201` with ID, customer, URL, enabled state, and timestamps. It never returns the secret. Invalid URL/secret/customer data returns `400`.

### List active subscriptions

```bash
curl http://localhost:3000/v1/webhooks/subscriptions/C12345
```

Returns `{ "subscriptions": [...] }`. Only enabled subscriptions appear. No subscriptions is a successful empty list.

### Enable or disable a subscription

```bash
SUBSCRIPTION_ID='replace-with-returned-subscription-uuid'
curl -X PATCH "http://localhost:3000/v1/webhooks/subscriptions/$SUBSCRIPTION_ID" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
```

Returns the safe updated subscription. Invalid input returns `400`; an unknown valid ID returns `404`.

## 20. Tests

A **unit test** checks a small piece in isolation, often with fake dependencies. It is fast and makes edge cases easy to describe. Examples include state transitions, retry-delay math, bank simulation, and HMAC signatures.

An **integration test** checks multiple real parts together. This project uses Fastify injection for HTTP behavior and focused PostgreSQL/Redis/BullMQ tests for persistence, outbox, concurrency, and workers.

The 124-test suite protects these groups:

- payment input validation and exact public responses;
- normalized idempotency, conflict behavior, rollback, and concurrent submission;
- retrieval, UUID handling, and ordered/safe audit history;
- payment job publication and processing outcomes;
- backoff, delayed retries, stale/early jobs, attempt limits, and exhaustion;
- concurrent worker claims and terminal-state protection;
- outbox success/failure recording and duplicate handling;
- webhook subscription validation and enable/disable behavior;
- webhook fan-out, exact safe payloads, HMAC signing, HTTP outcomes, retry, and concurrency;
- assurance that webhook failures never alter payment state.

Run everything with:

```bash
npm test
```

Tests reduce risk, but they do not prove that no bug exists. They are especially useful here because failure and concurrency behavior is hard to verify reliably by clicking around manually.

## 21. Docker

PostgreSQL and Redis run in containers so everyone gets predictable service versions and ports.

Start them in the background:

```bash
docker compose up -d
```

See their current status:

```bash
docker compose ps
```

Stop and remove the running containers/network:

```bash
docker compose down
```

Stopping the API with `Ctrl+C` only stops that Node.js process. It does not stop PostgreSQL or Redis. Likewise, `docker compose down` stops the infrastructure but does not automatically stop Node processes already running in other terminals; those processes will begin reporting connection errors until infrastructure returns.

The Compose file uses a named PostgreSQL volume, so normal container recreation does not automatically discard database contents.

## 22. Run the whole project manually

First-time setup:

```bash
npm install
cp .env.example .env
docker compose up -d
npm run prisma:generate
npm run prisma:migrate
```

Then use separate terminals from the project root.

### Terminal 1 — API

```bash
npm run dev
```

Expect Fastify to listen on port 3000. Visit `http://localhost:3000/docs`.

### Terminal 2 — outbox dispatcher

```bash
npm run worker:outbox
```

Expect `Outbox dispatcher started`. It polls about once per second when idle with the example configuration.

### Terminal 3 — payment worker

```bash
npm run worker:payment
```

Expect the worker to start and consume `payment-processing` jobs.

### Terminal 4 — webhook worker

```bash
npm run worker:webhook
```

Expect the worker to consume `webhook-delivery` jobs.

### Terminal 5 — local webhook receiver

```bash
WEBHOOK_RECEIVER_SECRET=local-webhook-secret npm run dev:webhook-receiver
```

It listens on `http://localhost:4000`. `/success` logs headers/payload and returns `200`; `/fail` returns `500`. With `WEBHOOK_RECEIVER_SECRET` matching the subscription secret, it also prints whether the signature is valid.

### Terminal 6 — manual commands

Create the subscription first, then submit a payment using the curl examples in section 19. Copy the returned payment ID and poll:

```bash
PAYMENT_ID='replace-with-returned-payment-uuid'
curl "http://localhost:3000/v1/payments/$PAYMENT_ID"
curl "http://localhost:3000/v1/payments/$PAYMENT_ID/events"
```

Expected successful flow:

- POST returns `PENDING` quickly.
- status soon becomes `PROCESSING`, then `COMPLETED`.
- audit history contains three transitions.
- the receiver prints signed webhook messages for status changes.

Try `TEMP_FAIL_ONCE-DEMO` to see a retry. With the default base delay, it should become `RETRYING`, wait about one second, then complete on attempt 2.

## 23. Interview explanations

### A. 30-second explanation

> I built a TypeScript service that safely accepts ACH-style payment requests and processes them asynchronously. PostgreSQL is the source of truth, and a transactional outbox publishes work to BullMQ through Redis. The API is idempotent, workers conditionally claim attempts, temporary bank errors retry with bounded exponential backoff, every transition is audited, and status changes produce independently retried HMAC-signed webhooks.

### B. 60-second explanation

> A client posts a payment with an idempotency key. In one PostgreSQL transaction I create the payment, the idempotency record, its first audit event, and an outbox event, then return `PENDING`. A dispatcher moves durable outbox intent to BullMQ, and a payment worker claims the state atomically before calling a deterministic bank adapter. Permanent errors fail immediately; temporary errors store a due time and delayed retry until max attempts. Every state update has an ordered audit event. Those events fan out into webhook deliveries that another worker signs with HMAC-SHA256 and retries separately, so a customer's endpoint can never change the payment outcome.

### C. Two-minute technical explanation

> The service uses Fastify and runtime JSON schemas at the HTTP boundary. Amounts arrive as strings, are normalized, and are stored as PostgreSQL `DECIMAL(18,2)`. For submission idempotency I hash a canonical request with SHA-256 and enforce a unique customer/key pair. The unique constraint is important because an application-level pre-check alone races.
>
> The submission transaction creates the payment, idempotency row, initial `PaymentEvent`, and outbox row. PostgreSQL is authoritative; Redis is only work transport. The dispatcher publishes deterministic BullMQ jobs and marks an outbox published only afterward. The payment worker uses expected state and attempt numbers in conditional updates, so duplicate or stale jobs do not make a second bank call for a claimed attempt. It passes a stable execution key to the adapter. Temporary failures use base-delay times two to the failed-attempt-minus-one, and max attempts includes the original call.
>
> Each transition has a unique per-payment sequence number and creates durable webhook intent. Enabled subscriptions get unique event/destination delivery records. Webhook workers use the same conditional-claim pattern, sign the exact serialized body with HMAC-SHA256, treat any 2xx as success, and retry other outcomes independently. The main known recovery gap is a crash after a worker claim and before result persistence; production would add leases and reconciliation.

### D. For a non-technical recruiter

> I built the backend for safely accepting money-transfer requests. It avoids charging twice when someone retries, handles slow or temporarily unavailable banks in the background, keeps a full history, and automatically tells customers when a payment changes. I also built automated tests for error cases and simultaneous requests, not just the happy path.

### E. For a backend engineer

> It is a Fastify/Prisma service with PostgreSQL as the ledger and BullMQ/Redis for asynchronous transport. Submission uses canonical payload hashing, a customer-scoped uniqueness constraint, and a transactional outbox. Consumers use deterministic job IDs plus conditional, expected-attempt database claims. Retry timing is persisted and mirrored by delayed jobs. Audit events and webhook fan-out are durable; webhook delivery has its own state machine, HMAC contract, and bounded retries. The deliberately documented gap is lease-based recovery after a post-claim crash.

## 24. Common interview questions and simple answers

### Why asynchronous processing?

Bank calls can be slow and unreliable. Returning after durable acceptance keeps the API responsive and lets workers retry without depending on the client's HTTP connection.

### Why PostgreSQL?

Payments need durable records, transactions, constraints, and queryable history. PostgreSQL gives strong support for all four and remains the source of truth.

### Why Prisma?

It keeps the data model, migrations, and TypeScript access aligned. It reduces manual mapping while still letting the design rely on real PostgreSQL constraints and transactions.

### Why Redis and BullMQ?

They provide practical background queues, worker coordination, concurrency, and delayed jobs for a Node.js project. Redis carries work; it does not replace the payment database.

### Why a transactional outbox?

It closes the failure window between committing database state and publishing a queue message. The intended work is durable even when Redis is temporarily unavailable.

### How do you prevent duplicate payments?

I combine normalized request hashing and a customer/key unique constraint at submission with deterministic queue IDs, conditional worker claims, expected attempt numbers, and a stable bank execution key.

### What happens if Redis is down?

New payments can still commit their outbox intent in PostgreSQL. Publication fails, remains unpublished, and records the error. The dispatcher can publish after Redis recovers. Existing queue processing waits for Redis.

### What happens if the bank is down?

A thrown call or temporary result is treated as a temporary failure. The payment becomes `RETRYING` with a delayed attempt until it succeeds or reaches `maxAttempts`, then becomes `FAILED` with `RETRY_EXHAUSTED`.

### What happens if a worker crashes?

Unclaimed queue work remains available through BullMQ. The important known gap is a crash after the database claim but before result persistence; production needs a claim lease and reconciliation worker for that case.

### Why exponential backoff?

It avoids hammering an unhealthy dependency. Each failure waits longer, giving recovery time while keeping the first retry quick.

### Why not retry permanent failures?

Another identical call is not expected to fix an invalid account or a permanent rejection. Retrying wastes capacity and may create unnecessary downstream risk.

### What is the difference between `PENDING`, `PROCESSING`, and `RETRYING`?

`PENDING` has never been claimed. `PROCESSING` is currently owned for a bank attempt. `RETRYING` means a temporary attempt failed and the next claim is scheduled for a future time.

### How do webhooks work?

A customer registers a URL/secret. Each payment event becomes a tracked delivery. A separate queue worker sends a safe JSON body, records the result, and retries failures.

### Why sign webhooks?

The receiver needs evidence that someone with the shared secret created the exact body. HMAC detects modification and authenticates the shared-secret sender.

### What if the customer's webhook endpoint is down?

The delivery records the network/HTTP error and retries with exponential backoff. Exhaustion makes the delivery `FAILED`, but never changes the payment.

### How do you handle concurrency?

I use database uniqueness for creation and conditional atomic updates for claims. Expected state and attempt numbers ensure only one concurrent worker owns a logical attempt.

### How is the system auditable?

Every state change and its `PaymentEvent` commit together. Unique sequence numbers provide a complete ordered history with actor, reason, correlation ID, and time.

### What would you change for real production?

I would add authentication/authorization, encrypted secret management, a real bank adapter, leases/reconciliation, observability and alerts, rate limits, HA, retention policies, operator tooling, webhook secret rotation, and stronger timestamp-based replay protection.

### What is the biggest known limitation?

Recovery after a worker crashes between claiming an attempt and persisting the result. A lease/reaper design plus downstream lookup/idempotency would address it.

### What part was hardest to design?

Making retries safe under duplicate and concurrent jobs. The important insight was to make PostgreSQL state and expected attempt numbers authoritative instead of trusting queue delivery to be exactly once.

### Why not process inside the POST endpoint?

It couples customer response time to bank availability and makes client timeouts ambiguous. Durable asynchronous acceptance gives cleaner retries, scaling, and recovery.

## 25. Trace the code

Open these files in order when you want to follow a scenario.

### Trace payment submission

1. `src/app.ts` — dependency wiring and route registration
2. `src/api/routes/payments.ts` — HTTP handling/status code
3. `src/api/schemas/payments.ts` — runtime request/response schema
4. `src/services/payment-service.ts` — normalization, hash, replay/conflict
5. `src/domain/payment.ts` — canonical payment validation/hash helpers
6. `src/repositories/payment-repository.ts` — persistence contract
7. `src/repositories/prisma-payment-repository.ts` — Prisma transaction
8. `prisma/schema.prisma` — tables and constraints

### Trace asynchronous payment processing

1. `src/workers/outbox-dispatcher.ts` — polling loop and dispatcher wiring
2. `src/services/outbox-dispatcher.ts` — payment outbox publication policy
3. `src/queues/payment-queue.ts` — queue/job names and IDs
4. `src/workers/payment-worker.ts` — process entry point
5. `src/workers/create-payment-worker.ts` — BullMQ callback and early re-delay
6. `src/services/payment-processor.ts` — claim, bank result, retry decisions
7. `src/repositories/prisma-payment-processing-repository.ts` — atomic claims/transitions
8. `src/domain/payment-state-machine.ts` — allowed transitions
9. `src/bank/bank-client.ts` — external boundary
10. `src/bank/simulated-bank-client.ts` — deterministic local result

### Trace payment retry

1. `src/services/payment-processor.ts` — backoff and next attempt decision
2. `src/repositories/prisma-payment-processing-repository.ts` — due time plus retry outbox
3. `src/services/outbox-dispatcher.ts` — delayed retry publication
4. `src/queues/payment-queue.ts` — retry job ID
5. `src/workers/create-payment-worker.ts` — early job handling

### Trace payment reads and audit

1. `src/api/routes/payments.ts`
2. `src/api/schemas/payments.ts`
3. `src/services/payment-service.ts`
4. `src/repositories/prisma-payment-repository.ts`

### Trace webhook subscriptions

1. `src/api/routes/webhooks.ts`
2. `src/api/schemas/webhooks.ts`
3. `src/services/webhook-subscription-service.ts`
4. `src/repositories/webhook-subscription-repository.ts`
5. `src/repositories/prisma-webhook-subscription-repository.ts`

### Trace a webhook from event to HTTP call

1. `src/repositories/webhook-event-outbox.ts` — event outbox helper
2. `src/services/webhook-event-materializer.ts` — fan-out workflow
3. `src/repositories/prisma-webhook-event-repository.ts` — unique delivery creation
4. `src/services/webhook-job-outbox-dispatcher.ts` — queue publication
5. `src/queues/webhook-queue.ts` — job shape and deterministic ID
6. `src/workers/webhook-worker.ts` — process wiring
7. `src/workers/create-webhook-worker.ts` — BullMQ callback
8. `src/services/webhook-delivery-processor.ts` — payload/sign/send/retry
9. `src/domain/webhook.ts` — serialization, HMAC, retry math
10. `src/repositories/prisma-webhook-delivery-repository.ts` — claim and result state
11. `src/webhooks/webhook-http-client.ts` — actual HTTP POST

### Trace tests

- `tests/integration/payments.test.ts` — submission/idempotency/validation
- `tests/integration/payment-retrieval.test.ts` — reads and audit history
- `tests/integration/async-payment-processing.test.ts` — database/Redis/BullMQ behavior
- `tests/unit/payment-processing.test.ts` — state, simulator, retry policy
- `tests/integration/webhook-subscriptions.test.ts` — subscription API
- `tests/integration/webhook-delivery.test.ts` — webhook persistence/concurrency/HTTP workflow
- `tests/unit/webhook.test.ts` — signing, payload, and webhook retry helpers

## 26. Glossary

| Term | Simple meaning |
| --- | --- |
| ACH | A US bank-to-bank electronic money movement network/process |
| API | A defined way for software systems to communicate |
| Idempotency | Repeating the same operation does not repeat its logical effect |
| Transaction | A set of actions treated as one unit |
| Database transaction | Database changes that all commit or all roll back |
| ORM | A tool that maps programming-language objects/queries to database operations |
| Prisma | This project's schema, migration, and type-safe ORM/database toolkit |
| Queue | A named line of work waiting for consumers |
| Job | One message/work item on a queue |
| Worker | A process that continuously consumes and performs jobs |
| Redis | The data server BullMQ uses to store and coordinate queues |
| BullMQ | The Node.js queue library used for jobs, workers, and delays |
| Outbox | A database table of durable work that still needs external publication |
| Webhook | An HTTP callback sent when an event occurs |
| HMAC | A keyed message authentication code that signs data with a shared secret |
| SHA-256 | A cryptographic hash algorithm producing a fixed-size digest |
| Backoff | Waiting longer between repeated attempts |
| Race condition | A bug where timing between concurrent operations changes the result |
| Concurrency | Multiple requests or jobs making progress during the same period |
| Audit trail | An ordered history of what changed, when, why, and by whom |
| Source of truth | The authoritative place used to decide current state |
| HTTP `2xx` | Successful HTTP responses |
| HTTP `4xx` | Client/request errors, such as invalid input |
| HTTP `5xx` | Server-side failures |
| UUID | A broadly unique identifier represented as a standard string |

## 27. Final mental model

Memorize this:

```text
API receives payment
        |
        v
safely save it
        |
        v
queue it
        |
        v
worker processes it
        |
        v
retry if temporary problem
        |
        v
record every change
        |
        v
notify customer through webhook
```

In one sentence:

> The API safely records intent, background workers perform unreliable external work, PostgreSQL decides the truth, every change is audited, and notifications happen independently.

If you understand these seven steps, you understand the core project.
