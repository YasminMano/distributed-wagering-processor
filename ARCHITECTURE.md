# Architecture

## 1. Objetivo

Esta solução foi desenhada para manter correção financeira mesmo quando:

- a mesma operação chega mais de uma vez;
- operações chegam fora de ordem;
- múltiplas instâncias processam a mesma wallet;
- o processo morre antes ou depois do commit;
- SQS redeliver uma mensagem;
- publishers de Outbox executam simultaneamente.

A principal decisão arquitetural é tratar **PostgreSQL como a autoridade das invariantes**. FIFO ajuda na ordenação/deduplicação do transporte, mas não é usado como garantia final de consistência.

---

## 2. Organização em camadas

A aplicação é separada em:

### Domain

Contém os conceitos financeiros sem dependência de NestJS/MikroORM:

- `Money`
- `Wallet`
- `WagerTransaction`
- `WalletLedgerEntry`

As entidades encapsulam transições e invariantes. Persistência usa `rehydrate` para reconstruir estado já validado sem executar novamente regras de criação/transição.

### Application

Contém os casos de uso e portas:

- criação de wallet;
- processamento de wager;
- retry de referências pendentes;
- interfaces de persistência/UoW.

HTTP e SQS chamam o mesmo caso de uso de processamento, evitando duas implementações diferentes das regras financeiras.

### Infrastructure

Contém:

- controllers HTTP;
- MikroORM/PostgreSQL;
- migrations;
- consumidor SQS;
- Inbox/Outbox;
- workers;
- observabilidade.

---

## 3. Money e precisão financeira

Dinheiro entra e sai dos contratos como string decimal:

```json
{
  "amount": "25.00",
  "currency": "BRL"
}
```

O domínio usa `decimal.js`. JavaScript `number` não é utilizado para representar quantias monetárias.

Propriedades importantes:

- escala fixa de duas casas;
- rejeição de formatos inválidos;
- rejeição de operações entre moedas diferentes;
- operações imutáveis;
- serialização determinística.

Na persistência são usadas colunas decimais exatas (`NUMERIC`), e os valores são reidratados para `Money`.

Essa decisão remove erros binários típicos de IEEE-754 e atende à restrição financeira central do desafio.

---

## 4. Wallet, saldo e ledger

`Wallet` é o aggregate root financeiro.

Invariantes:

- uma wallet por `playerId + currency`;
- saldo não negativo;
- versão inicia em 1;
- versão só incrementa quando o saldo muda;
- toda mudança de saldo gera exatamente um ledger entry;
- operação sem movimento, como `LOSS`, não gera ledger.

O schema reforça invariantes que não devem depender apenas da aplicação:

- unicidade de wallet;
- não-negatividade do saldo;
- unicidade de operações;
- integridade entre transações e ledger;
- ledger protegido contra alteração/exclusão.

O ledger é append-only. UPDATE/DELETE não fazem parte do modelo operacional e a persistência aplica proteção de imutabilidade no banco.

### OPENING

Wallet criada com saldo inicial maior que zero produz uma transação interna `OPENING` e um ledger `CREDIT` na mesma transação SQL.

Wallet com saldo zero não cria movimento artificial.

---

## 5. Concorrência

A unidade de concorrência é a wallet, não a aplicação inteira.

A estratégia escolhida é **pessimistic row locking no PostgreSQL** durante o processamento financeiro.

Conceitualmente:

```text
BEGIN
  localizar wallet
  SELECT/FIND ... FOR UPDATE
  validar idempotência/regras
  aplicar movimento
  persistir wallet + transaction + ledger + outbox
COMMIT
```

Isso evita `read → calculate → update` desprotegido.

### Por que não lock global?

Um lock global impediria paralelismo entre wallets independentes. Row locks permitem:

- operações da mesma wallet serializadas;
- wallets diferentes processadas em paralelo;
- múltiplas instâncias sem memória compartilhada.

A correção foi validada com:

- duas BETs concorrendo pelo mesmo saldo;
- 50 envios paralelos da mesma BET;
- wallets diferentes;
- três processadores independentes;
- script com três processos Nest reais.

---

## 6. Idempotência persistente

Há duas dimensões complementares:

### Idempotency key da operação

`Idempotency-Key` é persistida com a transação.

O payload financeiro relevante é canonicalizado e associado a um hash estável. O header e metadados de transporte não definem o payload financeiro.

Comportamento:

- mesma key + mesmo payload → replay;
- mesma key + payload diferente → conflito;
- provider/external transaction também possui proteção contra duplicidade.

O replay retorna o resultado original e o **saldo observado naquele processamento**, armazenado com a transação. Portanto uma operação antiga pode ser repetida depois de movimentos posteriores sem devolver incorretamente o saldo atual.

### Inbox da mensagem SQS

Mensagens são deduplicadas por:

```text
(consumerName, messageId)
```

A Inbox é persistente, não um cache em memória.

Mesmo que o broker redeliver após restart, outra instância consegue identificar a mensagem já processada.

---

## 7. Transação financeira e atomicidade

Para entrada SQS, os itens abaixo participam da mesma transação PostgreSQL:

```text
Inbox
Wallet
WagerTransaction
WalletLedgerEntry
OutboxMessage
```

Ou todos são commitados, ou todos são revertidos.

Isso elimina estados como:

- saldo alterado sem ledger;
- Inbox marcada sem efeito financeiro;
- transação processada sem evento persistido;
- evento persistido antes da operação financeira.

O ACK do SQS acontece somente depois que o caso de uso terminou e o commit foi concluído.

---

## 8. Crash depois do commit e antes do ACK

Cenário:

```text
1. mensagem recebida
2. transação SQL commitada
3. processo morre
4. DeleteMessage não acontece
5. SQS redeliver
6. nova instância recebe a mesma mensagem
```

A segunda execução encontra a Inbox/idempotência já persistida e não reaplica o débito/crédito.

Esse cenário possui teste de integração com PostgreSQL e MiniStack, incluindo falha simulada exatamente entre commit e ACK e recriação do consumer/store para representar restart.

---

## 9. Reversões

### REFUND

- exige referência;
- referencia apenas BET processada;
- mesmo provider, player, wallet, currency e round;
- valor deve ser igual ao da referência;
- uma mesma referência não pode receber dois REFUNDs processados.

### ROLLBACK

Pode reverter:

- BET;
- WIN;
- REFUND.

O movimento é o inverso do movimento referenciado.

A restrição é **por tipo de reversão**: uma referência pode possuir um REFUND e um ROLLBACK válidos quando as regras permitirem, mas não dois do mesmo tipo.

Reversão que causaria saldo negativo é rejeitada com failure code próprio e continua auditável.

`gameId` não é usado como requisito de igualdade da referência; o escopo exigido é provider/player/wallet/currency/round.

---

## 10. Referências fora de ordem

REFUND/ROLLBACK podem chegar antes da operação referenciada.

Nesse caso a transação é persistida como:

```text
PENDING_REFERENCE
```

Um worker reprocessa transações devidas.

A política implementada usa:

- backoff exponencial;
- base curta para o ambiente do desafio;
- limite de 5 tentativas;
- rejeição terminal com failure code estável quando a referência não aparece.

Workers concorrentes continuam seguros porque o estado é persistido e protegido no banco.

---

## 11. SQS, erros e DLQ

A entrada SQS reutiliza `ProcessWagerUseCase`.

O consumidor só envia `DeleteMessage` depois do commit.

Categorias operacionais:

- regra de negócio terminal → resultado auditável e ACK;
- erro transitório → mensagem permanece para retry/redelivery;
- mensagem permanentemente inválida → não é confirmada e o broker redireciona para DLQ após o limite configurado.

A fila principal possui RedrivePolicy com `maxReceiveCount = 5`.

No shutdown o worker para de buscar novo trabalho e espera o loop corrente encerrar. Mensagens que não chegaram ao ACK permanecem protegidas pela visibility timeout/redelivery.

---

## 12. Transactional Outbox

Eventos nunca são publicados diretamente durante a transação financeira.

Primeiro são persistidos em `outbox_messages` dentro do mesmo commit da operação.

Depois um publisher assíncrono seleciona mensagens pendentes em lotes usando:

```sql
FOR UPDATE SKIP LOCKED
```

Consequências:

- dois publishers podem trabalhar ao mesmo tempo;
- uma linha não fica bloqueando publishers concorrentes;
- processo que morre deixa a mensagem persistida para outra instância;
- retries possuem backoff.

O broker ainda é at-least-once. O envelope contém `eventId` estável e consumidores externos devem ser idempotentes.

### Eventos

- `WagerTransactionProcessed`
- `WagerTransactionRejected`
- `WalletBalanceChanged`
- `WagerTransactionPendingReference`

`WalletBalanceChanged` só é criado quando existe movimento financeiro.

---

## 13. Reconciliação

O endpoint:

```http
POST /wallets/:walletId/reconciliation
```

reconstrói o saldo a partir do ledger no PostgreSQL e compara com `wallet.balance`.

Invariante:

```text
wallet.balance == Σ CREDIT - Σ DEBIT
```

O cálculo monetário é feito em tipos numéricos exatos do PostgreSQL.

A resposta inclui:

- `storedBalance`;
- `calculatedBalance`;
- `difference`;
- `consistent`;
- `checkedEntries`.

Divergência não é corrigida. Ela é:

- retornada ao chamador;
- registrada em log estruturado;
- incrementada na métrica `reconciliationDivergences`.

Há teste de integração comprovando o invariante após OPENING + BET + WIN.

---

## 14. Observabilidade

### Logs

Logs JSON estruturados incluem quando disponíveis:

- correlationId;
- messageId;
- transactionId;
- walletId;
- providerId.

O serviço evita registrar payload financeiro completo.

### Métricas

`GET /metrics` cobre:

- transações agrupadas por status;
- duplicatas detectadas;
- retries;
- DLQ;
- lock conflicts;
- outbox lag;
- processing latency;
- divergências de reconciliação.

Algumas métricas operacionais são obtidas diretamente do PostgreSQL/SQS, enquanto contadores de runtime são mantidos pela instância.

### Health

```text
GET /health/live
GET /health/ready
```

Readiness depende de PostgreSQL e SQS estarem acessíveis.

---

## 15. Migrations

O schema é versionado por migrations MikroORM.

As migrations são reversíveis e contêm tanto a estrutura quanto constraints/índices necessários às invariantes.

Durante o desenvolvimento foi validado também o fluxo de `down/up` em mudanças sensíveis, incluindo a preservação da proteção de imutabilidade do ledger.

---

## 16. Autenticação

Não implementada por decisão de escopo.

O próprio desafio não pontua autenticação, então o tempo foi concentrado nas áreas de maior risco: correção financeira, concorrência, idempotência e falhas distribuídas.

Desenho de produção:

```text
Provider
   ↓
External IdP (OIDC)
   ↓
Nest AuthGuard
   ↓
HTTP controllers
```

Keycloak, Zitadel ou IdP equivalente poderiam ser usados. Health continuaria aberto.

---

## 17. Test strategy

Validação final:

```text
93 tests passing
0 failures
467 assertions
15 test files
```

Além da suíte Bun, `scripts/test-multi-process.sh` inicia três processos Nest reais.

Casos de maior risco cobertos:

- precisão de Money;
- saldo negativo;
- ledger balanceado;
- idempotência persistente;
- payload conflitante;
- concorrência hot-wallet;
- 50 duplicatas paralelas;
- paralelismo entre wallets;
- ≥ 3 processadores;
- referências fora de ordem;
- Inbox;
- atomicidade;
- crash commit-before-ACK;
- DLQ;
- dois publishers;
- reconciliação final.

Os testes de infraestrutura usam PostgreSQL e MiniStack reais em containers; mocks não substituem completamente a infraestrutura exigida.

---

## 18. Trade-offs e limitações

### MiniStack

É um emulador local. A semântica relevante foi testada no escopo do desafio, mas produção exigiria validação contra AWS SQS real.

### Métricas

Contadores de runtime são locais a cada processo. Em produção seriam exportados para OpenTelemetry/Prometheus e agregados externamente.

### At-least-once

Não é prometido “exactly once delivery”. A solução garante que redelivery seja financeiramente segura e usa identidades estáveis para permitir deduplicação downstream.

### Pending reference polling

Foi escolhida uma implementação simples baseada em worker/polling para manter o escopo controlado. O estado e os locks ficam no banco, portanto múltiplas instâncias continuam corretas.

### Autenticação

Omitida conscientemente e documentada como ponto de extensão.

### Load test

Não foi priorizado porque é diferencial opcional. A prioridade foi provar invariantes e cenários de falha obrigatórios.

---

## 19. Decisão central

A arquitetura não tenta impedir que sistemas distribuídos entreguem mensagens novamente ou que processos falhem.

Ela parte do princípio de que isso **vai acontecer** e garante que o estado financeiro continue correto quando acontecer.
