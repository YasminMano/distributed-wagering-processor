---
name: financial-domain-review
description: Revisar alterações no domínio financeiro quanto à correção, precisão, invariantes, idempotência e riscos de concorrência.
---

# Revisão do Domínio Financeiro

Use esta skill ao revisar alterações envolvendo:

- Money;
- Wallet;
- WagerTransaction;
- WalletLedgerEntry;
- comportamento de REFUND ou ROLLBACK;
- persistência financeira;
- operações que alteram saldo.

## Procedimento de Revisão

### 1. Precisão Monetária

Verifique se:

- JavaScript `number` nunca é usado para representar valores monetários;
- valores monetários de entrada são interpretados a partir de strings decimais;
- notação científica é rejeitada;
- formatos inválidos ou escala decimal excessiva são rejeitados;
- operações aritméticas usam cálculos decimais exatos;
- valores monetários serializados usam exatamente duas casas decimais.

### 2. Segurança de Moeda

Verifique se:

- todo valor Money contém uma moeda;
- operações aritméticas entre moedas diferentes são rejeitadas;
- comparações entre moedas diferentes são rejeitadas quando aplicável.

### 3. Imutabilidade

Verifique se:

- objetos Money são imutáveis;
- lançamentos do ledger nunca são alterados ou excluídos;
- operações retornam novos valores em vez de alterar valores financeiros existentes.

### 4. Invariantes da Wallet

Verifique se:

- o saldo da wallet nunca fica negativo;
- a versão da wallet muda somente quando o saldo muda;
- toda alteração de saldo possui exatamente um lançamento correspondente no ledger.

### 5. Idempotência

Verifique se:

- entregas duplicadas não podem causar efeitos financeiros duplicados;
- a idempotência é persistida, e não mantida apenas em memória da aplicação;
- payloads conflitantes usando a mesma idempotency key são detectados.

### 6. Concorrência

Verifique se:

- sequências de leitura-cálculo-escrita não podem causar lost updates;
- a correção não depende de uma única instância da aplicação;
- locks ou operações atômicas no banco são restritos à wallet, e não globais.

### 7. Limites Transacionais

Verifique se escritas financeiras relacionadas são atômicas.

Quando aplicável, a mesma transação SQL deve conter:

- estado da transação;
- alteração do saldo da wallet;
- lançamento no ledger;
- estado da Inbox;
- evento da Outbox.

Eventos não devem ser publicados antes do commit da transação financeira.

### 8. Testes

Verifique se os testes relevantes cobrem:

- comportamento de sucesso;
- entradas monetárias inválidas;
- incompatibilidade de moeda;
- saldo insuficiente;
- execução duplicada;
- execução concorrente;
- invariantes financeiras.

## Saída da Revisão

Relate os achados usando:

- CRITICAL: pode violar a correção financeira;
- WARNING: design arriscado ou cobertura ausente;
- OK: invariante verificada explicitamente.

Não recomende enfraquecer constraints do banco de dados ou invariantes de domínio apenas para fazer os testes passarem.
