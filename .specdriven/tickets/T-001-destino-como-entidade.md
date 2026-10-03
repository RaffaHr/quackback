---
id: T-001
title: Destino de tracker vira entidade própria, com migração de compatibilidade
status: done
blockedBy: []
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-001: Destino de tracker vira entidade própria, com migração de compatibilidade

## Entrega (tracer bullet)

Uma instalação GitHub **já conectada, com um repositório e links existentes**, continua criando issues e recebendo
status sync exatamente como antes — só que o destino agora vem de uma linha de `integration_destinations` em vez de
`config.channelId`. Nenhuma reconexão, nenhum link órfão, nenhuma mudança visível ao usuário.

Esta é a fatia que prova que o novo modelo é um superset do antigo antes de qualquer segundo destino existir.

## Critérios de aceite

- [ ] Existe tabela de destinos com `installation_id` (FK para `integrations.id`), `destination_key`,
      referência externa legível (`owner/repo` ou `projectId:issueTypeId`), identidade de webhook e timestamps.
- [ ] A migração cria uma linha por instalação ativa de GitHub e Jira a partir do `config.channelId` atual.
- [ ] O `destination_key` gerado pela migração é **idêntico** ao `syncHash(syncDestination(...))` usado hoje, de
      modo que todo `post_external_links.sync_scope` e `ticket_external_links.sync_scope` existente continua casando.
- [ ] `config.channelId` permanece gravado e é tratado como destino-padrão de compatibilidade; nada o lê dentro de
      `sync/` depois deste ticket, exceto o caminho explícito de fallback.
- [ ] Rollback da migração é possível sem perder links (a tabela é aditiva; `config.channelId` não é removido).
- [ ] `sync/__tests__/provider-contracts.db.test.ts` passa sem alteração de expectativas.

## Seams TDD

- Cálculo do `destination_key` na migração — teste red que monta uma fixture com link pré-existente e prova que o
  `sync_scope` do link continua casando com o destino migrado. Este é o seam que, se errado, órfã todos os links
  em produção.
- Leitura de destino em `lib/server/integrations/sync/identity.ts` — o novo resolvedor devolve o mesmo valor que
  `syncDestination({ channelId: config.channelId }, ...)` devolvia, para instalação de destino único.

## Notas

- Não adiciona nenhum destino novo nem toca UI. Se este ticket sozinho mudar comportamento observável, ele falhou.
- A tabela precisa nascer com o vínculo a times já previsto (ver T-008), mesmo que nulo, para evitar segunda migração.
- `packages/db/src/schema/` + `packages/db/drizzle/`; o projeto tem drift check de constraints multi-coluna que
  exige ordem alfabética nas UNIQUE — ver comentários em `packages/db/src/schema/integrations.ts:129-131`.

## Adendo 2026-09-22 — forma do escopo por time

Decisões D-1 e D-2 de SPEC-0001 fixam a forma da tabela e tornam duas coisas obrigatórias já neste ticket, para
não exigir uma segunda migração em T-008:

- A tabela de destinos nasce com a coluna discriminadora `scope` (`'workspace' | 'teams'`), com CHECK.
- A tabela de junção `destino × time` nasce junto, mesmo que vazia, com FK para `teams` e `ON DELETE CASCADE`
  (acompanhando `principal_role_assignments_team_id_teams_id_fk`).

Critérios de aceite adicionais:

- [ ] Os destinos criados pela migração recebem `scope: 'workspace'` e **nenhuma** associação de time. Isso preserva
      literalmente o comportamento de hoje e não depende de `teams.isDefault` existir.
- [ ] O CHECK/validação que exige ao menos uma associação quando `scope = 'teams'` já existe, mesmo que nada
      escreva `'teams'` até T-008.
- [ ] Rollback continua possível: as duas tabelas são aditivas e `config.channelId` segue intacto.

## Adendo 2026-09-22 (2) — a migração do Jira deixa de ser byte-a-byte

Decisões D-4 e D-6 de SPEC-0001, vindas de [R-0002](../research/R-0002-limites-api-github-jira.md), mudam o
critério central deste ticket. A regra "o `destination_key` gerado pela migração é idêntico ao valor atual"
**continua valendo para o GitHub** e **deixa de valer para o Jira**.

Motivo: a identidade do destino Jira passa a ser só `projectId` (o issue type é mutável e sua mudança dispara o
próprio evento que consumimos), então o `destination_key` calculado muda por construção.

Critérios de aceite revisados para o Jira:

- [ ] O `destination_key` dos destinos Jira deriva de `projectId` apenas; o `issueTypeId` é preservado no destino
      como configuração de criação, fora da identidade.
- [ ] A migração atualiza `sync_scope` em `post_external_links` e `ticket_external_links` para
      `integration_type = 'jira'`, do valor derivado de `projectId:issueTypeId` para o derivado de `projectId`.
- [ ] Fixture com links Jira pré-existentes prova que, depois da migração, o fan-out inbound encontra o link.
      Este é o teste que, se faltar, órfã links em produção.
- [ ] O valor anterior de `sync_scope` é recuperável para rollback (coluna de backup, tabela de migração ou
      derivação determinística a partir do `config.channelId` legado, que segue intacto).
- [ ] Links de outros providers não são tocados pela migração.

## Adendo 2026-09-23 — guarda obrigatória na migração (divergência D-c do planner)

A migração de `sync_scope` do Jira **precisa** filtrar `sync_scope <> ''`, além de `integration_type = 'jira'`:

```sql
WHERE integration_type = 'jira' AND sync_scope <> ''
```

`sync_scope = ''` é um namespace deliberadamente separado: são os links de **referência** criados pelos apps de
sidebar, não links de sync. O schema documenta isso em `packages/db/src/schema/external-links.ts:23`
("Empty for references; only explicitly established sync links have an ownership scope"), e a API pública
depende disso — `getLinkedPosts`, `linkTicketToPost` e `unlinkTicketFromPost` filtram por `sync_scope = ''`
(`lib/server/integrations/apps/service.ts:109-111,132-133,168`).

Sem a guarda, a migração reescreveria essas linhas e **quebraria `/api/v1/apps/linked` e `/api/v1/apps/link`**.
Isso não seria só um bug: derrubaria a classificação **NO_API** da SPEC-0001, cujo rationale é precisamente que a
superfície HTTP pública não é afetada porque opera no namespace `sync_scope = ''`.

- [ ] A migração filtra `sync_scope <> ''` e um teste prova que uma linha de referência (`sync_scope = ''`) de
      `integration_type = 'jira'` sobrevive intacta.

## Execução 2026-09-25 — schema e migração prontos; leitor pendente

**Arquivos:**

- `packages/ids/src/prefixes.ts` + `types.ts` — prefixos `integration_destination` e `integration_destination_team`
- `packages/db/src/schema/integration-destinations.ts` (novo) — as duas tabelas
- `packages/db/src/schema/index.ts` — export
- `packages/db/drizzle/0287_integration_destinations.sql` (novo) + entrada 264 no `_journal.json`

### Desvio consciente do critério de aceite 1: `destination_key` é derivado, não armazenado

O critério pedia a coluna `destination_key` na tabela. **Não a criei.** A tabela guarda `external_ref`; a chave
continua saindo de `syncHash(syncDestination(...))`, a mesma função de sempre.

Três razões, em ordem de força:

1. O hash **dobra as scope keys da instalação** (`organizationName` no GitHub, `cloudId`/`siteUrl` no Jira), que
   vivem na linha de `integrations`, não no destino. Uma cópia gravada fica obsoleta no instante em que a conexão
   muda de org — e o sintoma seria link órfão silencioso, exatamente o que este ticket existe para evitar.
2. Gerar a chave na migração exigiria reimplementar o SHA-256 sobre JSON canônico **em SQL**, criando uma segunda
   implementação do único valor que nunca pode divergir. Derivando, o critério "byte-idêntico" vale por
   construção, não por replicação cuidadosa.
3. T-003 já vai resolver o caminho reverso por "enumerar e recomputar para frente" (decisão do planner), que não
   precisa da chave gravada.

Se preferir a coluna, é aditivo e barato — mas passa a exigir um invalidador quando a config da instalação muda.

### Segundo desvio: a reescrita do `sync_scope` do Jira saiu da migração SQL

Pelo mesmo motivo do item 2 acima. Ela vira **backfill em TypeScript**, seguindo o precedente já existente de
`install-registry.ts` / `installs-backfill-queue.ts` ("Explicit one-shot per-workspace job, never scheduled on
boot"). A guarda `sync_scope <> ''` do adendo de 2026-09-23 continua obrigatória e passa a viver lá.

### Verificado

Migração aplicada sobre um banco em 0286 (o cenário real de produção), com instalações semeadas antes:

| Propriedade                              | Resultado                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Aplicação da migração                    | `EXIT=0`, sem erro                                                                                                             |
| Backfill GitHub                          | `external_ref=acme/api`, `display_label=acme/api`, `external_webhook_id=99`                                                    |
| Backfill Jira                            | `external_ref=10001`, `settings={"issueTypeId":"10004"}`, webhook id **não** copiado (é por conexão)                           |
| Provider sem destino fixado (slack)      | nenhuma linha, corretamente                                                                                                    |
| Idempotência                             | segunda aplicação mantém 2 destinos                                                                                            |
| `config.channelId`                       | intacto nos dois (`github=acme/api`, `jira=10001:10004`) — rollback seguro                                                     |
| Check constraint de `scope`              | rejeita valor fora de `workspace`/`teams`                                                                                      |
| Suites completas                         | **1106/1107** em 142 arquivos (`integrations`, `jobs`, `db`, `ids`); a única falha é o bug de locale do HubSpot, pré-existente |
| Typecheck `packages/db` e `packages/ids` | limpos, exit 0                                                                                                                 |

### Ainda pendente neste ticket

- **O leitor de destino** (`lib/server/integrations/`), que faz `sync/` parar de ler `config.channelId`. Sem ele o
  tracer bullet não fecha: o destino existe na tabela mas ninguém o consome.
- **O backfill TS do `sync_scope` do Jira**, com a guarda `sync_scope <> ''`.
- Os dois seams TDD declarados continuam sem teste.

### Duas limitações de ferramenta encontradas

- **`drizzle-kit generate` não roda neste repositório**, e não por minha causa: os snapshots `0050`, `0051` e
  `0052` em `drizzle/meta/` têm o **mesmo `id` e o mesmo `prevId`**, e a CLI aborta com colisão. É pré-existente
  (`git status` limpo nesse diretório). Não é bloqueio real: há 264 migrações para 38 snapshots, ou seja, o
  projeto escreve migração à mão — foi o que fiz, seguindo o estilo de `0284_integration_sync.sql`.
- **`db:check-drift` não roda sem bun**: o script chama `Bun.plugin(...)` diretamente. Então a paridade
  schema↔migrações **não foi provada por ferramenta**, só por aplicação real da migração e pelas suites. É a
  verificação que falta e que só o gate com bun fecha.

## Execução 2026-09-25 (2) — leitor de destino entregue

Seam 2 do ticket ("Leitura de destino") fechado por TDD real: 6 testes vermelhos, depois 6 verdes.

**Arquivos:**

- `apps/web/src/lib/server/integrations/__tests__/destinations.db.test.ts` (novo) — 6 testes DB-bound
- `apps/web/src/lib/server/integrations/destinations.ts` (novo) — `listInstallationDestinations`
- `apps/web/src/lib/server/db.ts` — exporta as duas tabelas novas (o barrel é explícito por causa do bundler,
  e o `.oxlintrc.json` proíbe `lib/**` de importar `@quackback/db/*` direto)
- `packages/ids/src/index.ts` — exporta os dois tipos novos

**O teste que importa** é o caso 2: a linha semeada pela migração produz **a mesma chave** que
`config.channelId` produzia. Essa igualdade é a prova de que nenhum link vira órfão. Nenhum digest é hardcoded
nos testes — todo valor esperado sai de uma chamada real a `syncDestination`/`syncHash`, então um hash fixo não
pode passar verde enquanto o caminho de produção muda embaixo.

O caso 3 fixa o oposto de propósito: para o Jira, a chave derivada de `10001` **difere** da derivada de
`10001:10004`. É a documentação executável de por que o backfill de `sync_scope` é necessário (D-4/D-6).

### Governança de migração atualizada

Adicionar a migração deixou **duas** suites vermelhas de propósito, e ambas foram tratadas como o repositório
manda, não contornadas:

- `policy/migration-contract/CONTRACT.md` — snapshot regenerado. Mudou **só** a contagem (264 → 265); o total de
  migrações com DDL destrutivo continua **36**, confirmando que `0287` é puramente aditiva na visão do scanner.
- `fleet/__tests__/migrator-gate.test.ts` — a lista do span pós-0248 é mantida à mão exatamente para que uma
  migração nova a deixe vermelha; `0287_integration_destinations` foi acrescentado.

**Questão em aberto para revisão:** a migração escreve dados (o `INSERT` do backfill e o `UPDATE` do webhook id).
Num replay sobre banco já migrado, o `CREATE TABLE IF NOT EXISTS` é no-op e o `INSERT` tem `ON CONFLICT DO
NOTHING`, mas dois casos estreitos mutam: destino removido à mão com `config.channelId` ainda apontando para ele,
e `external_webhook_id` limpo deliberadamente. Isso pode qualificar para uma entrada em `REPLAY_OVERRIDES`
(`policy/migration-contract/replay-safety.ts`). **Não adicionei**: aquele arquivo exige verdicts _medidos_, não
raciocinados, e a medição é `lineage-double-apply.db.test.ts`, que falha no HEAD por motivo alheio.

### Verificado

| Checagem                                                | Resultado                                                |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `destinations.db.test.ts`                               | 6/6 (rodando de verdade, não `skipped`)                  |
| Suite ampla (`lib/server`, `integrations`, `db`, `ids`) | **59 falhas — idêntico ao baseline do HEAD**, diff vazio |
| Total de testes                                         | 11.228 (baseline: 11.199) em 1.009 arquivos              |
| oxlint nos arquivos novos                               | limpo                                                    |
| `tsc --noEmit` web                                      | 821, **idêntico ao baseline**, zero nos arquivos tocados |
| `tsc` de `packages/db` e `packages/ids`                 | exit 0                                                   |

### Ainda pendente

- **`sync/` continua lendo `config.channelId`.** O leitor existe e está provado, mas não foi ligado — o critério
  "nada o lê dentro de `sync/` depois deste ticket" **não está cumprido**. É o que falta para o tracer bullet.
- **Backfill TS do `sync_scope` do Jira**, com a guarda `sync_scope <> ''`.
- **Seam 1 do ticket segue sem teste**: fixture com `post_external_links`/`ticket_external_links` pré-existentes
  provando que o link sobrevive à migração. O caso 2 acima prova a igualdade da chave, que é a metade difícil,
  mas não exercita linhas de link reais.

## Execução 2026-09-25 (3) — `sync/` ligado ao leitor; Jira ressequenciado para T-006

### Ressequenciamento: a separação de identidade do Jira saiu deste ticket

A versão anterior da `0287` partia o Jira em `external_ref = projectId` e mandava o `issueTypeId` para `settings`,
conforme o adendo (2) deste ticket. **Ligar o leitor em `sync/` em cima daquilo quebraria o Jira em produção**, e
de dois jeitos no mesmo deploy:

1. **Criação de issue.** Nada grava `issueTypeId` no config da instalação — o tipo vive _só_ dentro da string
   `projectId:issueTypeId`, e tanto `jira/server/hook.ts:57` quanto `jira/server/issues.ts:73` o extraem dali.
   Com o alvo reduzido a `{ channelId: '10001' }`, o hook não acha tipo nenhum, e o Jira exige `issuetype` para
   criar. **Toda criação de issue falharia.**
2. **Status sync.** A chave derivada de `10001` difere da derivada de `10001:10004`, então o `sync_scope` de todo
   link Jira existente deixaria de casar até o backfill rodar — o status sync pararia em silêncio.

O próprio ticket diz: _"Se este ticket sozinho mudar comportamento observável, ele falhou."_ Então a `0287` foi
reescrita para **espelhar `config.channelId` exatamente, em todo provider**, sem separação. Reverificada do zero
sobre banco em 0286: `external_ref = config.channelId` para GitHub **e** Jira (`identico = t` nos dois).

A decisão D-4 **não foi revertida** — só mudou de ticket. Identidade por projeto, backfill de `sync_scope` e o
issue type vindo de `settings` são três metades de uma mesma mudança, e as três passam a aterrissar juntas no
T-006. A migração ainda não havia rodado em ambiente real, então reescrevê-la custou nada.

### A troca em `sync/`

Dois helpers novos em `destinations.ts`, e a distinção entre eles é o ponto:

- **`findInstallationDestination(integration, key)`** — acha o destino pela chave da operação. **Exato para
  qualquer número de destinos**, porque a operação já nomeia seu destino. Usado em `tickets.ts` e `remote.ts`.
- **`defaultInstallationDestination(integration)`** — para quem **não tem chave** para procurar: mapping legado
  sem `actionConfig.channelId`, ou inbound sem `destinationId` assinado. Só é exato com um destino; está
  documentado como ponte, e cada chamador é substituído no ticket que o torna multi-destino.

| Ponto             | Mudança                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync/tickets.ts` | resolve o destino pela chave, **e passa o mesmo destino como alvo da criação** — antes a checagem de chave e o `auth.channelId` vinham de leituras separadas do config e poderiam divergir com N destinos |
| `sync/remote.ts`  | operações de criação de ticket gravam `data: {}`; o alvo delas agora é recuperado pela chave                                                                                                              |
| `sync/inbound.ts` | fallback sem `destinationId` usa o destino-padrão, **lido pela transação `tx`**                                                                                                                           |
| `sync/hooks.ts`   | mapping legado usa o destino-padrão, **consultado só quando algum mapping precisa**                                                                                                                       |

Dois cuidados que vieram do próprio repositório:

- **Leitura pela transação.** `fanOutInboundStatus` roda dentro de uma transação. Abrir outra conexão via `db`
  global num pool de um slot faria a chamada esperar por si mesma — o `integrations/README.md` trata exatamente
  desse risco para credenciais. O leitor aceita um executor opcional, e o inbound passa `tx`.
- **Caminho quente.** `executeHookSync` é atravessado por toda notificação de todo provider. Consultar destinos em
  cada entrega seria uma query a mais por mensagem de Slack. A consulta só acontece se algum mapping carece de
  `actionConfig.channelId`, o que não é o caso de nenhuma rota de canal do Slack.

**Por que isso é seguro para todos os providers, não só trackers:** Slack, Discord, Linear, Asana e os demais
passam por `hooks.ts` e `inbound.ts`, mas a `0287` só semeia GitHub e Jira. Para eles o leitor cai no fallback de
compatibilidade e devolve o próprio `config.channelId`. Idêntico por construção.

### Verificado

| Checagem                            | Resultado                                                              |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Todas as suites de `sync/` + leitor | **85/85**, incluindo `provider-contracts` sem alteração de expectativa |
| Suite ampla                         | **59 falhas — idêntico ao baseline**, diff vazio                       |
| `tsc` web                           | 821, idêntico ao baseline, zero nos arquivos tocados                   |
| oxlint                              | limpo                                                                  |

### O que falta, e de quem é

- **`sync/identity.ts:63` — `reviewDestination` ainda lê `config.channelId`.** Deliberado. Sua pergunta é "este
  link pertence ao destino atual?", e generalizá-la para N destinos **é** a resolução reversa: o escopo exato do
  T-003. Fazer agora seria implementar o T-003 pela metade. É o único leitor restante em `sync/`.
- **Seam 1 deste ticket segue sem teste**: fixture com `post_external_links` reais provando que o link sobrevive.
  O `provider-contracts` exercita o **fallback de compatibilidade** (as instalações dele não têm linha em
  `integration_destinations`); o caminho com linha migrada está provado pela igualdade de chave do caso 2 do
  leitor, mas não por um fluxo de sync de ponta a ponta. É a lacuna que resta para fechar o tracer bullet.

## Fechamento 2026-09-25 — tracer bullet provado de ponta a ponta

### O teste que fecha o ticket

`apps/web/src/lib/server/integrations/sync/__tests__/destination-source.db.test.ts` — 9 testes, todos rodando
contra Postgres real.

**Não foi test-first.** A implementação já existia quando o teste foi escrito, então ele passou de primeira e não há
evidência de vermelho-antes-do-verde. Isso não deve entrar no manifesto como seam TDD cumprido.

No lugar, o teste traz **controles positivos**, e foram provados por execução, não por raciocínio:

- **Quebra 1** — o leitor passa a ignorar a tabela (`if (false && rows.length > 0)`): **8 de 9 ficam vermelhos**.
  Os verdes caem só na pré-condição de `id`; a prova está nos controles, que afirmam **para qual repositório** a
  issue é criada.
- **Quebra 2** — a criação volta a usar `credentials.config.channelId` em vez do destino resolvido: **exatamente o
  caso 2c fica vermelho**, isolando a propriedade "o destino resolvido é o alvo da criação".

As duas quebras foram revertidas a partir de backups byte a byte; conferido por ausência de resíduo e por
`git status` idêntico ao anterior, exceto o arquivo de teste novo.

O teste não escreve a linha de destino à mão: ele extrai os comandos `INSERT`/`UPDATE` da própria `0287` e os
executa. Então ele prova a migração real, não uma cópia dela.

### Correção a um número que reportei

Eu havia registrado **59** falhas pré-existentes na suíte ampla. **Uma delas era minha.** Ao semear
`integration_sync_start` no banco de teste usei `2000-01-01`, raciocinando que uma data antiga evitaria que dados de
teste caíssem antes da fronteira. Errado: `ticket-external-links.service.test.ts` retrodata um ticket para 2020 e
**espera** que ele seja rejeitado como anterior ao sync — o que exige fronteira depois de 2020. A migração `0284`
usa o default `now()`; a semente agora espelha isso.

Reapurado com a semente corrigida, as duas medições sobre o mesmo banco:

|                           | Falhas | Testes |
| ------------------------- | ------ | ------ |
| Baseline (HEAD)           | 62     | 11.199 |
| Com as mudanças           | 58     | 11.237 |
| Falhas só com as mudanças | **0**  |        |

As 4 de diferença (`seat-usage.db.test.ts` ×3, `invitations-accept.db.test.ts` ×1) **não foram corrigidas por
este trabalho** — não têm relação com integrações. São testes de corrida e serialização que passam **5 de 5**
isolados e falham sob a suíte paralela, que roda ~1.000 arquivos contra um único banco. Flakiness por contenção.
O número estável é **58**.

### Estado contra os critérios de aceite

| Critério                                                               | Estado                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| Tabela com FK, referência externa, identidade de webhook, timestamps   | ✅                                                        |
| Coluna `destination_key`                                               | **Desvio aprovado** — derivada, não armazenada            |
| Migração cria uma linha por instalação ativa GitHub/Jira               | ✅                                                        |
| Chave idêntica a `syncHash(syncDestination(...))`                      | ✅ por construção; provado pelo leitor e de ponta a ponta |
| `config.channelId` preservado como padrão de compatibilidade           | ✅                                                        |
| Nada em `sync/` lê `config.channelId`                                  | ⚠️ **exceto `reviewDestination`** → transferido ao T-003  |
| Rollback sem perder links                                              | ✅ tabelas aditivas, config intacto                       |
| `provider-contracts` sem alteração de expectativa                      | ✅ 23/23                                                  |
| Destinos migrados com `scope = 'workspace'` e sem time                 | ✅                                                        |
| Invariante "`scope = 'teams'` exige ao menos um time"                  | ❌ **não implementado** → transferido ao T-008            |
| Separação de identidade do Jira + backfill + guarda `sync_scope <> ''` | → **transferido ao T-006**                                |

Sobre o invariante de times: ele atravessa duas tabelas, então **não cabe num `CHECK`** — o `CHECK` atual só
garante que `scope` seja um dos dois valores. Precisaria de trigger com constraint adiada, ou de validação no
caminho de escrita. Como nada grava `'teams'` antes do T-008, a validação pertence a esse caminho de escrita.

### Dívida que este ticket deixa explícita

Três pontos **fora de `sync/`** — onde o trabalho é _enfileirado_ — ainda leem `config.channelId`:
`buildIntegrationTargets` (`events/resolvers/integration.resolver.ts`), `createIssueForTicket` e
`linkTicketToIssue` (`domains/tickets/ticket-external-links.service.ts`). O critério deste ticket cobre só `sync/`,
então isso é permitido. Mas os controles 1b e 2b mostram a consequência exata: **se a linha e o config
divergirem, a entrega é cancelada** em vez de seguir a linha. Hoje não divergem, porque a `0287` espelha o config.
Deixam de ser seguros no momento em que um destino puder divergir do config — T-005 e T-011 precisam trocá-los.

## Correção 2026-09-25 — regressão introduzida por este ticket, e corrigida

### O que eu havia afirmado, e estava errado

No fechamento registrei que a divergência entre linha e config era dívida **futura**: _"Hoje não divergem, porque
a `0287` espelha o config."_ **Falso.** A `0287` espelha o config **no instante da migração**. A tela de
configurações atual continua escrevendo só `config.channelId`:

- `integrations/github/ui/github-config.tsx:114` — `updateMutation.mutate({ id, config: { channelId: ownerRepo } })`
- `integrations/jira/ui/jira-config.tsx:145` — idem, com `projectId:issueTypeId`

e `updateIntegrationFn` não tinha **nenhuma** referência a `integration_destinations`. Então, depois da migração:

1. Linha = `acme/api`, config = `acme/api`.
2. Admin troca o repositório na tela existente → só o config vira `acme/web`.
3. O resolver enfileira a issue para `acme/web`; o `hooks.ts` agora confia na linha, `acme/api ≠ acme/web` →
   **cancelado como `installation_changed`**, sem erro em lugar nenhum.

**Toda criação automática de issue parava depois de qualquer troca de repositório ou de issue type.** Os controles
1b/2b do teste de ponta a ponta demonstravam exatamente esse mecanismo, e eu os classifiquei como futuro.

### A correção

`syncLegacyDestination(integration, channelId, executor)` em `destinations.ts`, chamada por `updateIntegrationFn`
**na mesma transação** da escrita do config:

- Instalação **com** linha → a linha acompanha a escrita (atualizada no lugar, mantém o `id`).
- Instalação **sem** linha → nada muda; o config segue sendo a fonte. Criar linha ali seria uma segunda fonte.
- **Mais de uma** linha → recusa com `DESTINATIONS_MANAGED_ELSEWHERE`. A tela de seleção única não tem como dizer
  qual linha quis dizer, e ignorar a escrita recriaria a divergência. Como é a mesma transação, **o config também
  não muda** — nada é aplicado pela metade.
- `external_webhook_id` da linha vira `NULL` quando a referência muda: ele fora registrado no repositório anterior,
  e manter um valor sabidamente errado não é aceitável, mesmo que ninguém o leia ainda.
- É **agnóstico de provider**: o critério é "esta instalação já tem linha", não `integration_type`.

### Verificação

TDD real no nível da função: 4 testes vermelhos (`syncLegacyDestination is not a function`), depois verdes.

A ligação em `updateIntegrationFn` foi escrita antes do seu teste, então tem **controle positivo** em vez de
vermelho-primeiro: com a chamada removida, **exatamente os 2 testes que deveriam** ficam vermelhos (mover a linha;
recusar sem aplicar pela metade), e o terceiro — um caso negativo — passa dos dois jeitos. Restauração conferida
por hash idêntico.

|                                                                        |                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `destinations.db.test.ts`                                              | 10/10                                                       |
| `functions/__tests__/update-integration-destination.db.test.ts` (novo) | 3/3                                                         |
| Suíte ampla                                                            | **58 falhas = baseline estável, zero novas**; 11.244 testes |
| `tsc` web                                                              | 821 = baseline                                              |

### O que isso exige do T-005

Registrado lá também. Duas coisas deixam de ser opcionais:

1. **A tela nova não pode escrever `config.channelId`.** Enquanto ele for escrito, a ponte o sincroniza — e, pelo
   `canDispatchSync`, qualquer mudança nele altera o hash do config e cancela **todas** as operações em voo da
   instalação, não só as do destino alterado. Esse é o objetivo do T-004, e ele só se realiza plenamente quando a
   gestão de destinos parar de passar pelo config.
2. **Remover o último destino não pode ressuscitá-lo.** O leitor cai no fallback de `config.channelId` quando a
   instalação não tem linha. Se o admin remover todas as linhas e o `config.channelId` ainda apontar para um delas,
   o destino removido volta a receber entregas. O caminho de remoção precisa limpar o `config.channelId` junto, ou o
   leitor precisa parar de cair no fallback para instalações que já foram migradas.
