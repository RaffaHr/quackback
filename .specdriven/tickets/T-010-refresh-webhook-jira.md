---
id: T-010
title: Renovar webhooks dinâmicos do Jira antes dos 30 dias
status: in-progress
blockedBy: []
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-010: Renovar webhooks dinâmicos do Jira antes dos 30 dias

## Entrega (tracer bullet)

Um webhook Jira registrado há mais de 30 dias continua entregando eventos, porque um job periódico chama
`PUT /rest/api/3/webhook/refresh` antes de ele expirar.

## Critérios de aceite

- [ ] Existe um job periódico que renova os webhooks dinâmicos das conexões Jira ativas, com folga confortável
      antes do vencimento (não na véspera).
- [ ] A renovação é idempotente e tolera o webhook já ter sido removido do lado do Jira.
- [ ] Falha de renovação é observável: registra `lastError`/`lastErrorAt` na instalação, alimentando o
      `IntegrationHealthPanel`, em vez de falhar em silêncio.
- [ ] Um webhook que já expirou é **re-registrado**, não só renovado. A Atlassian mantém webhooks expirados
      disponíveis por até 3 meses, mas o caminho de recuperação não pode depender disso.
- [ ] Teste com relógio controlado provando que a renovação dispara antes da expiração.

## Seams TDD

- Agendamento e janela de renovação — teste red que prova que hoje nada renova.
- Caminho de webhook já expirado ou removido remotamente → re-registro.

## Notas

**Este é um bug de produção pré-existente, não parte de multi-destino.** Levantado durante a pesquisa de T-002 e
verificado por busca direta: não existe nenhuma chamada a `/rest/api/3/webhook/refresh` em `apps/web/src` nem em
`packages` — só `refreshJiraToken`, que renova o **token OAuth**, coisa diferente.

Fonte primária (R-0002): _"The expiration period is 30 days from the time the webhook was created or refreshed"_ e
_"it's necessary to periodically call the Extend webhook life API to keep them alive. Each call to the API extends
the expiration date by another 30 days."_

Consequência provável hoje: o status sync do Jira para de funcionar ~30 dias após a conexão, sem erro visível —
o webhook simplesmente deixa de entregar. Vale confirmar empiricamente numa conexão Jira antiga antes de dimensionar.

Interação com SPEC-0001: a decisão D-5 (um webhook por conexão, com `project IN (...)`) **barateia** este ticket —
há um único id de webhook para renovar por conexão, não N. Mas T-010 não depende de D-5 e pode ser entregue antes,
já que o bug é atual.

Escopo OAuth necessário para o refresh, conforme R-0002: `read:jira-work` + `manage:jira-webhook` (o mesmo usado
no registro, então nenhuma mudança de escopo é esperada — confirmar contra o que a app pede hoje).

## Execução 2026-09-25 — parcial

Ciclo TDD real no seam de API: 13 testes vermelhos (`TypeError: refreshJiraWebhooks is not a function`) antes
da implementação, 13 verdes depois.

**Arquivos:**

- `apps/web/src/integrations/jira/server/__tests__/webhook-refresh.test.ts` (novo) — 13 testes
- `apps/web/src/integrations/jira/server/webhook-registration.ts` — `refreshJiraWebhooks(accessToken, cloudId)`
- `apps/web/src/lib/server/integrations/types.ts` — `webhookRegistration.refresh?` opcional
- `apps/web/src/integrations/jira/server/index.ts` — declara a capability
- `apps/web/src/lib/server/integrations/webhook-refresh-queue.ts` (novo) — sweep capability-gated
- `apps/web/src/lib/server/jobs/definitions.ts` + `JOBS.md` — fila `integration-webhook-refresh`, `40 3 * * *`

**Decisões:**

- **Capability-gated, não provider-gated.** O sweep varre qualquer provider que declare
  `webhookRegistration.refresh`; Jira é o único hoje. Segue a regra do `integrations/README.md`
  ("capability-gated, never provider-id-gated") e evita `if (type === 'jira')` no framework.
- **`refreshJiraWebhooks` retorna, nunca lança**, com `{ status, stage?, error? }`. Promise rejeitada dentro de
  sweep periódico é fácil demais de engolir, e o critério 3 exige falha observável.
- **`expirationDate` nunca é lido.** O schema oficial diz `integer/int64`, os exemplos oficiais mostram string
  ISO — divergência sistemática em todo o grupo de webhooks (ver R-0002). O status 200 decide sucesso. Quatro
  dos 13 testes cobrem int64, ISO, campo ausente e os dois misturados na mesma página.
- **Paginação por aritmética de `startAt`**, não seguindo o `nextPage` do corpo — não mandar bearer para URL que
  veio numa resposta. Difere de propósito do GitHub, onde seguir o header `link` é o mecanismo documentado.
- **`maxAttempts: 3`**, contra o default 1 do registry: o refresh é idempotente (ids não reconhecidos são
  ignorados pelo servidor) e falha transitória não deve esperar o slot do dia seguinte.
- **Cadência diária** contra expiração de 30 dias: ~29 dias de folga, então downtime de worker não custa webhook.

**Verificação** (com vitest/tsc/oxlint fixados no repo, via `node` — `bun` ausente):

| Checagem                                                                                                   | Resultado                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `registry-doc` + `handler-imports` + `folder-conformance` + `registry-capability-coverage` + jira + github | 109 passed (10 arquivos)                                       |
| oxlint nas três pastas tocadas                                                                             | só warnings pré-existentes, nenhum nos arquivos novos          |
| `tsc --noEmit`                                                                                             | 821 erros, idêntico ao baseline, **zero** nos arquivos tocados |

### O que NÃO foi entregue, e por quê

- **Critério de aceite 4 — re-registro de webhook já expirado: NÃO implementado.** E há um buraco a registrar:
  ids não reconhecidos são ignorados pelo servidor, então um webhook expirado e já colhido pelo Jira faz a
  listagem voltar vazia e o sweep reportar `nothing-to-refresh` — que hoje é tratado como situação normal.
  Para uma conexão com `statusSyncEnabled` e `externalWebhookId` gravado, "nada para renovar" é **alarme**, não
  OK. Fechar isso exige comparar a listagem com o que o config diz que deveria existir e reentrar no caminho de
  registro (callback URL + secret), que vive no módulo compartilhado.
- **Critério de aceite 5 — teste com relógio controlado: NÃO feito.** É DB-bound.
- **Critérios 1 e 3 estão implementados mas NÃO verificados em execução.** O sweep lê `integrations`, chama
  `getValidAccessToken` e grava via `recordIntegrationLastError`; nada disso roda sem Postgres. O que está
  provado é que o registry aceita a fila, a tabela do `JOBS.md` bate, os imports são estáticos e a capability
  não quebra a matriz. **O comportamento do job em si permanece não observado.**

~~Postgres não está disponível nesta máquina (`ECONNREFUSED 127.0.0.1:5432`), e as suites DB-bound relevantes
falham no HEAD pelo mesmo motivo — verificado por baseline com as mudanças fora da árvore.~~

### Atualização 2026-09-25 — Postgres disponível, fiação verificada

O parágrafo acima deixou de valer. Com `docker compose up -d postgres` e um banco de teste separado, as suites
DB-bound rodam:

**708 de 709 testes passando** em `lib/server/integrations` + `lib/server/jobs` + `integrations` (83 arquivos).
Inclui `provider-contracts.db.test.ts` (23/23) — o pino de comportamento de provider que o planner identificou
como o principal risco de regressão silenciosa — e as suites de job (`priming`, `migrated-queues`, `runner`,
`job-queue`), que agora exercitam o registry **com a fila `integration-webhook-refresh` registrada**.

A única falha é `enrichment-adapters > hubspotContext`, pré-existente e sem relação (ver "Achado colateral").

Isso eleva o estado dos critérios 1 e 3 de "escritos, não observados" para "a fiação está verificada; o corpo do
sweep continua sem teste próprio". Os critérios 4 e 5 seguem não entregues.

### Como reproduzir o ambiente de teste

O default do `vitest.config.ts` é `postgresql://postgres:password@localhost:5432/quackback_test`, via
**`TEST_DATABASE_URL`** (não `DATABASE_URL`). O volume `quackback_postgres_data` desta máquina foi inicializado
com o papel **`quackback`**, não `postgres` — é por isso que as suites DB vinham sendo puladas em silêncio.

```bash
docker compose up -d postgres
# banco de teste separado, para não tocar os dados de desenvolvimento:
psql -c "CREATE DATABASE quackback_test;"
pg_dump --schema-only --no-owner --no-privileges quackback | psql -d quackback_test
# a linha é criada por migração, e --schema-only não a traz:
psql -d quackback_test -c "INSERT INTO integration_sync_start (id, started_at) VALUES (1,'2000-01-01Z');"
TEST_DATABASE_URL="postgresql://quackback:<senha>@localhost:5432/quackback_test" \
  node node_modules/vitest/vitest.mjs run <caminho>
```

Sem a linha de `integration_sync_start`, 18 dos 23 testes de `provider-contracts` falham com
`Integration sync start boundary is unavailable` — falha de semente, não de código.

### Achado colateral, fora deste ticket

`integrations/hubspot/server/enrichment.ts:16` formata valor de negócio com
`contact.totalDealValue.toLocaleString()` — **sem locale**, portanto o do servidor. Num host pt-BR, US$ 12.000
vira `$12.000`, que em inglês se lê como doze dólares. O `$` também é fixo, independente da moeda real do deal.
É bug de produto, dependente do locale do host, não artefato de teste. Não corrigido: fora do escopo de
SPEC-0001 e a correção envolve decisão de produto (qual locale, e qual moeda).
