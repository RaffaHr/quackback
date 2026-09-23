# H-001: handoff — multi-destino GitHub/Jira com escopo por time

- Data: 2026-09-23
- De: sessão Claude Code (`/specdriven-workflow`), iniciada 2026-09-22
- Estado do pipeline: **TICKETS concluído. PLANNING não iniciado.**

Este documento é auto-contido. Quem receber não precisa da conversa original.

---

## Objetivo

O Quackback conecta **um** repositório GitHub e **um** projeto Jira por workspace. O pedido do usuário foi:
(a) validar se essa limitação existe de fato, (b) avaliar se dá para expandir para N repositórios e N projetos,
(c) mapear onde isso impacta e como, e (d) permitir separar **por usuário** quais repositórios/projetos ele pode
usar ao criar postagens, de forma que o post saiba onde vincular.

(a), (b) e (c) estão **respondidos e documentados**. (d) está **especificado, não implementado**.

**Nenhuma linha de código de produto foi escrita.** Todo o trabalho até aqui é investigação, decisão e
especificação.

---

## Estado exato

### Git

| Commit | O que é |
|---|---|
| `67987347d` | Último commit que tocou código de produto. **Fingerprint de toda a investigação.** |
| `0ec31c4db` | Artefatos desta sessão (spec, tickets, research, ADR) |
| `2fb22d2a4` | **HEAD atual.** Saída do `setup-facilitator`: `repositories.json`, `AGENTS.md`, `CONTEXT.md` |

Branch `main`, working tree **limpa**.

**Fato importante:** `git show --name-only` confirma que nem `0ec31c4db` nem `2fb22d2a4` tocaram `apps/` ou
`packages/`. Portanto **todos os achados de código de R-0001 e R-0002 continuam válidos no HEAD atual** — não é
preciso reinvestigar.

### Artefatos (sha256 truncado em 12; recalcule antes de referenciar num manifesto)

| Arquivo | sha256 |
|---|---|
| `.specdriven/research/R-0001-github-jira-multi-destino.md` | `af74554f927d` |
| `.specdriven/research/R-0002-limites-api-github-jira.md` | `f983fbc66e08` |
| `.specdriven/specs/SPEC-0001-multi-destino-trackers.md` | `9472b9aaee4f` |
| `docs/adr/ADR-0001-multi-destino-trackers.md` | `de158070a915` |
| `.specdriven/tickets/T-001-destino-como-entidade.md` | `4ea7ca31d634` |
| `.specdriven/tickets/T-002-research-limites-api.md` | `41338928969d` (status `done`) |
| `.specdriven/tickets/T-003-resolucao-reversa-destino.md` | `9b0c8fc286b5` |
| `.specdriven/tickets/T-004-estabilidade-de-config.md` | `1ddc04dbd0cb` |
| `.specdriven/tickets/T-005-github-n-repositorios.md` | `3b5bf565de8d` |
| `.specdriven/tickets/T-006-jira-n-projetos.md` | `48f7dc1e4a85` |
| `.specdriven/tickets/T-007-destino-explicito-manual.md` | `b57d132a1a03` |
| `.specdriven/tickets/T-008-escopo-por-time.md` | `c32d309b53e4` |
| `.specdriven/tickets/T-009-paginacao-listar-repos.md` | `c05ee828495a` |
| `.specdriven/tickets/T-010-refresh-webhook-jira.md` | `fdb339aafc57` |

Ordem de leitura recomendada para quem chega: **R-0001** (o que o código faz hoje) → **ADR-0001** (o que decidimos)
→ **SPEC-0001** e seus dois adendos → **R-0002** (o que a API externa permite) → tickets.

### Profile

`.specdriven/repositories.json` tem `workflow.profile.configured: true`, então **o profile é autoridade** — estágio
`off` vira `N/A` legítimo, capacidade `required` ausente vira `MISSING_CAPABILITY`.

- `consumers: ["web", "widget", "db"]` — três repositórios canônicos
- `parity.required: true`, dimensões `contract-usage, states, routes, schema`
- `surfaces: { web: true, mobile: false, e2e: true }` — mobile ausente por decisão (apps nativos vivem em
  `QuackbackIO/quackback-ios` e `quackback-android`), então `mobile-mcp-tester` registra `N/A` legítimo
- `tracker: { type: "github", tool: "gh", ref: "RaffaHr/quackback" }`
- `stages: { triage: optional, spec: required, tickets: required, wayfind: off }`
- `tdd.mode: "seams"`
- Manifesto exigido: `schemaVersion: 6`

### Nenhum manifesto foi gerado

`run-gates.ps1 -Mode intake` **não foi executado** porque exige um run manifest `schemaVersion 6`, que é produto do
`planner`. Gerá-lo antes de PLANNING seria prematuro — a skill invalida (`STALE_EVIDENCE`) artefato upstream que
mude depois de PLANNING.

---

## Decisões tomadas (e porquês)

Todas foram tomadas **com o usuário**, via `grill-facilitator`, uma pergunta por vez. Não relitigue sem motivo novo.

### Arquitetura (ADR-0001)

**A-1. Multi-destino dentro de uma instalação, não múltiplas instalações.** A UNIQUE `integration_type_unique`
permanece: uma conta GitHub e um site Jira por workspace.
*Por quê:* multi-instalação tocaria 43 call sites em 34 arquivos e esbarra num bloqueador estrutural — a rota
`/api/integrations/$type/webhook` não carrega identificador de instalação, então o `webhookSecret` não pode ser
escolhido antes de verificar a assinatura. Descartado agora; a modelagem de destino como entidade mantém o caminho
aberto sem segunda migração destrutiva.
*Consequência aceita:* duas orgs GitHub ou dois sites Jira continuam sem suporte.

**A-2. Roteamento híbrido.** O automático (board → destinos, via `integration_event_mappings` + `filters.boardIds`)
continua sem regressão. O manual ganha escolha explícita de destino.

**A-3. Escopo por time.**

### Escopo por time (SPEC-0001, adendo 1)

**D-1. Destino pertence a vários times** (tabela de junção), não `owningTeamId`.
*Por quê:* com dono único, um repositório compartilhado entre dois times só teria duas saídas — restringir a um e
bloquear o outro, ou abrir ao workspace inteiro. Ambas destroem a separação que é o objetivo.
*Custo aceito:* diverge da convenção `owningTeamId` de `channel_accounts` e `email_sending_domains`.

**D-2. O escopo é declarado, nunca inferido:** `scope: 'workspace' | 'teams'`.
*Por quê:* com junção, conjunto vazio é ambíguo e as duas leituras são armadilhas. "Vazio = todos" é fail-open.
"Vazio = só admin" quebraria o critério 7 (hoje quem tem `TICKET_ASSIGN` empurra para o repo único e perderia isso).
*Bônus:* resolve a migração — destinos existentes nascem `'workspace'`.

**D-3. O gate por time vale só no caminho manual.**
*Por quê:* `post.created` é disparado por usuários anônimos do portal, que não têm time. Aplicar o gate ali zeraria
a interseção e nenhum feedback de cliente viraria issue. A variante "via board" exigiria relação board↔time, que não
existe no schema.

### Consequências de R-0002 (SPEC-0001, adendo 2)

**D-4. A identidade do destino Jira é `projectId`, sem o issue type.**
*Por quê:* o exemplo oficial da Atlassian para `jira:issue_updated` é um changelog de **mudança de issue type**. O
tipo é mutável e sua mudança dispara o próprio evento que consumimos. Identidade com o tipo dentro quebraria
silenciosamente na primeira troca. O `issueTypeId` vira config de criação, fora da identidade.

**D-5. No Jira, um webhook por conexão — não por destino.**
*Por quê:* teto de **5 webhooks por app OAuth 2.0 por usuário por tenant** (confirmado verbatim em duas leituras
independentes). Forma adotada: um webhook com `jqlFilter: project IN (P1..Pn)`, reescrito ao adicionar/remover
destino, registrando o novo **antes** de remover o antigo (usa 2 dos 5 slots por um instante, sem janela sem hook).
*Atenção:* isso contraria a premissa "o registro passa a ser por destino", que vale só para o GitHub.

**D-6. A migração reescreve `sync_scope` dos links Jira existentes.**
*Por quê:* D-4 muda o `destinationKey`, e todo link Jira gravado carrega o valor antigo. Alternativas descartadas:
manter a chave legada com o issue type virando componente opaco; e deixar duas formas de chave convivendo — esta
rejeitada por ser exatamente a bifurcação que produz bug silencioso no fan-out.
*Consequência:* a exigência "preservar o `destinationKey` byte a byte" do T-001 vale para **GitHub apenas**.

---

## Bloqueios abertos

Ordenados por quanto travam o avanço.

### B-1 — `bun` não está instalado (BLOQUEIA readiness por completo)

O profile declara **todos** os comandos de quality via `bun`. `bun` não está no PATH nem do PowerShell nem do bash:

```
Get-Command bun  → não encontrado
which bun        → ausente
```

`doctor.ps1 -ApiImpact NO_API` devolve `MISSING_CAPABILITY` em lint, typecheck, build e unit nos **três**
repositórios, com `"executable": "bun", "available": false`. O projeto usa `bun.lock` e `bunfig.toml`, então bun é o
toolchain pretendido — só não está instalado nesta máquina.

**Saída:** instalar bun, ou trocar os comandos do `repositories.json` para `npm`/`npx`. Enquanto não resolver,
`READY_FOR_MERGE` é inalcançável, independentemente do que for implementado.

### B-2 — O tracker configurado está inacessível (BLOCKED_TRACKER)

O profile declara `tracker.type: "github"`, `ref: "RaffaHr/quackback"`, e `stages.spec`/`stages.tickets` são
`required`. Mas:

```
gh issue list --repo RaffaHr/quackback
→ the 'RaffaHr/quackback' repository has disabled issues
```

Com tracker `github` publicável, o `spec-writer` e o `ticket-writer` deveriam ter entregue os corpos ao
`tracker-agent` para criar os itens, e o manifesto precisa de `tracker.itemsWritten`. **Isso não aconteceu e não
pode acontecer** enquanto issues estiverem desabilitadas.

**Saída (escolha do usuário):** habilitar issues no repositório, apontar `tracker.ref` para outro repositório, ou
mudar `tracker.type` para `file` (os `T-*.md` já existem e bastariam). **Não invente um tracker nem contorne com
outra ferramenta** — a skill proíbe substituir adapter por browser/scraping/API não configurada.

### B-3 — SPEC-0001 contradiz o profile quanto a paridade

A spec diz, na seção "Consumidores e paridade": *"Matriz de paridade: N/A justificado — não há segundo consumidor"*.
Isso foi escrito quando `workflow.profile` **ainda não existia** e a detecção via um único `apps/web`.

O profile agora declara `parity.required: true` com três consumidores (`web`, `widget`, `db`) e a dimensão
`schema`. Como esta mudança mexe em `packages/db` (schema de destinos) e em `apps/web`, a paridade é **material**,
não formalidade. Deixar como está produz `BLOCKED_PARITY` no planner.

**Saída:** o planner produz a matriz de paridade real sobre os três consumidores e registra as diferenças
intencionais com motivo e aceite; e um adendo datado na spec corrige o `N/A`. **Não edite a seção original** — os
artefatos são append-only.

### B-4 — Coverage foi declarado não-obrigatório, não resolvido

Reportei na sessão que não existe comando nem config de coverage em lugar nenhum (nem `package.json`, nem
`vitest.config.ts` raiz ou de `apps/web`, nem CI). O `setup-facilitator` fechou isso declarando
`coverage.required: false` nos três repositórios, então o gate agora é `N/A` legítimo.

Registro para quem herda: **a lacuna foi declarada fora de escopo, não preenchida.** Se algum dia a política exigir
os 100% da skill, o trabalho continua todo por fazer.

### B-5 — Incertezas de R-0002 não resolvidas

Estão listadas no artefato; as que importam para o próximo passo:

- **`project = <id numérico>` no `jqlFilter`.** O código **já emite o id hoje** (`listJiraProjects` devolve
  `project.id`, `projects.ts:30`). Não é decisão de design — é fato a observar: ou funciona, ou o registro de
  webhook Jira já falha hoje, e falharia **ruidosamente** (`registerJiraWebhook` lança em `!response.ok`).
  Conectar um Jira e ver se o registro conclui responde em minutos.
- **Webhooks de repositório GitHub são invisíveis a apps OAuth que não os criaram?** Documentado verbatim só para
  webhooks de **organização**. Se valer para repositórios, `findGitHubWebhookByUrl` não enxerga hook criado por
  humano na UI, e o caminho de recuperação de T-005 falha. Não provado nem refutado.
- **`fields.project.id` no payload do webhook Jira** está provado por cadeia de duas páginas, não por exemplo
  publicado. A recomendação D-4 foi escrita para não depender disso.

### B-6 — Bug de produção suspeito, independente desta feature

**T-010.** Não existe nenhuma chamada a `/rest/api/3/webhook/refresh` no repositório (verificado por busca em
`apps/web/src` e `packages`; só existe `refreshJiraToken`, que renova o **token OAuth**, coisa diferente). A
Atlassian é explícita: expiração de 30 dias e *"it's necessary to periodically call the Extend webhook life API"*.

Se confirmado, **o status sync do Jira já para ~30 dias após cada conexão, hoje, sem erro visível.** Confirmação
barata: uma conexão Jira com mais de 30 dias que tenha parado de receber status.

---

## Próximos passos (ordenados)

1. **Decidir B-2 com o usuário** (tracker). Bloqueia o gate de intake, que é pré-requisito de PLANNING com
   `stages.spec`/`tickets` em `required`.
2. **Resolver B-1** (bun). Pode correr em paralelo; não bloqueia planejar, bloqueia entregar.
3. **Despachar o `planner`.** Ele precisa: produzir a matriz de paridade de B-3, classificar `NO_API` (rationale já
   escrito na spec), marcar os seams TDD (`tdd.mode: seams`), e gerar o manifesto `schemaVersion 6` com
   `profileHash`, `facilitatorRuns`, `upstreamArtifacts`, fingerprints e identidade da skill.
4. **Rodar `run-gates.ps1 -Mode intake`** com esse manifesto.
5. **Implementar na ordem das edges:** `T-001`, `T-009`, `T-010` abrem em paralelo → `T-003` e `T-004` →
   `T-005` e `T-006` em paralelo → `T-007` → `T-008`.
6. Antes de T-006, fazer a observação empírica de B-5 (id vs key no `jqlFilter`).

`T-002` está `done`; seu resultado é R-0002.

---

## Não faça

- **Não reescreva as seções originais de `SPEC-*`, `ADR-*`, `T-*`, `R-*`.** São append-only: correção é **seção
  datada nova** que declara o que supersede. Já há três adendos seguindo esse padrão — imite-os.
- **Não confie no desenho original de T-006 nem na primeira versão do destino Jira.** Ambos estão marcados como
  inválidos por adendo. Ler só o corpo original leva ao erro que R-0002 já custou para achar.
- **Não trate "preservar o `destinationKey` byte a byte" como regra global.** Vale para GitHub. Para Jira, D-6
  manda reescrever — e é o ponto onde um erro órfã links em produção. O teste de migração sobre fixture com links
  Jira pré-existentes é obrigatório, não opcional.
- **Não reintroduza `issueTypeId` na identidade do destino Jira.** Parece inofensivo e é o bug silencioso mais caro
  do escopo inteiro.
- **Não use `NotificationChannelRouter` para trackers de issue.** O próprio arquivo proíbe
  (`notification-channel-router.tsx:1-9`) e ADR-0001 confirma a proibição. Trackers têm componente próprio.
- **Não infira autorização de conjunto vazio.** D-2 existe exatamente para proibir isso: leia o discriminador
  `scope`, nunca a contagem de linhas da junção.
- **Não aplique o gate de time ao roteamento automático.** D-3. Quebraria o feedback do portal público.
- **Não mexa em `affiliation`/`visibility`/`type` em `listGitHubRepos`.** Os defaults já dão o conjunto máximo e
  combinar `type` com os outros dois é 422 garantido. T-009 é só paginação via `link rel="next"`.
- **Não converta `NOT_RUN` ou `N/A` em `PASS`**, e não declare `READY_FOR_MERGE` sem `readyForMerge: true` vindo de
  `-Mode readiness`. Com B-1 aberto, isso é impossível hoje — dizer o contrário seria falso.
- **Não presuma que o tracker funciona** só porque o profile o declara. Ele está inacessível (B-2).
