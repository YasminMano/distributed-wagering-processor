# Distributed Wagering Processor

Backend desenvolvido para o desafio técnico da Jungle Gaming. O serviço processa transações de apostas com foco em **correção financeira, concorrência entre múltiplas instâncias, idempotência persistente, ledger auditável, mensageria at-least-once e recuperação após falhas**.

## Stack

- Bun 1.x
- TypeScript em modo estrito
- NestJS
- PostgreSQL 17
- MikroORM
- AWS SQS via MiniStack
- Docker Compose
- `decimal.js` para valores monetários exatos

> MiniStack foi usado no ambiente local por ser compatível com o requisito do desafio e permitir SQS/DLQ sem dependência de credenciais externas. A garantia de consistência não depende do FIFO: PostgreSQL continua sendo a fonte das invariantes financeiras.

## Principais garantias

- dinheiro nunca é representado com `number`, `float` ou `double`;
- saldo da wallet não pode ficar negativo;
- no máximo uma wallet por `playerId + currency`;
- cada mudança de saldo produz exatamente um lançamento correspondente no ledger;
- ledger é imutável e auditável;
- idempotência é persistida no PostgreSQL;
- replay idêntico não reaplica o efeito financeiro e devolve o saldo observado no processamento original;
- mesma idempotency key com payload diferente é conflito;
- concorrência é serializada por wallet, sem lock global;
- Inbox, efeito financeiro, ledger e Outbox participam da mesma transação SQL;
- mensagens SQS só recebem ACK depois do commit;
- Outbox é publicada por workers concorrentes com `FOR UPDATE SKIP LOCKED`;
- referências fora de ordem ficam em `PENDING_REFERENCE` e são reprocessadas com backoff;
- reconciliação compara o saldo materializado com o saldo reconstruído pelo ledger sem corrigir divergências silenciosamente.

## Estrutura

```text
src/
├── application/
│   ├── ports/
│   └── use-cases/
├── domain/
│   ├── entities/
│   └── value-objects/
└── infrastructure/
    ├── http/
    ├── messaging/
    ├── observability/
    └── persistence/
```

A camada de domínio não depende de NestJS ou MikroORM. Regras financeiras ficam nas entidades/value objects e os adaptadores de infraestrutura implementam persistência, HTTP e mensageria.

## Pré-requisitos

- Docker Desktop com Docker Compose
- Bun 1.x

Versão usada durante a validação final:

```text
Bun 1.4.0
PostgreSQL 17-alpine
MiniStack 1.5.5
```

## Subindo o ambiente

Clone o repositório e entre na pasta:

```bash
git clone https://github.com/YasminMano/distributed-wagering-processor.git
cd distributed-wagering-processor
```

Instale as dependências:

```bash
bun install
```

Crie o arquivo de ambiente:

```bash
cp .env.example .env
```

Suba PostgreSQL e MiniStack:

```bash
docker compose up -d
```

As filas locais são criadas pelo script de inicialização montado no container:

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`
- `wager-events.fifo`

Aplique as migrations:

```bash
bunx mikro-orm migration:up
```

Inicie a aplicação:

```bash
bun run start:dev
```

Por padrão a API fica disponível em `http://localhost:3000`.

## Variáveis principais

```env
DATABASE_URL=postgresql://wagering:wagering@localhost:5432/wagering

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test

SQS_ENDPOINT=http://localhost:4566
SQS_WAGER_QUEUE_URL=http://localhost:4566/000000000000/wager-transactions.fifo
SQS_WAGER_DLQ_URL=http://localhost:4566/000000000000/wager-transactions-dlq.fifo
SQS_EVENT_QUEUE_URL=http://localhost:4566/000000000000/wager-events.fifo
```

## API HTTP

### Wallets

```http
POST /wallets
GET  /wallets/:walletId
GET  /wallets/:walletId/ledger?cursor=...&limit=50
POST /wallets/:walletId/reconciliation
```

Uma wallet criada com saldo positivo gera, na mesma transação SQL, uma transação interna `OPENING` e um lançamento `CREDIT`.

Exemplo:

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": {
    "amount": "1000.00",
    "currency": "BRL"
  }
}
```

### Wagering

```http
POST /wagering/transactions
GET  /wagering/transactions/:transactionId
GET  /providers/:providerId/wagering/transactions/:externalTransactionId
```

`POST /wagering/transactions` exige o header:

```http
Idempotency-Key: provider-a:transaction-123
```

Kinds suportados:

- `BET`
- `WIN`
- `LOSS`
- `REFUND`
- `ROLLBACK`

`OPENING` é interno e não pode ser submetido pela API/fila.

### Reconciliação

```http
POST /wallets/:walletId/reconciliation
```

Resposta:

```json
{
  "walletId": "...",
  "storedBalance": {
    "amount": "85.00",
    "currency": "BRL"
  },
  "calculatedBalance": {
    "amount": "85.00",
    "currency": "BRL"
  },
  "difference": {
    "amount": "0.00",
    "currency": "BRL"
  },
  "consistent": true,
  "checkedEntries": 3
}
```

A reconciliação nunca corrige o saldo silenciosamente. Divergências são sinalizadas na resposta, registradas em log e contabilizadas nas métricas.

## Health e observabilidade

```http
GET /health/live
GET /health/ready
GET /metrics
```

`/health/live` verifica o processo. `/health/ready` verifica PostgreSQL e SQS.

Os logs são JSON estruturado e carregam, quando disponíveis:

- `correlationId`
- `messageId`
- `transactionId`
- `walletId`
- `providerId`

Payloads financeiros completos não são escritos em log.

As métricas cobrem:

- transações por status;
- duplicatas detectadas;
- retries de Outbox e referências pendentes;
- mensagens em DLQ;
- conflitos de lock;
- Outbox lag;
- latência de processamento;
- divergências de reconciliação.

## SQS, Inbox e DLQ

O consumidor SQS reutiliza o mesmo caso de uso financeiro usado pela API HTTP.

Cada mensagem é deduplicada de forma persistente por:

```text
(consumerName, messageId)
```

O fluxo relevante é:

```text
ReceiveMessage
    ↓
Inbox persistente
    ↓
transação financeira + wallet + ledger + outbox
    ↓
COMMIT PostgreSQL
    ↓
DeleteMessage / ACK SQS
```

Se o processo morrer depois do commit e antes do ACK, a redelivery é segura porque Inbox e idempotência persistentes impedem que o efeito financeiro seja reaplicado.

Mensagens permanentemente inválidas que não recebem ACK são redirecionadas para a DLQ conforme `maxReceiveCount`.

## Transactional Outbox

Eventos são gravados na mesma transação SQL das alterações financeiras.

Publishers podem rodar simultaneamente. A seleção usa:

```sql
FOR UPDATE SKIP LOCKED
```

em lotes, permitindo divisão de trabalho entre instâncias sem lock global.

Eventos mínimos implementados:

- `WagerTransactionProcessed`
- `WagerTransactionRejected`
- `WalletBalanceChanged`
- `WagerTransactionPendingReference`

`WalletBalanceChanged` só é gerado quando o saldo realmente muda.

## Testes

Com PostgreSQL e MiniStack ativos:

```bash
bun test
```

Validação final da entrega:

```text
93 pass
0 fail
467 expect() calls
15 arquivos de teste
```

A suíte inclui testes unitários, integração real com PostgreSQL/MiniStack e concorrência, incluindo:

- Money e precisão decimal;
- invariantes de Wallet e Ledger;
- BET, WIN, LOSS, REFUND e ROLLBACK;
- idempotency key com payload divergente;
- Inbox persistente;
- rollback transacional;
- referências fora de ordem e retry;
- duas apostas concorrendo pelo mesmo saldo;
- mesma BET enviada 50 vezes em paralelo;
- wallets diferentes em paralelo;
- três processadores independentes disputando a mesma wallet;
- dois publishers concorrentes na mesma Outbox;
- crash depois do commit e antes do ACK;
- redelivery sem débito duplicado;
- cinco entregas sem ACK e redrive para DLQ;
- reconciliação final `wallet.balance == saldo reconstruído pelo ledger`.

Também existe um teste de sistema com três processos Nest reais:

```bash
./scripts/test-multi-process.sh
```

O cenário validado inicia três processos independentes, envia BETs concorrentes para a mesma wallet e verifica saldo, versão e quantidade de lançamentos no ledger.

### Validação estática/final

```bash
bun run typecheck
bun run lint
bun test
bun run build
git diff --check
```

## Autenticação

Autenticação não foi implementada porque não pontua no desafio e foi priorizada a correção financeira/distribuída.

Em produção, a extensão planejada seria um Identity Provider externo via OIDC (por exemplo Keycloak/Zitadel) e um `AuthGuard` no boundary HTTP. Health checks permaneceriam públicos e a fila continuaria sendo tratada como canal interno confiável, mantendo as validações de `providerId` no domínio.

## Documentação adicional

- [`ARCHITECTURE.md`](./ARCHITECTURE.md): decisões, invariantes e trade-offs.
- [`docs/AI_USAGE.md`](./docs/AI_USAGE.md): uso transparente de ferramentas de IA durante o desenvolvimento.

## Estado da entrega

O código foi validado com TypeScript strict, lint, build, 93 testes automatizados e cenários distribuídos adicionais. A prioridade foi preservar as invariantes financeiras sob duplicidade, concorrência, redelivery e falhas de processo.
