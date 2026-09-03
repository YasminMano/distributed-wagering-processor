# AGENTS.md

## Projeto

Distributed Wagering Processor para o desafio Backend da Jungle Gaming.

## Objetivo

Construir um processador distribuído de apostas financeiramente correto, que permaneça consistente diante de entregas duplicadas, processamento concorrente e falhas.

## Stack Obrigatória

- Bun 1.x
- TypeScript em modo strict
- NestJS
- PostgreSQL
- MikroORM
- AWS SQS por meio do LocalStack
- Docker Compose

## Princípios de Engenharia

- A lógica de domínio não deve depender do NestJS.
- Money nunca deve usar JavaScript `number`.
- Escritas financeiras devem ser transacionais.
- PostgreSQL é a autoridade final para consistência.
- A idempotência deve ser persistente.
- Lançamentos do ledger são imutáveis.
- Eventos nunca devem ser publicados antes do commit da transação financeira.
- A aplicação deve permanecer correta com múltiplas instâncias em execução.

## Antes de Alterar o Código

1. Identifique a invariante de negócio afetada.
2. Entenda o limite da transação.
3. Considere execução concorrente.
4. Considere entrega duplicada ou retry.
5. Prefira a menor alteração correta.
6. Não enfraqueça constraints do banco de dados apenas para fazer os testes passarem.

## Validação

Antes de considerar uma alteração concluída, execute as verificações relevantes:

```bash
bun run lint
bun run typecheck
bun test
```

## Git

- Use commits focados.
- Prefira Conventional Commits.
- Revise as alterações staged antes de fazer commit.
- Não faça commit de secrets nem de arquivos temporários gerados.
- Use fixup commits apenas ao corrigir um commit existente.

## Segurança de Git para Agentes

- Nunca faça commit de alterações sem aprovação explícita do usuário.
- Nunca faça push de alterações para o repositório remoto sem aprovação explícita do usuário.
- Sempre mostre o diff e os resultados de validação antes de propor um commit.
