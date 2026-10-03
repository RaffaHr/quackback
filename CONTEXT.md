# CONTEXT — Quackback

Modelo de domínio canônico. Termos aqui têm exatamente um significado; sinônimos casuais são
corrigidos para o termo canônico. Arquivo espelhado pelo `project-memory`: alterar CONTEXT.md ou
`docs/adr/` sem espelho correspondente classifica `MEMORY_IMPLEMENTATION_DRIFT`.

Semeado pelo `setup-facilitator` em 2026-09-22 a partir do schema (`packages/db/src/schema`), do
README e de `ADR-0001`. Termo sem evidência no código não entra aqui.

## Glossário

| Termo | Significado | Não significa | Relações |
|---|---|---|---|
| Workspace | Instalação/tenant. Fronteira de dados, auth e configuração; servido por subdomínio (`acme.localhost` em dev/CI). | Time. Um workspace tem N times. | contém Boards, Teams, Integrations |
| Team | Agrupamento de pessoas dentro do workspace; dimensão de escopo do RBAC (`principal_role_assignments.team_id`). | Grupo de permissão. Papel e time são dimensões distintas. | escopa Destinations; agrupa Principals |
| Board | Coleção de feedback com voto, status e visibilidade própria. | Roadmap. O roadmap é uma visão derivada de status. | agrupa Posts; filtra roteamento automático (`filters.boardIds`) |
| Post | Item de feedback num board: recebe voto, comentário e status. | Conversation. Post é feedback público; conversation é atendimento. | pertence a Board; pode virar External Link |
| Conversation | Thread de atendimento na inbox, de qualquer canal (widget, e-mail, chat). | Post. | tem Messages, Attributes, Summary, SLA |
| Inbox | Superfície admin onde conversations são triadas, filtradas, agrupadas e respondidas. | Fila de jobs. | opera sobre Conversations |
| Customer / Company | Pessoa que envia feedback ou fala na inbox, e a organização a que pertence. | Principal. Principal é quem tem papel RBAC. | Company agrupa Customers; ambos têm Attributes |
| Widget | Bundle embarcável (`packages/widget`) que coleta feedback e abre conversation dentro do app do cliente. | SDK nativo. iOS/Android vivem em repositórios separados. | consumidor canônico; expõe Surfaces |
| Portal | Superfície pública do workspace: boards, changelog, help center, status. | Admin. | renderizado por `apps/web` |
| Integration | Instalação de um provider externo (GitHub, Jira, Slack, Linear…). `integration_type` é UNIQUE: **uma** instalação por provider por workspace. | Destination. Uma integration tem N destinations. | contém Destinations; produz Deliveries |
| Destination | Alvo concreto de uma integration — um repositório GitHub, um projeto Jira, um canal Slack. Entidade própria com `destination_key` estável, referência externa legível, identidade de webhook e escopo. | `config.channelId`. Esse campo escalar permanece só como destino-padrão de compatibilidade. | pertence a Integration; escopada por Team ou workspace (ADR-0001) |
| destinationKey | Chave estável de um destination, resolvível nos dois sentidos (`destinationKey → destination`). | Hash unidirecional. Resolução reversa é obrigatória desde ADR-0001. | compõe `syncScope = installation:destinationKey` e `syncOperationKey` |
| External Link | Vínculo entre um item local (post/ticket) e um item remoto do tracker. | Webhook delivery. | chaveado por `(installation, destinationKey, externalId)` |
| Quinn | Agente de IA: voltado ao cliente e como Copilot do time. Conectores MCP e permissão por tool (allow / ask / deny). | Automação de workflow. | usa Connectors, Assistant Events, Agent Skills |
| Changelog | Publicação de atualizações do produto, com categorias, assinaturas e agendamento. | Activity. Activity é a timeline interna de um item. | superfície do Portal |
| Macro | Resposta/ação pré-definida aplicável a uma conversation. | Workflow. | usada na Inbox |
| Cloud block | Bloco de settings `cloud`, default-off: gating de plano, entitlements e cliente do control-plane. Instalação sem configuração de nuvem é entitled a tudo e não faz requisição externa. | Feature flag de produto. | `apps/web/src/lib/server/control-plane` |

## Invariantes de negócio

- **Uma instalação por provider, N destinos dentro dela.** A UNIQUE `integration_type_unique`
  permanece: uma conta GitHub e um site Jira por workspace. Duas contas GitHub ou dois sites Jira
  continuam sem suporte — o caminho, se virar requisito, é remover a UNIQUE e resolver a rota inbound
  `/api/integrations/$type/webhook`, que hoje não carrega identificador de instalação. (`ADR-0001`)
- **Toda operação de sync que cria ou inspeciona item remoto carrega destino explícito.** Ler
  `config.channelId` dentro de `sync/` só é aceitável no caminho de compatibilidade da migração.
  (`ADR-0001`)
- **`externalId` de tracker não é único dentro de uma instalação.** Números de issue do GitHub colidem
  entre repositórios; a chave real é `(installation, destinationKey, externalId)`. (`ADR-0001`)
- **Escopo de destino é declarado, nunca inferido.** `scope: 'workspace' | 'teams'`; com `'teams'`, a
  ausência de associação é erro de validação. Autorização jamais é inferida de conjunto vazio.
  (`ADR-0001`, adendo de 2026-09-22)
- **O gate por time vale só no caminho manual.** O roteamento automático não consulta times: é
  configuração de admin e seus autores incluem usuários anônimos do portal, que não têm time.
  (`ADR-0001`)
- **O hash de estabilidade de config usado por `canDispatchSync` exclui a lista de destinos**, como já
  exclui `tokenExpiresAt` — caso contrário, adicionar um repositório cancela as operações em voo de
  todos os outros. (`ADR-0001`)
- **Registro e remoção de webhook acontecem por destino**, no add/remove de destino — não no
  connect/disconnect da integration. (`ADR-0001`)
- **`NotificationChannelRouter` é proibido para trackers de issue.** Notificar um canal e criar um item
  rastreável com ciclo de vida são modelos mentais distintos; trackers têm componente próprio de
  roteamento de destinos. (`notification-channel-router.tsx:1-9`, confirmado em `ADR-0001`)
- **Self-hosted é funcionalmente completo.** Nenhuma feature pode depender do control-plane para
  funcionar numa instalação sem configuração de nuvem.

## Capacidades e fronteiras

**Faz:** boards de feedback com voto e comentário; inbox multicanal; help center; changelog; página de
status; portal público i18n (en, fr, de, es, ar com RTL); widget embarcável; API REST + webhooks +
servidor MCP; ~25 integrações, com sync bidirecional para trackers de issue; IA para duplicatas,
resumo e extração de feedback; auth por senha, OTP, Google, GitHub e SSO.

**Deliberadamente não faz neste repositório:** apps nativos iOS e Android — vivem em
`QuackbackIO/quackback-ios` e `QuackbackIO/quackback-android`, fora deste checkout. Por isso a
superfície mobile é declarada ausente no `workflow.profile` e o `mobile-mcp-tester` registra `N/A`.

**Fronteiras externas:** PostgreSQL (dados e fila de jobs), provedores de integração via HTTP,
control-plane da nuvem (default-off), provedores de IA (OpenAI via TanStack AI), S3 para anexos,
SMTP/provedor de e-mail.
