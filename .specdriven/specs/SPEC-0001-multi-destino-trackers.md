# SPEC-0001: Múltiplos repositórios GitHub e projetos Jira por instalação, com escopo por time

- Data: 2026-09-22
- Estado: draft
- Origem: conversa `/specdriven-workflow` (INTAKE em 2026-09-22) — decisões registradas em [ADR-0001](../../docs/adr/ADR-0001-multi-destino-trackers.md)
- Tracker ref: N/A (tracker não configurado em `workflow.profile`)
- Classificação: **NO_API**

## Problema

O Quackback conecta exatamente um repositório GitHub e um projeto Jira por workspace. Times que operam mais de um
repositório ou mais de um projeto precisam escolher um só, ou abrir mão da integração. Não há como dizer "feedback do
board de Infra vira issue em `acme/ops`, feedback do board de Produto vira card em `PROJ-PROD`", nem como impedir que
uma pessoa do time de Frontend crie issues no repositório de Backend.

A restrição não é uma escolha de produto explícita: é consequência de três detalhes de implementação
([R-0001](../research/R-0001-github-jira-multi-destino.md)) — a UNIQUE `integration_type_unique`, o campo escalar
`config.channelId` e o `externalWebhookId` único. O motor de sincronização por baixo **já é multi-destino**.

## Objetivo e sucesso

Um admin seleciona N repositórios e N projetos numa única conexão. O roteamento automático por board continua
funcionando sem regressão. No push manual, a pessoa escolhe o destino, e só enxerga destinos dos seus times.
Cada post/ticket sabe exatamente em qual repositório ou projeto seu item remoto vive, e o status sync de volta
encontra o link certo.

Critérios de aceite verificáveis:

1. Com dois repositórios GitHub configurados, um `post.created` num board mapeado para ambos cria **duas** issues,
   uma em cada repositório, e persiste **dois** `post_external_links` com `syncScope` distintos.
2. Com dois projetos Jira configurados, uma mudança de status numa issue do projeto B atualiza o post ligado ao
   projeto B e **não** toca o post ligado ao projeto A — hoje o handler inbound do Jira não distingue os dois.
3. Duas issues GitHub de repositórios diferentes com o **mesmo número** (`#142`) produzem links distintos, e um
   webhook de fechamento de uma delas atualiza apenas o post correspondente.
4. Adicionar ou remover um destino **não** cancela operações de sync em voo dos demais destinos.
5. Adicionar um destino registra o webhook naquele repositório/projeto; removê-lo desregistra apenas aquele.
6. Uma pessoa do time A não vê destinos exclusivos do time B no seletor manual, e uma chamada direta ao
   servidor pedindo um destino fora dos seus times é recusada (não apenas escondida na UI).
7. Uma instalação existente com um único `config.channelId` continua funcionando após a migração, sem reconexão
   e sem perder links.
8. `issues.inspect` e a revisão de link conseguem operar sobre um link criado em qualquer destino ativo, não só
   no destino "atual".

## Escopo

### Dentro

- Modelo de destino como entidade própria (tabela), com `destination_key` estável, referência externa legível,
  identidade de webhook e associação a times.
- Migração dos destinos atuais (`config.channelId` de GitHub e Jira) para o novo modelo, preservando `syncScope`
  dos links já existentes.
- Registro/remoção de webhook por destino para GitHub e Jira.
- `destinationId` no handler inbound do Jira, no mesmo formato do `channelId`.
- Destino explícito nas operações manuais: criar issue a partir de post e de ticket, e linkar issue existente.
- Resolução reversa `destinationKey → destino`.
- Exclusão da lista de destinos do hash de estabilidade usado por `canDispatchSync`.
- UI de roteamento de destinos para GitHub e Jira (componente próprio, não o `NotificationChannelRouter`).
- Gate de autorização por time no seletor manual e no servidor.
- Paginação de `listGitHubRepos` (hoje trunca em 100 repositórios sem aviso).

### Fora (não-escopo explícito)

- Múltiplas **instalações** por provider (duas orgs GitHub, dois sites Jira). Decidido em ADR-0001; a modelagem
  não deve impedir isso depois, mas não é entregue aqui.
- Estender multi-destino aos demais trackers (Linear, Asana, Azure DevOps, ClickUp, Shortcut, Trello, Monday,
  Notion, GitLab). O trabalho deve manter os seams genéricos, mas só GitHub e Jira são migrados e testados.
- Tornar `statusMappings` / `ticketStatusMappings` / `onDelete` configuráveis por destino. Seguem globais por
  instalação; para o Jira isso é indiferente (statuses são listados por site e deduplicados por nome) e para o
  GitHub o par Open/Closed é fixo.
- Mudanças na API pública `/api/v1/*`.
- Escopo por pessoa (allowlist individual). Decidido em ADR-0001 em favor de times.

## Consumidores e paridade

`workflow.profile` não está configurado neste projeto, então a paridade é avaliada por detecção. Consumidor
canônico único: `apps/web` (monorepo com `packages/db`, `packages/widget`, `packages/email`, `packages/ids`,
`packages/logger` como dependências internas, não como consumidores independentes do contrato).

**Matriz de paridade: `N/A` justificado** — não há segundo consumidor com rotas/estados próprios a comparar.
As dimensões internas que continuam valendo, e que o `reviewer` deve checar, são: estados loading/vazio/erro/retry
do novo seletor de destinos, e a paridade de UI entre as telas de configuração de integrações, hoje pinada por
`components/admin/settings/integrations/__tests__/integration-ui-parity.test.tsx`.

## Contrato

**Não aplicável — classificação NO_API.**

Rationale: a mudança é confinada a schema de banco, funções de servidor internas (TanStack server functions) e
UI de administração. A superfície HTTP pública não muda:

- `/api/v1/apps/link`, `/api/v1/apps/linked` e `/api/v1/apps/unlink` operam exclusivamente no namespace de
  referência `sync_scope = ''` (`lib/server/integrations/apps/service.ts:109-111,132-133,168`), que é
  deliberadamente separado dos links de sync. Multi-destino não altera o que esses endpoints veem nem retornam.
- A rota inbound `/api/integrations/$type/webhook` mantém forma e semântica; o que muda é interno ao handler.
- Nenhuma alteração em `apps/web/src/lib/server/domains/api/openapi.ts`.

Portanto `contractEvidence` é proibido no manifesto e o contract gate fica `N/A` justificado.

## Riscos e perguntas fechadas

### Decisões fechadas no INTAKE

| Pergunta | Decisão |
|---|---|
| Multi-destino ou multi-instalação? | **Multi-destino numa instalação** (Opção A). UNIQUE permanece. |
| Como o post escolhe o destino? | **Automático por board + escolha manual** no push. Sem regressão do automático. |
| Como escopar por usuário? | **Por time**, ativando `principal_role_assignments.team_id`. |

### Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| **Falha silenciosa do status sync do Jira.** Se `destinationId` não for emitido, o fan-out não acha o link e nada acusa erro. | Alto — perda de dados sem sinal | Seam TDD obrigatório: teste red que prova que um webhook do projeto B encontra o link do projeto B antes de qualquer implementação. |
| **Colisão de número de issue entre repositórios GitHub.** | Alto | Chave real passa a ser `(installation, destinationKey, externalId)`. Teste com o mesmo número em dois repositórios é critério de aceite. |
| **Migração de links existentes.** `syncScope` já grava um hash do destino antigo; se o novo `destinationKey` for calculado de outra forma, todo link existente órfã. | Alto | A migração precisa preservar o `destinationKey` derivado do `config.channelId` atual, byte a byte. Teste de migração sobre fixture com links pré-existentes. |
| **`canDispatchSync` cancelando operações alheias.** Hoje qualquer escrita no `config` invalida tudo em voo. | Médio | Destinos saem do `config`; o hash de estabilidade passa a cobrir só o que de fato invalida um despacho. |
| **Regressão dos outros 8+ trackers** que compartilham `sync/`. | Alto | Os seams genéricos precisam manter o comportamento single-destination como caso degenerado. `sync/__tests__/provider-contracts.db.test.ts` é o pino. |
| **Limites de webhook por repositório/projeto nas APIs externas** não verificados. | Médio | `researcher` contra documentação oficial do GitHub e do Jira Cloud antes de fechar o plano (T-002). |
| **Escopo por time é uma fase nunca exercida do RBAC** (`team_id` sempre NULL hoje). | Médio | Tratar como trabalho próprio, com tickets separados, e não misturar com a entrega de multi-destino. |

### Perguntas ainda abertas (não bloqueiam a spec; bloqueiam o plano)

- Um destino pode pertencer a mais de um time, ou exatamente um?
- Destino sem time associado: visível a todos com `INTEGRATION_MANAGE` (assumido em ADR-0001) ou invisível?
- O gate por time vale também para o roteamento **automático**, ou só para a escolha manual? (Assumido: só manual —
  o automático é configuração de admin, não ação de usuário.)

## Referências

- [R-0001](../research/R-0001-github-jira-multi-destino.md) — validação da limitação e mapa de impacto (I1–I6)
- [ADR-0001](../../docs/adr/ADR-0001-multi-destino-trackers.md) — decisão de arquitetura
- `apps/web/src/integrations/README.md` — fronteiras de capability do framework de integrações
- `docs/integration-sync-safety.md` — retenção, fronteira forward-only e rollback

## Adendo 2026-09-22 — INTAKE complementar

Esta seção **supersede** as três "perguntas ainda abertas" registradas acima. O texto anterior fica intacto por
ser append-only; o que vale a partir daqui é o que segue.

### D-1 — Um destino pertence a **vários** times

Modelado como tabela de junção `destino × time`, não como coluna `owningTeamId`.

Motivo: uma pessoa já pode estar em vários times (`team_members_principal_team_uq`), mas isso não resolve um
repositório compartilhado. Com dono único, `acme/api` usado por Backend e Infra só teria duas saídas — escolher um
time e bloquear o outro, ou abrir para todo o workspace. Ambas destroem a separação que é o objetivo da spec.

Custo aceito: diverge da convenção `owningTeamId` de `channel_accounts` e `email_sending_domains`.

### D-2 — O escopo do destino é **explícito**, não inferido da ausência de linhas

Cada destino declara `scope: 'workspace' | 'teams'`. Com `'teams'`, ao menos uma associação é obrigatória e a
escrita é rejeitada sem ela. "Zero linhas" nunca é interpretado como intenção.

Motivo: com tabela de junção, o conjunto vazio é ambíguo e qualquer leitura que se escolha é uma armadilha.
"Vazio = todo mundo" é fail-open — um destino recém-criado fica exposto e o erro passa despercebido.
"Vazio = só admin" é fail-closed, mas quebraria o critério de aceite 7: hoje qualquer pessoa com `TICKET_ASSIGN`
empurra ticket para o repositório único, e ela perderia isso na migração se o workspace não tiver time padrão.

Efeito na migração (T-001): os destinos migrados a partir do `config.channelId` atual nascem com
`scope: 'workspace'`, o que preserva exatamente o comportamento de hoje sem depender de `teams.isDefault`.

### D-3 — O gate por time vale **apenas** para a escolha manual

O roteamento automático (`post.created` → event mapping → destino) não consulta times.

Motivo: o automático é configuração de admin — quem decide que o board X alimenta o repositório Y é quem tem
`INTEGRATION_MANAGE`, e essa decisão já está autorizada no momento em que é gravada. Aplicar o gate à autoria
quebraria o caso de uso central do produto: `post.created` é disparado por usuários anônimos do portal público,
que não pertencem a time nenhum, então a interseção seria sempre vazia e nenhum feedback de cliente viraria issue.

A variante "restringir via board" foi descartada por exigir uma relação board↔time que não existe no schema hoje
(`packages/db/src/schema/boards.ts` não tem coluna de time) — seria conceito novo e migração nova, fora do escopo
de SPEC-0001.

### Critérios de aceite adicionais

9. Um destino com `scope: 'teams'` e nenhuma associação é rejeitado na escrita, com erro de validação explícito.
10. Um destino com `scope: 'workspace'` aparece para toda pessoa autorizada a empurrar, independentemente de time.
11. Um destino associado a dois times aparece para membros de qualquer um dos dois, sem duplicar no seletor.
12. Um `post.created` de autor sem time algum (portal público) continua sendo roteado normalmente pelo automático.

## Adendo 2026-09-22 (2) — consequências de R-0002

Fecha as decisões abertas pela pesquisa de limites de API
([R-0002](../research/R-0002-limites-api-github-jira.md)). Supersede, onde conflita, o "Dentro" do escopo e o
risco de migração declarados acima.

### D-4 — A identidade do destino Jira é o **projeto**, sem o issue type

`destinationKey` do Jira deriva de `projectId` apenas. O `issueTypeId` continua existindo como **configuração de
criação por destino** (qual tipo criar ao empurrar um post), fora da identidade.

Motivo, provado por fonte primária: o exemplo oficial de `jira:issue_updated` publicado pela Atlassian é um
changelog de **mudança de issue type**. O tipo é mutável, e sua mudança dispara exatamente o evento que consumimos.
Uma identidade que o inclua deixa de casar com o link gravado no instante da primeira troca de tipo — sem erro,
sem log. É a materialização do risco "Falha silenciosa do status sync do Jira" já registrado nesta spec.

### D-5 — No Jira, o webhook é **um por conexão**, não um por destino

A premissa "o registro de webhook passa a ser por destino" vale para o GitHub e **não** vale para o Jira.
Um app OAuth 2.0 tem teto de **5 webhooks por app por usuário por tenant** (confirmado verbatim em duas leituras
independentes), então N destinos exigiriam N webhooks e quebrariam no sexto projeto.

Forma adotada: **um** webhook dinâmico por conexão Jira, com `jqlFilter: project IN (P1, ..., Pn)`. Adicionar ou
remover destino **reescreve o filtro**, e como o OpenAPI não expõe update de webhook dinâmico, a reescrita é
registrar-o-novo-antes-de-remover-o-antigo — isso usa 2 dos 5 slots por um instante, dentro do teto, e evita a
janela sem webhook que violaria o critério de aceite 4.

### D-6 — A migração **reescreve** o `sync_scope` dos links Jira existentes

D-4 muda o `destinationKey` do Jira, e o `sync_scope` de todo link Jira já gravado carrega o valor antigo. A
migração recalcula e atualiza `post_external_links.sync_scope` e `ticket_external_links.sync_scope` para as linhas
de `integration_type = 'jira'`.

Isto **supersede** o risco "Migração de links existentes" declarado acima, que exigia preservar o `destinationKey`
byte a byte: essa exigência continua valendo para o **GitHub**, e deixa de valer para o Jira. As alternativas
descartadas foram manter a chave legada com o issue type virando componente opaco, e deixar duas formas de chave
convivendo — esta última rejeitada por ser precisamente o tipo de bifurcação que produz bug silencioso no fan-out.

### Critérios de aceite adicionais

13. Depois da migração, um webhook do projeto P encontra os links Jira daquele projeto criados **antes** da
    migração. Teste obrigatório sobre fixture com links Jira pré-existentes.
14. A migração dos links Jira é reversível: o valor anterior de `sync_scope` é recuperável para rollback.
15. Mudar o issue type de um issue Jira vinculado **não** quebra o status sync daquele link.
16. Adicionar o sexto projeto Jira funciona — não existe caminho que tente registrar um sexto webhook.
17. Durante a reescrita do filtro do webhook Jira, não há janela em que nenhum webhook esteja registrado.
