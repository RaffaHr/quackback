# ADR-0001: Trackers de issue passam a ter N destinos por instalação, escopados por time

- Data: 2026-09-22
- Estado: aceito
- Origem: grill-facilitator (INTAKE do pedido "múltiplos repositórios GitHub e múltiplos projetos Jira")

## Contexto

Hoje o Quackback permite exatamente um repositório GitHub e um projeto Jira. A restrição vem de três
camadas independentes, levantadas em [R-0001](../../.specdriven/research/R-0001-github-jira-multi-destino.md):

1. `integrations.integration_type` é UNIQUE — uma instalação por provider.
2. O destino vive num campo escalar `config.channelId`.
3. O registro de webhook grava um único `externalWebhookId` no `config`.

Ao mesmo tempo, o motor de sincronização **já foi construído multi-destino** para os provedores de chat:
`integration_event_mappings.targetKey`, `actionConfig.channelId`, o dedupe `(integrationType, channelId)` do
resolver, `syncScope = installation:destinationKey` nas tabelas de link e o `destinationKey` dentro do
`syncOperationKey`. O que falta para trackers de issue é expor isso e fechar seis lacunas concretas (I1–I6 em R-0001).

Há ainda uma regra documentada em `notification-channel-router.tsx:1-9` afirmando que aquele componente
**não** deve ser usado por integrações de criação de ticket, porque o modelo mental é outro (notificar um canal
vs. criar um item rastreável com ciclo de vida). Essa regra continua válida: o que compartilhamos é o modelo de
dados e o roteador do servidor, não o componente de UI.

O RBAC já prevê uma dimensão de escopo por time (`principal_role_assignments.team_id`, nullable, hoje sempre NULL),
descrita no próprio schema como "the team-scoping phase".

## Decisão

1. **N destinos por instalação, não N instalações.** A UNIQUE `integration_type_unique` permanece. Uma conta
   GitHub e um site Jira por workspace; dentro deles, N repositórios e N projetos selecionáveis.
2. **O destino deixa de ser um campo escalar no `config` e passa a ser uma entidade própria**, com
   `destination_key` estável, referência externa legível, identidade do webhook e vínculo com times.
   `config.channelId` permanece apenas como destino-padrão de compatibilidade durante a migração.
3. **Dois modos de roteamento coexistem.** O automático continua derivando destinos do evento e do board
   (`integration_event_mappings` + `filters.boardIds`), sem regressão. O manual passa a aceitar um destino
   explícito nas operações de push/criação a partir de post e de ticket.
4. **O escopo por usuário é por time.** Um destino é associado a um ou mais times; o seletor manual e o gate de
   autorização mostram/aceitam apenas destinos dos times do ator. Um destino sem time associado é visível a quem
   tem `INTEGRATION_MANAGE`.
5. **O `destinationKey` deixa de ser só um hash unidirecional.** Passa a existir resolução reversa
   `destinationKey → destino`, sem a qual `issues.inspect` e `reviewDestination` não conseguem operar sobre um
   link de outro repositório/projeto.

## Alternativas consideradas

- **N instalações por provider** (remover a UNIQUE). Atenderia duas orgs GitHub ou dois sites Jira, mas toca 43
  call sites em 34 arquivos e esbarra num bloqueador estrutural: a rota inbound `/api/integrations/$type/webhook`
  não carrega identificador de instalação, então o `webhookSecret` não pode ser escolhido antes de verificar a
  assinatura. Descartada agora; a modelagem de destino como entidade própria mantém esse caminho aberto sem exigir
  uma segunda migração destrutiva.
- **Roteamento só automático por board.** Menor escopo, mas elimina a escolha humana e, com ela, o próprio
  requisito de escopo por usuário. Descartada.
- **Allowlist por pessoa (`principal × destino`).** Granularidade máxima, custo administrativo linear no número
  de pessoas e de destinos. Descartada em favor de times.
- **Escopo herdado do board.** Zero configuração nova, mas acopla permissão de tracker à visibilidade de board —
  grosseiro demais, e impede que dois times compartilhem um board com destinos diferentes. Descartada.

## Consequências

**Passa a ser obrigatório:**

- Toda operação de sync que cria ou inspeciona um item remoto carrega um destino explícito. Ler `config.channelId`
  dentro de `sync/` deixa de ser aceitável, exceto no caminho de compatibilidade da migração.
- Todo handler inbound de tracker multi-destino devolve `destinationId` no mesmo formato do `channelId` daquele
  provider. Sem isso o fan-out não acha o link e o status sync falha em silêncio — hoje é exatamente o caso do Jira.
- O hash de estabilidade de config usado por `canDispatchSync` exclui a lista de destinos, do mesmo jeito que já
  exclui `tokenExpiresAt`. Caso contrário, adicionar um repositório cancela as operações em voo de todos os outros.
- Registro e remoção de webhook acontecem por destino, no add/remove de destino — não mais no connect/disconnect.

**Passa a ser proibido:**

- Assumir que um `externalId` de tracker é único dentro de uma instalação. Números de issue do GitHub colidem entre
  repositórios; a chave real é `(installation, destinationKey, externalId)`.
- Usar `NotificationChannelRouter` para trackers de issue. A regra em `notification-channel-router.tsx:1-9` segue
  de pé; trackers ganham seu próprio componente de roteamento de destinos.

**Fica em aberto:** duas contas GitHub distintas ou dois sites Jira continuam sem suporte. Se virar requisito,
o caminho é remover a UNIQUE e resolver a rota inbound — sem remodelar destinos de novo.

## Adendo 2026-09-22 — refinamento do escopo por time

O ponto 4 da decisão dizia "um destino é associado a um ou mais times" e "um destino sem time associado é visível
a quem tem `INTEGRATION_MANAGE`". A segunda metade fica **substituída** pelo que segue; a primeira é confirmada e
detalhada.

1. **Cardinalidade: muitos-para-muitos.** Tabela de junção `destino × time`. Diverge conscientemente da convenção
   `owningTeamId` (notNull, dono único) de `channel_accounts` e `email_sending_domains`, porque com dono único um
   repositório compartilhado entre dois times só poderia ser restrito a um deles ou aberto ao workspace inteiro.
2. **Escopo explícito no destino.** `scope: 'workspace' | 'teams'`. A ausência de associações deixa de ter
   significado: com `'teams'` ela é um erro de validação, e "aberto a todos" passa a ser declarado, nunca inferido.
   Isso também resolve a migração — destinos existentes nascem `'workspace'` e preservam o comportamento atual.
3. **O gate por time é só do caminho manual.** O roteamento automático não consulta times, porque ele é
   configuração de admin e porque seus autores incluem usuários anônimos do portal, que não têm time.

Consequência para o que passa a ser proibido: inferir autorização a partir de conjunto vazio. Todo destino
declara seu escopo, e o código lê o discriminador, nunca a contagem de linhas da junção.
