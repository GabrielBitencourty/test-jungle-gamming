# Architecture and implementation notes

## Runtime and persistence

The service uses Bun 1.x, strict TypeScript, NestJS, PostgreSQL and MikroORM. Domain persistence uses explicit SQL through MikroORM's PostgreSQL connection so wallet locking, `SKIP LOCKED`, database constraints and multi-row atomic writes are visible and reviewable. Migrations are versioned MikroORM migrations. Monetary amounts are `numeric(20,2)` in PostgreSQL and decimal strings at every application boundary; `Money` uses decimal.js and never converts amounts to JavaScript `number`.

Transactions lock the affected wallet with `SELECT ... FOR UPDATE`. This serializes changes to one wallet across all service instances while leaving distinct wallets independent. A database unique constraint on the idempotency key and provider transaction identity is the final deduplication authority. Financial state, ledger entries and outbox records are committed together. SQS messages additionally use a durable inbox, and the consumer acknowledges only after the transaction commits.

## Idempotency and ledger

The hash is SHA-256 over JSON canonicalized recursively by sorting object keys. Only request business fields are included; transport headers and metadata are excluded. The `Idempotency-Key` header is required for HTTP requests. At-least-once retries use a database uniqueness constraint and replay the stored status and balance snapshot. Ledger entries have a database arithmetic check, a unique transaction/wallet constraint and a trigger preventing updates and deletes.

Opening balances produce an internal `OPENING` credit and ledger entry in the wallet creation transaction. `LOSS` and rejected transactions do not create a ledger entry. Refund and rollback references are constrained to the same provider, wallet, player, round and currency, and the referenced value must match in full.

## Messaging and recovery

The transaction consumer shares the same use case as HTTP, stores inbox state in the same SQL transaction, and leaves transient failures unacknowledged for redelivery. SQS redrive sends repeated failures to the configured DLQ. Outbox workers claim work with row locks and expiring database claims; publishing may be repeated after a crash, so event IDs are stable and downstream consumers should deduplicate them. Outbox retry delay is exponential and capped.

Transactions whose references are not yet present remain `PENDING_REFERENCE`, with exponential retry, a default maximum of 12 attempts, and a default 24-hour TTL. Exhaustion becomes an auditable `REJECTED` result and emits `WagerTransactionRejected`.

Stable business failure codes currently include `AMOUNT_MUST_BE_POSITIVE`, `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_CONTEXT_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, and `INVALID_REFERENCE_KIND`. HTTP uses 400 for invalid input, 409 for idempotency/identity conflicts, 422 for terminal business rejection, 202 for pending references, and 503/5xx for unavailable infrastructure.

## Authentication and observability

Authentication is intentionally omitted because it carries no points in the challenge. HTTP routes have an explicit place for a future provider identity guard; health routes are public. Production deployment should validate provider identity using an external OIDC identity provider rather than a local password table.

Logs are structured JSON and omit complete financial payloads. `/metrics` exports Prometheus metrics, and `/health/live` and `/health/ready` separate process liveness from PostgreSQL/SQS availability. Reconciliation reports mismatches and does not repair them automatically.

The `wallet_reconciliation_mismatches_total` counter records each reconciliation that finds a difference between the materialized balance and its ledger.

## Local setup and known boundaries

Install Bun 1.x, copy `.env.example` to `.env`, then run `docker compose up --build`. PostgreSQL and LocalStack are provisioned by Compose; LocalStack initializes the transaction, FIFO DLQ and event queues. Migrations run before API startup. Run unit tests with `bun test`. Set `RUN_INTEGRATION=true` and run `bun test src/integration` with PostgreSQL and LocalStack available to enable the integration suite; it exercises real PostgreSQL locks and three independent database connections.

The challenge permits one operational currency, but `Money` and wallet uniqueness remain currency-aware. No external identity provider or load-test harness is included. Metrics are process-local Prometheus metrics and should be scraped from each replica.
