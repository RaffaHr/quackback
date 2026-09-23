# R-0001: O Quackback está mesmo limitado a 1 repositório GitHub e 1 projeto Jira? É viável expandir para múltiplos, com escopo por usuário?

- Data: 2026-09-22
- Origem: pedido do usuário (`/specdriven-workflow`) — destrava a decisão de arquitetura antes de qualquer SPEC/plano.
- Estado do workflow: INVESTIGATING concluído; INTAKE pendente (decisão A/B/C abaixo).
- Fingerprint do repositório na investigação: branch `main`, HEAD `67987347d`, working tree limpo.

## Pergunta

1. A limitação de 1 repositório (GitHub) e 1 projeto (Jira) existe de fato no código?
2. É possível expandir para N repositórios e N projetos selecionados?
3. Onde isso impacta e como?
4. É possível escopar por usuário quais repositórios/projetos ele pode usar ao criar postagens, de modo que o post saiba onde vincular?

## Resposta

**1. Sim, confirmado — e a limitação é mais profunda do que "1 repo / 1 projeto".** São três camadas empilhadas:

- **Camada 1 — uma instalação por provider (a mais restritiva).**
  `unique('integration_type_unique').on(table.integrationType)` em
  `packages/db/src/schema/integrations.ts:62` e o `onConflictDoUpdate({ target: [integrations.integrationType] })`
  em `apps/web/src/lib/server/integrations/save.ts:101`. Existe no máximo **uma linha `integrations` por tipo**.
  Consequência: não há como conectar duas contas/orgs GitHub nem dois sites Jira (`cloudId`), mesmo que a UI oferecesse.

- **Camada 2 — um destino por instalação (`config.channelId`).**
  GitHub grava `channelId = "owner/repo"`; Jira grava `channelId = "<projectId>:<issueTypeId>"`.
  UI de seleção única: `apps/web/src/integrations/github/ui/github-config.tsx:112-115` (um `<Select>` de repo) e
  `apps/web/src/integrations/jira/ui/jira-config.tsx:142-146` (projeto + issue type concatenados).

- **Camada 3 — o registro de webhook é preso ao destino único.**
  `apps/web/src/integrations/github/server/index.ts:48-74` registra o hook em `config.channelId` e guarda **um** `externalWebhookId`;
  `apps/web/src/integrations/jira/server/index.ts:36-47` idem, usando `config.channelId.split(':')[0]` como projeto.

**2. Sim, é viável — e boa parte da fundação já existe.** O núcleo de roteamento e de sincronização **já é multi-destino**, porque foi construído para Slack/Discord/Teams:

| Peça já pronta | Onde |
|---|---|
| N destinos por instalação, com discriminador | `integration_event_mappings.targetKey` + `actionConfig.channelId` — `packages/db/src/schema/integrations.ts:117-137` |
| Resolver emite 1 target por destino, com dedupe `(type, channelId)` e filtro por board | `apps/web/src/lib/server/events/resolvers/integration.resolver.ts:52-92` |
| Autorização de despacho já aceita override por mapping | `apps/web/src/lib/server/integrations/sync/hooks.ts:160-171` (`action?.channelId \|\| config.channelId`) |
| Links já carregam o destino (`syncScope = installation:destinationKey`) | `packages/db/src/schema/external-links.ts:23-24,51-57`; escrita em `sync/hooks.ts:283,303` |
| Idempotência da operação já inclui o destino | `apps/web/src/lib/server/integrations/sync/identity.ts:39-49` |
| Fan-out inbound já casa link por destino assinado | `apps/web/src/lib/server/integrations/sync/inbound.ts:197-242` |
| Capability `destinations` (repo / project+issue-type) e picker genérico | `github/server/index.ts:35-42`, `jira/server/index.ts:50-69`, `components/admin/settings/integrations/shared/destination-picker.tsx` |
| CRUD genérico de "canais de notificação" (não é Slack-specific) | `apps/web/src/lib/server/functions/integrations.ts:210-341` |

Ou seja: para o fluxo `post.created → cria issue`, **múltiplos repos/projetos numa mesma conexão são majoritariamente uma questão de UI + registro de webhook**, não de reescrita do motor.

**3. Impacto — o que quebra e precisa ser tratado.** Detalhado na seção "Impacto" abaixo.

**4. Escopo por usuário: não existe hoje, e precisa de modelo novo.**
As permissões de integração são globais e binárias: `INTEGRATION_VIEW` / `INTEGRATION_MANAGE`
(`apps/web/src/lib/shared/permissions.ts:106-107`). O gate de quem pode pedir uma sincronização exige
`INTEGRATION_MANAGE` (ou `POST_DELETE` para archive, ou `TICKET_ASSIGN` para criar issue a partir de ticket) —
`apps/web/src/lib/server/integrations/sync/eligibility.ts:137-172`. Nada disso é por destino.
**O seam existe**: `principal_role_assignments.teamId` já está no schema como dimensão de escopo, hoje sempre `NULL`
(`packages/db/src/schema/rbac.ts:73-76,95-99`). E o filtro por board já existe em `integration_event_mappings.filters.boardIds`.

## Impacto

### Bloqueadores críticos (precisam de decisão de design)

| # | Problema | Evidência | Como contornar |
|---|---|---|---|
| I1 | **Webhook único por instalação.** `webhookSecret` + `externalWebhookId` são campos escalares no `config`. Com N repos/projetos são necessários N webhooks remotos. | `lib/server/integrations/webhook-registration.ts:29-53,81-104`; `github/server/index.ts:47-75`; `jira/server/index.ts:35-48` | Trocar `externalWebhookId` por um mapa `destinationKey → { externalWebhookId, secret }`; registrar/desregistrar por destino no add/remove de destino, não no connect. Segredo pode ser único por instalação (o payload é que identifica o destino) — simplifica a verificação de assinatura. |
| I2 | **Inbound do Jira não informa o destino.** `parseStatusChange` não devolve `destinationId`, então `fanOutInboundStatus` cai no fallback `config.channelId` e **não encontra** links criados em outros projetos. | `jira/server/inbound.ts:69-73` vs. `sync/inbound.ts:208-218` | O payload do Jira traz `issue.fields.project.id`/`key`; emitir `destinationId` com o **mesmo formato do `channelId`** (`projectId:issueTypeId`) ou mudar o scope do Jira para conter só o projeto. Sem isso, multi-projeto quebra status sync silenciosamente. |
| I3 | **GitHub: `externalId` é o número bruto da issue** — números colidem entre repositórios. O código já registra essa armadilha em comentário. | `github/server/issues.ts:64-78`; `lib/server/integrations/types.ts:147-158` | O `syncScope` já isola por destino, então a colisão **não** corrompe o fan-out inbound desde que `destinationId` chegue (o GitHub já envia `repository.full_name` — `github/server/inbound.ts:58`). O que precisa mudar é a validação `REPO_MISMATCH` do `parseRef`, que hoje pina o repo único. |
| I4 | **`canDispatchSync` compara o hash do `config` inteiro.** Qualquer edição no blob cancela **todas** as operações em voo, de todos os destinos. | `sync/eligibility.ts:51-71` | Mover a lista de destinos para fora do `config` (tabela/mappings) ou excluir o campo de destinos do hash de estabilidade, como já se faz com `tokenExpiresAt`. |
| I5 | **Criar issue a partir de ticket e linkar issue existente ignoram destino.** Ambos montam `auth`/`destination` só com `config.channelId`. | `sync/tickets.ts:17-40`; `domains/tickets/ticket-external-links.service.ts:167-186,268-288,325-331` | Propagar um `destinationKey`/`channelId` explícito na operação e no `auth` passado a `issues.create`. Hoje o parâmetro simplesmente não existe na assinatura pública dessas funções. |
| I6 | **`issues.inspect` e `reviewDestination` usam o destino atual da instalação.** Um link de outro repo/projeto é tratado como "não verificado". | `sync/identity.ts:51-67`; `sync/remote.ts:19-24`; `github/server/issues.ts:23-28` | Resolver o destino a partir do `syncScope` do link, não do `config`. Requer um mapa reverso `destinationKey → destino legível` (hoje o hash é unidirecional). **Esta é a mudança estrutural mais séria da lista.** |

### Impactos de configuração (semântica muda de global para por-destino)

`statusMappings`, `ticketStatusMappings`, `statusSyncEnabled` e a política de `onDelete` vivem no `config` da instalação
(`sync/inbound.ts:131,206; status-mapping.ts`). Com N destinos é preciso decidir: mantém global (mais simples, provavelmente
aceitável) ou passa a ser por destino. Para o Jira isso é indiferente hoje, porque os status são listados no nível do site e
deduplicados por nome (`jira/server/statuses.ts:20-28`); para o GitHub o par Open/Closed é fixo.

### Impactos de UI

- `github-config.tsx` e `jira-config.tsx` precisam sair do `<Select>` único para uma tabela de destinos.
- `NotificationChannelRouter` já faz exatamente essa tabela, mas o próprio arquivo documenta a decisão de **não** usá-lo para
  trackers de ticket: `components/admin/settings/integrations/shared/notification-channel-router.tsx:1-9`
  ("NOT for ticket-creation integrations (Jira, Linear, Asana) ... should get their own UI"). Reutilizar exige revisitar essa
  decisão (candidata a ADR) ou construir um `DestinationRouter` irmão.
- Testes de paridade de UI entre integrações vão acusar a divergência:
  `components/admin/settings/integrations/__tests__/integration-ui-parity.test.tsx`.

### Impactos de multi-tenancy / plataforma

`install-registry.ts` vincula uma conta externa a um workspace via `install.externalId(config)` e falha com 409
(`InstallBoundElsewhereError`). Hoje só o Slack declara `install` (`slack/server/index.ts:15-18`); GitHub e Jira não declaram,
então não participam desse vínculo. Se um dia participarem, a identidade precisa ser a **conta/org/site**, nunca o repo/projeto.

### Impacto do caminho "múltiplas instalações" (Opção B)

`integrations.integrationType` é usado como chave de busca em **43 pontos, em 34 arquivos**. Dois são estruturais:

- `lib/server/integrations/inbound-webhook-handler.ts:49-70` — a URL do webhook é `/api/integrations/$type/webhook`,
  sem identificador de instalação; o handler resolve a instalação única por tipo e lê **um** `webhookSecret`. Com N instalações
  não há como escolher o segredo antes de verificar a assinatura. Exige rota por instalação ou segredo derivado.
- `events/resolvers/integration.resolver.ts` e todo o `sync/` assumem uma linha por tipo ao reidratar credenciais.

## Incertezas restantes

- **Não validado em runtime.** Toda a conclusão vem de leitura do código no HEAD `67987347d`; nenhum teste, build ou execução
  foi rodado nesta etapa (o workflow exige gates sobre o estado final, o que só faz sentido depois de haver mudança).
- **Limites das APIs externas não foram checados contra fonte primária** nesta rodada: paginação de `/user/repos`
  (`github/server/repos.ts:13` usa `per_page=100` sem paginar — já é um bug latente para contas com >100 repos),
  limite de webhooks por repositório/projeto, e se o Jira Cloud permite N webhooks dinâmicos por app+site.
  Isso precisa de uma rodada de `researcher` contra a documentação oficial antes do plano final.
- **Intenção do produto ainda não decidida** — ver seção seguinte.

## Decisão pendente (INTAKE)

A pergunta que muda materialmente o trabalho:

- **Opção A — multi-destino dentro de uma instalação.** Uma conta GitHub / um site Jira, N repositórios e N projetos.
  Aproveita `targetKey`/`syncScope`/resolver já prontos. Blast radius: I1–I6 + UI. Não atende "duas orgs distintas".
- **Opção B — multi-instalação.** Remover `integration_type_unique`. Atende duas contas/orgs/sites, mas toca 43 call sites
  e exige redesenhar a rota de webhook inbound.
- **Opção C — A agora, B depois**, com o modelo de destino já desenhado para não precisar de segunda migração.

E, ortogonal a ela, o **modelo de escopo por usuário**: por time (usa `principal_role_assignments.teamId`, já no schema),
por board (usa `filters.boardIds`, já existente), ou por tabela nova de grants `principal × destino`.

## Recomendação

1. Fechar a decisão A/B/C e o modelo de escopo com o usuário (`grill-facilitator`) antes de qualquer SPEC.
2. Despachar `researcher` para os limites de API externos listados em "Incertezas".
3. Registrar como ADR a reversão (ou confirmação) da regra documentada em `notification-channel-router.tsx:1-9`.
4. Só então `spec-writer` → `ticket-writer`, com seams TDD obrigatórios em: resolução de destino no fan-out inbound (I2/I3),
   mapa reverso `destinationKey → destino` (I6) e estabilidade de config no `canDispatchSync` (I4).
