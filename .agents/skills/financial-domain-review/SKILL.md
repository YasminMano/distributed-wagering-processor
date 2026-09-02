---
name: financial-domain-review
description: Review financial domain changes for correctness, precision, invariants, idempotency and concurrency risks.
---

# Financial Domain Review

Use this skill when reviewing changes involving:

- Money;
- Wallet;
- WagerTransaction;
- WalletLedgerEntry;
- REFUND or ROLLBACK behavior;
- financial persistence;
- balance-changing operations.

## Review Procedure

### 1. Money Precision

Verify that:

- JavaScript `number` is never used to represent monetary values;
- monetary inputs are parsed from decimal strings;
- scientific notation is rejected;
- invalid or excessive decimal scale is rejected;
- arithmetic uses exact decimal operations;
- serialized monetary values use exactly two decimal places.

### 2. Currency Safety

Verify that:

- every Money value contains a currency;
- arithmetic between different currencies is rejected;
- comparisons between different currencies are rejected when applicable.

### 3. Immutability

Verify that:

- Money objects are immutable;
- ledger entries are never mutated or deleted;
- operations return new values instead of mutating existing financial values.

### 4. Wallet Invariants

Verify that:

- wallet balance never becomes negative;
- wallet version changes only when the balance changes;
- every balance change has exactly one corresponding ledger entry.

### 5. Idempotency

Verify that:

- duplicate delivery cannot cause duplicate financial effects;
- idempotency is persisted rather than stored only in application memory;
- conflicting payloads using the same idempotency key are detected.

### 6. Concurrency

Verify that:

- read-calculate-write sequences cannot cause lost updates;
- correctness does not depend on a single application instance;
- locking or atomic database operations are scoped to the wallet rather than globally.

### 7. Transaction Boundaries

Verify that related financial writes are atomic.

When applicable, the same SQL transaction should contain:

- transaction state;
- wallet balance change;
- ledger entry;
- inbox state;
- outbox event.

Events must not be published before the financial transaction commits.

### 8. Tests

Check that relevant tests cover:

- successful behavior;
- invalid monetary inputs;
- currency mismatches;
- insufficient balance;
- duplicate execution;
- concurrent execution;
- financial invariants.

## Review Output

Report findings using:

- CRITICAL: can violate financial correctness;
- WARNING: risky design or missing coverage;
- OK: invariant explicitly verified.

Do not recommend weakening database constraints or domain invariants merely to make tests pass.
