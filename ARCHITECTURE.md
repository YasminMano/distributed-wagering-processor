# Architecture

## 1. Overview

This project implements a distributed wagering transaction processor.

The main architectural goal is to preserve financial correctness even when:

- messages are delivered more than once;
- messages arrive out of order;
- multiple application instances process the same wallet concurrently;
- PostgreSQL or SQS are temporarily unavailable;
- a process crashes before or after committing a transaction.

The system must never duplicate credits or debits, lose confirmed events or allow a wallet balance to become negative.

---

## 2. Architectural Priorities

The project prioritizes:

1. Financial correctness
2. Concurrency safety
3. Persistent idempotency
4. Ledger consistency
5. Atomic event publication
6. Failure recovery
7. Clear separation of responsibilities

The architecture favors correctness and auditability over premature optimization.

---

## 3. Layers

The application is divided into four main boundaries.

### 3.1 Domain

Contains business rules and invariants.

Examples:

- Money
- Wallet
- WagerTransaction
- WalletLedgerEntry
- InboxMessage
- OutboxMessage

The domain layer must not depend on:

- NestJS
- PostgreSQL
- AWS SQS
- MikroORM decorators
- HTTP-specific concepts

This keeps financial rules independent from infrastructure.

### 3.2 Application

Contains use cases and orchestration.

Examples:

- CreateWallet
- ProcessWagerTransaction
- ReconcileWallet

HTTP requests and SQS messages must reuse the same application use cases.

This prevents business rules from being duplicated across different entry points.

### 3.3 Infrastructure

Contains technical implementations.

Examples:

- PostgreSQL persistence
- MikroORM repositories
- transaction management
- SQS integration
- inbox/outbox workers
- logging
- metrics

PostgreSQL is treated as the final authority for consistency.

### 3.4 Presentation

Contains external entry points.

Examples:

- HTTP controllers
- request validation
- health endpoints

Controllers should remain thin and delegate business behavior to application use cases.

---

## 4. Runtime and Framework

### Bun

Bun 1.x is used as:

- runtime;
- package manager;
- test runner.

### TypeScript

TypeScript is configured in strict mode.

### NestJS

NestJS is used for:

- dependency injection;
- HTTP transport;
- application bootstrap;
- infrastructure integration.

Domain objects remain framework-independent.

---

## 5. Persistence

PostgreSQL is the primary database and the final authority for financial consistency.

Important invariants must be enforced both:

- in application/domain code;
- in the database schema.

Examples include:

- unique wallet per player and currency;
- non-negative wallet balance;
- unique financial transaction identifiers;
- immutable ledger relationships;
- persistent idempotency guarantees.

Migrations will be versioned and reversible.

---

## 6. ORM

MikroORM will be used.

Reasons:

- explicit Unit of Work;
- transaction support;
- Identity Map;
- locking primitives;
- good fit for aggregate-oriented domain modeling.

The domain itself will not depend on MikroORM-specific types.

---

## 7. Money

Financial values must never use JavaScript `number`, `float` or `double`.

Money will be represented using exact decimal arithmetic.

External contracts use decimal strings with two decimal places:

```json
{
  "amount": "25.00",
  "currency": "BRL"
}
```

The Money value object will be responsible for:

- exact arithmetic;
- currency validation;
- rejecting invalid decimal formats;
- preventing operations between different currencies;
- serialization to stable decimal strings.

---

## 8. Wallet and Ledger Consistency

Wallet stores the materialized current balance.

WalletLedgerEntry stores the immutable financial history.

Every balance change must generate exactly one corresponding ledger entry.

Operations without balance impact do not create ledger entries.

The central financial invariant is:

```text
wallet.balance == balance reconstructed from ledger
```

Ledger entries must never be overwritten or deleted.

---

## 9. Idempotency

The system assumes at-least-once delivery.

Therefore, duplicate requests and duplicate messages are expected behavior.

Idempotency must be persistent and database-backed.

The API uses the `Idempotency-Key` header as the source of truth.

A canonical payload hash will be stored with the transaction.

Expected behavior:

- same key + same payload -> return original result;
- same key + different payload -> idempotency conflict;
- duplicate delivery -> no duplicated financial effect.

In-memory caches are not used as the consistency guarantee.

---

## 10. Concurrency

The unit of concurrency is the wallet.

Multiple application instances may attempt to modify the same wallet simultaneously.

The database must prevent lost updates and negative balances caused by race conditions.

The exact locking strategy will be finalized after implementation and concurrency testing.

Current direction:

- transaction scoped locking per wallet;
- no global lock;
- wallets that are independent should remain processable in parallel.

The chosen strategy and its trade-offs will be documented after the first concurrency implementation.

---

## 11. Inbox

SQS delivery is at-least-once.

The inbox provides persistent message deduplication.

Messages are identified using:

- consumer name;
- message id.

Inbox persistence participates in the same SQL transaction as the financial operation.

A message is acknowledged only after the SQL transaction commits successfully.

---

## 12. Transactional Outbox

Financial state and integration events must be committed atomically.

The same SQL transaction will persist:

- wagering transaction;
- wallet balance change;
- ledger entry;
- inbox entry when applicable;
- outbox messages.

Events are not published directly before the financial commit.

A separate worker publishes pending outbox messages.

If the application crashes after the database commit but before publication, another worker can publish the pending event later.

Consumers must tolerate duplicate event publication.

---

## 13. Out-of-Order References

REFUND and ROLLBACK may arrive before the transaction they reference.

In this situation, the transaction will be persisted as:

```text
PENDING_REFERENCE
```

A scheduled worker will retry processing using backoff.

If the referenced transaction never becomes available within the configured retry/TTL policy, the operation will become REJECTED with a machine-readable failure code.

The retry policy will be documented after implementation.

---

## 14. Authentication

Authentication is intentionally not part of the initial implementation timebox.

The challenge assigns no evaluation points to authentication and explicitly allows it to be omitted when the architectural extension point is documented.

The intended production approach would use an external OIDC identity provider rather than custom password authentication.

An explicit authentication integration boundary will remain available in the application.

Health endpoints remain unauthenticated.

---

## 15. Observability

The application will provide:

- structured JSON logs;
- correlation identifiers;
- transaction identifiers;
- wallet identifiers;
- provider identifiers;
- metrics for transaction status;
- duplicate detection;
- retries;
- DLQ messages;
- lock conflicts;
- outbox lag;
- processing latency;
- separate liveness and readiness checks.

Sensitive financial payloads must not be written completely to logs.

---

## 16. Testing Strategy

### Unit tests

Cover:

- Money;
- Wallet invariants;
- BET;
- WIN;
- LOSS;
- REFUND;
- ROLLBACK;
- currency conflicts;
- idempotency conflicts.

### Integration tests

Use real PostgreSQL and LocalStack/MiniStack containers.

Cover:

- migrations;
- database constraints;
- wallet/ledger/inbox/outbox atomicity;
- message redelivery;
- retry and DLQ behavior;
- outbox publication.

### Concurrency tests

Must use real parallel execution.

Important scenarios include:

- the same transaction submitted many times simultaneously;
- two bets competing for the same balance;
- different wallets processed in parallel;
- three or more application instances;
- process failure after commit and before acknowledgment.

---

## 17. Known Decisions Still Open

The following decisions are intentionally not finalized yet:

- exact wallet locking strategy;
- exact decimal library;
- pending-reference retry limit and TTL;
- outbox retry/backoff policy;
- HTTP status mapping;
- failure-code taxonomy;
- metrics implementation.

These decisions will be updated with implementation evidence and trade-offs during development.
