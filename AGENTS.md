# AGENTS.md

## Project

Distributed Wagering Processor for the Jungle Gaming Backend Challenge.

## Goal

Build a financially correct distributed wagering processor that remains
consistent under duplicate delivery, concurrent processing and failures.

## Required Stack

- Bun 1.x
- TypeScript strict mode
- NestJS
- PostgreSQL
- MikroORM
- AWS SQS through LocalStack
- Docker Compose

## Engineering Principles

- Domain logic must not depend on NestJS.
- Money must never use JavaScript `number`.
- Financial writes must be transactional.
- PostgreSQL is the final authority for consistency.
- Idempotency must be persistent.
- Ledger entries are immutable.
- Events must never be published before the financial transaction commits.
- The application must remain correct with multiple running instances.

## Before Changing Code

1. Identify the affected business invariant.
2. Understand the transaction boundary.
3. Consider concurrent execution.
4. Consider duplicate delivery or retry.
5. Prefer the smallest correct change.
6. Do not weaken database constraints to make tests pass.

## Validation

Before considering a change complete, run the relevant checks:

```bash
bun run lint
bun run typecheck
bun test
```

## Git

- Use focused commits.
- Prefer Conventional Commits.
- Review staged changes before committing.
- Do not commit secrets or generated temporary files.
- Use fixup commits only when correcting an existing commit.
