# AI Usage

## Objetivo deste documento

Este projeto utilizou ferramentas de Inteligência Artificial como apoio durante o desenvolvimento. O objetivo deste documento é registrar esse uso de forma transparente, sem atribuir às ferramentas decisões, validações ou domínio que não tiveram, e sem sugerir que o trabalho foi simplesmente gerado de forma automática.

O desafio envolvia vários conceitos de sistemas distribuídos e processamento financeiro que exigiram estudo, pesquisa, experimentação e validação prática durante a implementação.

---

## Ferramentas utilizadas

### Codex CLI

Codex foi o principal assistente de implementação enquanto esteve disponível.

Foi usado para:

- auxiliar na escrita e refatoração de código;
- trabalhar sobre tarefas delimitadas do backlog;
- implementar partes do domínio, persistência e mensageria;
- gerar/revisar testes;
- revisar trechos contra requisitos do desafio.

O agente recebeu contexto persistente do repositório em vez de ser usado somente com prompts isolados.

### ChatGPT

ChatGPT foi utilizado de forma mais ampla ao longo do desafio para:

- decompor o enunciado em requisitos verificáveis;
- explicar conceitos que ainda não eram familiares;
- discutir alternativas arquiteturais e trade-offs;
- orientar a preparação do ambiente WSL/Docker/Bun;
- configurar e depurar PostgreSQL, MiniStack e SQS;
- investigar erros de migrations, concorrência, Outbox e redelivery;
- revisar os requisitos do desafio contra a implementação;
- planejar testes de integração e concorrência;
- gerar/revisar testes adicionais de resiliência;
- analisar resultados reais dos testes executados;
- apoiar a documentação final.

Depois que a cota do Codex ficou indisponível, ChatGPT também foi utilizado para apoiar os ajustes finais, sempre acompanhados de execução e validação local.

---

## AGENTS.md e project skill

Foi criado um `AGENTS.md` para fornecer aos agentes contexto e restrições do projeto.

Entre outras coisas, ele ajudou a transformar requisitos do desafio em guardrails, reduzindo o risco de uma ferramenta sugerir alterações incompatíveis com as invariantes financeiras ou com o fluxo Git.

Também foi criada a skill:

```text
.agents/skills/financial-domain-review/SKILL.md
```

Ela foi utilizada como checklist contextual para revisão de aspectos como:

- representação de Money;
- saldo não negativo;
- ledger auditável;
- idempotência;
- concorrência;
- reversões;
- atomicidade.

A skill não substitui testes nem validação humana. O objetivo foi tornar a assistência da IA mais consistente com as regras específicas deste projeto.

---

## O que as ferramentas de IA fizeram

As ferramentas ajudaram materialmente a produzir código, testes e documentação.

Isso inclui geração de implementações iniciais, sugestões de refatoração, identificação de casos de borda e criação de testes adicionais.

Nem toda sugestão foi aceita como correta.

Durante a revisão, por exemplo, interpretações incorretas sobre regras de reversão precisaram ser confrontadas com o enunciado original e corrigidas. Isso reforçou a necessidade de usar o desafio como fonte de verdade e validar as respostas das ferramentas.

---

## Processo de desenvolvimento e validação

As ferramentas de IA foram utilizadas como apoio ao longo do desenvolvimento, mas o trabalho também envolveu pesquisa, experimentação, tomada de decisão e validação prática.

Ao longo do desafio, eu:

- analisei e organizei os requisitos do enunciado;
- pesquisei conceitos de sistemas distribuídos e processamento financeiro necessários para a implementação;
- avaliei alternativas de arquitetura e seus trade-offs;
- configurei o ambiente com WSL, Docker Desktop, Bun, PostgreSQL e MiniStack;
- acompanhei a evolução do repositório por meio de commits e releases;
- executei migrations e validei sua reversibilidade;
- executei os testes e analisei seus resultados;
- investiguei falhas encontradas durante a execução;
- confrontei sugestões das ferramentas de IA com o enunciado original quando surgiram divergências;
- validei cenários de idempotência, concorrência, ledger, redelivery, Inbox e Outbox;
- executei cenários com múltiplos processos independentes;
- revisei a implementação e a documentação antes da entrega.

Alguns dos conceitos utilizados no projeto, principalmente os relacionados a concorrência distribuída, Inbox/Outbox, idempotência e semântica de mensageria, exigiram estudo durante o desenvolvimento. Esse processo de pesquisa e validação fez parte da construção da solução.

---

## Testes e validação

IA foi utilizada para auxiliar na geração e revisão de testes, mas os resultados registrados na entrega vêm de execução local real pela candidata.

Validação final:

```text
bun run typecheck
bun run lint
bun test
bun run build
git diff --check
```

Resultado final da suíte Bun:

```text
93 pass
0 fail
467 expect() calls
15 arquivos de teste
```

A suíte inclui integração com PostgreSQL e MiniStack reais.

Além disso, foi executado um cenário separado com três processos Nest independentes através de:

```bash
./scripts/test-multi-process.sh
```

Os resultados dos testes não foram assumidos a partir da geração da IA; falhas encontradas durante a execução foram investigadas e corrigidas antes da documentação final.

---

## Exemplos de colaboração humano + IA

### Ambiente local

A configuração inicial de Docker, PostgreSQL e SQS envolveu tentativa, erro e pesquisa. LocalStack apresentou uma barreira de autenticação no ambiente escolhido; MiniStack foi avaliado e adotado por ser permitido pelo desafio.

### Regras de reversão

Uma revisão automatizada inicialmente sugeriu restrições mais fortes do que o enunciado. O requisito oficial foi relido e a interpretação foi corrigida:

- REFUND referencia BET;
- ROLLBACK referencia BET/WIN/REFUND;
- duplicidade é proibida por mesmo tipo de reversão;
- `gameId` não faz parte do escopo obrigatório de igualdade da referência.

### Crash após commit

O cenário “commit financeiro concluído, processo morre antes do ACK” foi construído e executado contra PostgreSQL/MiniStack. O teste confirmou que a redelivery é reconhecida como duplicata e não reaplica o débito.

### DLQ

Os primeiros testes de DLQ dependiam de timing do emulador e falharam de forma não determinística. Logs, estado interno do MiniStack e comportamento de visibility timeout foram analisados. O teste final foi isolado em filas temporárias e passou a validar cinco entregas sem ACK e o redrive para a DLQ de forma determinística.

### Outbox concorrente

Ao rodar a suíte inteira, um teste de publishers passou isoladamente mas falhou junto com os demais por compartilhar registros pendentes da Outbox. A causa foi investigada e o teste foi isolado deterministicamente sem alterar a semântica do worker.

---

## Responsabilidade final

As ferramentas de IA foram utilizadas como **assistentes de desenvolvimento**, não como autoridade sobre o comportamento correto do sistema.

A fonte de verdade permaneceu sendo:

1. o enunciado do desafio;
2. as invariantes financeiras;
3. o comportamento observado em PostgreSQL/MiniStack;
4. os testes executados;
5. a revisão final da candidata.

A responsabilidade pela entrega, pelas decisões adotadas e pela validação do resultado final permanece com a candidata.
