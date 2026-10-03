# R-0002: Limites das APIs GitHub e Jira para webhooks por destino e listagem de repositórios

- Data: 2026-09-22
- Origem: T-002 / SPEC-0001 — fixa a forma do registro de webhook por destino antes do plano (bloqueia T-005, T-006; alimenta T-009)

## Pergunta

Quatro perguntas, respondidas somente contra documentação oficial do GitHub REST API e da Atlassian/Jira Cloud:

- **P1** — GitHub: quantos webhooks cabem num mesmo repositório, o que é documentado sobre criar hook com `config.url`
  já existente, e quais escopos OAuth são exigidos para criar/listar/remover.
- **P2** — Jira Cloud: um app OAuth 2.0 (3LO) pode registrar N webhooks dinâmicos por (app, site)? Limite, filtro JQL,
  expiração, escopo.
- **P3** — Jira: o payload de `jira:issue_updated` traz de forma confiável `issue.fields.project.id` **e**
  `issue.fields.issuetype.id`? (O destino Jira é hoje a string `projectId:issueTypeId`.)
- **P4** — GitHub: como paginar `GET /user/repos`, e o efeito de `affiliation`/`visibility`/`type`.

## Resposta

### P1 — GitHub: webhooks por repositório

**Confiança: alta** para o limite e os escopos; **alta** para a conclusão de que o tratamento de `already exists`
é comportamento **observado, não documentado**.

**Limite.** O limite documentado é **por repositório e por tipo de evento**, não por app e não um teto total:
"You can create multiple webhooks in a single repository. However, you can only create up to 20 webhooks that
subscribe to each individual event type." Ao estourar, "you will receive an error stating that you cannot have more
than 20 webhooks". **Não existe limite documentado por app OAuth.**

Consequência para SPEC-0001: o modelo "1 webhook por destino" do GitHub é seguro. Cada destino é um **repositório
diferente**, e o Quackback registra um único hook por repositório (`events` = `['issues']` + inbox). O teto de 20
só seria atingido se 20 integrações distintas assinassem `issues` no **mesmo** repositório. Isso não decorre de
multi-destino. O limite **não** é um risco para esta spec.

**URL duplicada.** A documentação do endpoint de criação diz: "Repositories can have multiple webhooks installed.
Each webhook should have a unique config. Multiple webhooks can share the same config as long as those webhooks do
not have any events that overlap." Os códigos de resposta documentados para `POST /repos/{owner}/{repo}/hooks`
incluem `422 - Validation failed, or the endpoint has been spammed.`

**A string `already exists` não aparece em nenhuma página oficial que consultei.** O regex
`/already exists/i` em `apps/web/src/integrations/github/server/index.ts:66` casa com uma **mensagem de erro
observada**, não com um contrato documentado. O que é documentado é a _regra_ que a produz (config única com
eventos sobrepostos) e o _status_ (422), não o texto. Isso é frágil por duas razões: o texto pode mudar sem aviso, e
outros 422 de validação (ex.: URL inválida, limite de 20) caem no mesmo `catch` e hoje são corretamente re-lançados
— mas só porque não contêm a frase. Um 422 cujo texto mudasse para algo com "already exists" em outro contexto
entraria no caminho de recuperação errado.

**Escopos OAuth.** Da página oficial de escopos para OAuth Apps:

- `admin:repo_hook` — "Grants read, write, ping, and delete access to repository hooks in public or private repositories."
- `write:repo_hook` — "Grants read, write, and ping access to hooks in public or private repositories."
- `read:repo_hook` — "Grants read and ping access to hooks in public or private repositories."
- `repo` — "Grants full access to public and private repositories including read and write access to code, commit
  statuses, repository invitations, collaborators, deployment statuses, and repository webhooks."

**Ponto de atenção para o planner:** `write:repo_hook` **não concede delete**. O critério de aceite 5 da SPEC-0001
("removê-lo desregistra apenas aquele") exige `DELETE /repos/{owner}/{repo}/hooks/{hook_id}`, portanto exige
`admin:repo_hook` **ou** `repo`. Se a app OAuth do Quackback hoje pede apenas `repo`, está coberta; se pedir
`write:repo_hook`, a remoção por destino falha. **Verificar o escopo real pedido em
`apps/web/src/integrations/github/server/oauth.ts` é tarefa do planner** — não foi objeto desta pesquisa.

### P2 — Jira Cloud: webhooks dinâmicos por (app, site)

**Confiança: alta.** Esta é a resposta que mais muda o desenho.

**Limite: 5.** "A maximum of 100 webhooks per app per tenant is allowed for a Connect app. For an OAuth 2.0 app, the
limit is **5 webhooks per app per user on a tenant**." O Quackback é um app OAuth 2.0 (3LO). **Um webhook por destino
Jira quebra na sexta conexão de projeto.**

**Uma única URL por app.** O schema oficial de `WebhookRegistrationDetails.url` diz: "The URL that specifies where to
send the webhooks. This URL must use the same base URL as the Connect app. **Only a single URL per app is allowed to
be registered.**" Portanto **não é possível codificar o destino na URL de callback** do Jira (ex.:
`/api/integrations/jira/webhook?dest=X`). O destino tem de sair do **payload**. Isso é o que torna P3 load-bearing.

**Filtro JQL.** `jqlFilter` é campo **obrigatório** (`required: ["events", "jqlFilter"]`). Elementos suportados:
"Fields: `issueKey`, `project`, `issuetype`, `status`, `assignee`, `reporter`, `issue.property`, and `cf[id]`. For
custom fields (`cf[id]`), only the epic label custom field is supported." / "Operators: `=`, `!=`, `IN`, and
`NOT IN`." **Não há limite de tamanho documentado.**

`IN` ser suportado é a saída para o teto de 5: **um único webhook pode cobrir N projetos** com
`project IN (A, B, C, ...)`, em vez de N webhooks. O registro deixa de ser "por destino" e passa a ser
"por conexão, reescrito quando o conjunto de destinos muda".

**Expiração — e um bug latente hoje.** "Extends the life of webhook. **Webhooks registered through the REST API
expire after 30 days.** Call this operation to keep them alive." (`PUT /rest/api/3/webhook/refresh`). A página de
plataforma confirma: "The expiration period is 30 days from the time the webhook was created or refreshed using the
Extend webhook life REST resource" e "Webhooks are available for up to 3 months after they expire."

Não encontrei nenhuma chamada a `/rest/api/3/webhook/refresh` no repositório — só refresh de **token** OAuth
(`refreshJiraToken`). Se isso se confirmar, **os webhooks Jira do Quackback morrem silenciosamente em 30 dias hoje**,
independentemente de multi-destino. É um achado colateral que o planner deve tratar como item próprio.

**Escopos.** Do OpenAPI oficial, para `registerDynamicWebhooks`, `getDynamicWebhooksForApp`, `deleteWebhookById` e
`refreshWebhooks`, o `security` OAuth2 é `["read:jira-work", "manage:jira-webhook"]` (clássico, estado `Current`).
Granulares em Beta: `write:webhook:jira` + `read:field:jira` + `read:project:jira` (registro),
`read:webhook:jira` + `read:jql:jira` (leitura), `delete:webhook:jira` (remoção),
`write:webhook:jira` + `read:webhook:jira` (refresh). A página de plataforma lista, por evento,
`read:issue-details:jira` para `jira:issue_updated`.

**Dois avisos documentados relevantes:**

- Registro: "**NOTE:** for non-public OAuth apps, webhooks are delivered only if there is a match between the app
  owner and the user who registered a dynamic webhook."
- Remoção: "Only webhooks registered by the calling app are removed. If webhooks created by other apps are specified,
  they are ignored." — bom para o critério de aceite 5: desregistrar é seguro, não afeta terceiros.

### P3 — Payload de `jira:issue_updated`: `project.id` e `issuetype.id`

**Confiança: média-alta para a presença dos campos; alta para a recomendação de não usar `issueTypeId` na
identidade do destino.** Leia as duas partes separadamente — elas não dependem uma da outra.

**Parte 1 — os campos vêm?** O exemplo publicado de payload **não mostra** `fields.project` nem `fields.issuetype`.
O `fields` do exemplo contém apenas `summary`, `created`, `description`, `labels`, `priority`. Portanto **não existe
prova verbatim por exemplo publicado.**

O que existe é uma cadeia documental, cada elo com fonte primária:

1. A página de webhooks descreve o objeto `issue` como "The same shape returned from the Jira REST API when an issue
   is retrieved with NO expand parameters."
2. No OpenAPI oficial, o parâmetro `fields` de `getIssue` tem `default: "*all"` e a descrição diz explicitamente:
   "**Note: All fields are returned by default.** This differs from Search for issues using JQL (GET) [...] where the
   default is all navigable fields."
3. `project` e `issuetype` são campos de sistema do issue, endereçados por `id` — o exemplo oficial de `createIssue`
   traz `"project": {"id": "10000"}` e `"issuetype": {"id": "10000"}` dentro de `fields`.

Logo, o conjunto padrão de campos inclui `project` e `issuetype`, ambos com `id`. **Mas a cadeia é inferência sobre
duas páginas, não uma afirmação única e explícita da Atlassian sobre o payload do webhook.** Fica registrado como
incerteza abaixo, com verificação barata sugerida.

Nota adicional: o schema `IssueBean.fields` no OpenAPI é um mapa livre (`{"additionalProperties": {}, "type":
"object"}`), ou seja, o próprio contrato oficial **não enumera** os campos da resposta. Não há como obter prova mais
forte que a cadeia acima a partir da documentação.

**Parte 2 — e mesmo que venham, `issueTypeId` não deve entrar na identidade do destino.** Este é o ponto decisivo, e
ele não depende da Parte 1.

O **próprio exemplo oficial** de `jira:issue_updated` mostra o changelog de uma mudança de tipo de issue:

```json
{
  "toString": "New Feature",
  "to": "2",
  "fromString": "Improvement",
  "from": "4",
  "fieldtype": "jira",
  "field": "issuetype"
}
```

Ou seja: a documentação primária demonstra que **o issue type de um issue muda ao longo da vida dele**, e que essa
mudança é exatamente um dos eventos que o Quackback recebe. O `issueTypeId` em `config.channelId` é uma decisão de
**criação** (qual tipo criar ao empurrar um post), não uma propriedade estável de **identidade** do issue remoto.

Se o `destinationId` inbound for `projectId:issueTypeId`, então no instante em que alguém muda o tipo de um issue de
Bug para Task, o handler passa a computar um `destinationId` diferente do gravado no link, o fan-out não acha o link,
e **nada acusa erro** — exatamente o risco "Falha silenciosa do status sync do Jira" já registrado na SPEC-0001.
A mudança de tipo _dispara_ um `jira:issue_updated`, então o primeiro evento perdido é o da própria mudança.

Reforço independente: o `jqlFilter` do registro é naturalmente escopado por `project`, e o teto de 5 webhooks (P2)
empurra para `project IN (...)`. Um webhook filtrado por projeto não tem como garantir coerência com uma identidade
que inclui tipo.

**Conclusão de P3: a forma do destino Jira precisa mudar. Recomendação abaixo.**

### P4 — GitHub: paginação de `GET /user/repos`

**Confiança: alta.**

**Paginação.** `per_page` — "The number of results per page (max 100)", default `30`. `page` — "The page number of
the results to fetch", default `1`. A travessia correta é pelo header `link`: "You can use the URLs from the `link`
header to request another page of results", com `rel` valendo `next`, `prev`, `first`, `last`; "In some cases, only a
subset of these links are available." A orientação oficial é seguir `rel="next"` até ele não existir mais, e não
construir URLs à mão.

Detalhe útil: "If you specify a value greater than the maximum, GitHub does not return an error. Instead, the value
is automatically reduced to the maximum." — pedir `per_page=1000` não falha e não avisa; devolve 100. Não há header
de contagem total; a única forma de saber que acabou é a ausência de `rel="next"`.

**Confirmação do bug de T-009:** `listGitHubRepos` (`apps/web/src/integrations/github/server/repos.ts:13`) chama
`/user/repos?sort=updated&per_page=100` uma única vez, ignora o header `link` e retorna `data.map(...)`. Uma conta
com 101 repositórios perde o 101º **sem nenhum sinal** — não há erro, não há truncation flag. Sob multi-destino, o
efeito é um repositório simplesmente não aparecer no seletor, e o admin não tem como saber por quê.

**Parâmetros.** Todos os três já vêm no modo mais amplo por default, então o código atual (que não passa nenhum
deles) **já obtém o conjunto máximo**:

| Param         | Default documentado                      | Valores                                       |
| ------------- | ---------------------------------------- | --------------------------------------------- |
| `visibility`  | `all`                                    | `all`, `public`, `private`                    |
| `affiliation` | `owner,collaborator,organization_member` | lista separada por vírgula                    |
| `type`        | `all`                                    | `all`, `owner`, `public`, `private`, `member` |

`affiliation` — "Comma-separated list of values. Can include: `owner`: Repositories that are owned by the
authenticated user. `collaborator`: Repositories that the user has been added to as a collaborator.
`organization_member`: Repositories that the user has access to through being a member of an organization. This
includes every repository on every team that the user is on."

`type` — "Limit results to repositories of the specified type. **Will cause a 422 error if used in the same request
as `visibility` or `affiliation`.**"

Portanto: **o T-009 é exclusivamente um bug de paginação.** Passar `affiliation`/`visibility` não amplia nada (já
estão no máximo), e passar `type` junto com qualquer um dos dois é um 422 garantido. A correção é seguir `link`
`rel="next"`; mexer nos filtros seria regressão.

## Evidências

| Afirmação                                                                                                                                                                                                                                                                    | Fonte (URL/doc/código)                                                                                                                                                                           | Consultado em |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| P1 — "You can create multiple webhooks in a single repository. However, you can only create up to 20 webhooks that subscribe to each individual event type."                                                                                                                 | https://docs.github.com/en/webhooks/types-of-webhooks                                                                                                                                            | 2026-09-22    |
| P1 — "You can create up to 20 repository or organization webhooks for each event type. If you attempt to create more, you will receive an error stating that you cannot have more than 20 webhooks."                                                                         | https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks                                                                                                | 2026-09-22    |
| P1 — "Repositories can have multiple webhooks installed. Each webhook should have a unique config. Multiple webhooks can share the same config as long as those webhooks do not have any events that overlap."                                                               | https://docs.github.com/en/rest/repos/webhooks?apiVersion=2022-11-28                                                                                                                             | 2026-09-22    |
| P1 — Create repository webhook documenta `422 - Validation failed, or the endpoint has been spammed.` (e 201/403/404)                                                                                                                                                        | https://docs.github.com/en/rest/repos/webhooks?apiVersion=2022-11-28                                                                                                                             | 2026-09-22    |
| P1 — Nenhuma página oficial consultada contém a string `already exists` para webhooks de repositório                                                                                                                                                                         | https://docs.github.com/en/rest/repos/webhooks?apiVersion=2022-11-28 + https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks + https://docs.github.com/en/webhooks/about-webhooks | 2026-09-22    |
| P1 — `admin:repo_hook` = "Grants read, write, ping, and delete access to repository hooks in public or private repositories."; `write:repo_hook` = "Grants read, write, and ping access to hooks..."; `read:repo_hook` = "Grants read and ping access to hooks..."           | https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps                                                                                                             | 2026-09-22    |
| P1 — Escopo `repo` inclui "repository webhooks"                                                                                                                                                                                                                              | https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps                                                                                                             | 2026-09-22    |
| P1 — Config sub-endpoints: "OAuth app tokens and personal access tokens (classic) need the read:repo_hook or repo scope" / "...write:repo_hook or repo scope..."                                                                                                             | https://docs.github.com/en/rest/repos/webhooks?apiVersion=2022-11-28                                                                                                                             | 2026-09-22    |
| P1 (contexto) — "OAuth apps cannot list, view, or edit webhooks that they did not create and users cannot list, view, or edit webhooks that were created by OAuth apps." (documentado para webhooks de **organização**)                                                      | https://docs.github.com/en/rest/orgs/webhooks?apiVersion=2022-11-28                                                                                                                              | 2026-09-22    |
| P1 — código atual: regex `/already exists/i` + `findGitHubWebhookByUrl` + `patchGitHubWebhook`                                                                                                                                                                               | `apps/web/src/integrations/github/server/index.ts:62-68`                                                                                                                                         | 2026-09-22    |
| P2 — "A maximum of 100 webhooks per app per tenant is allowed for a Connect app. For an OAuth 2.0 app, the limit is 5 webhooks per app per user on a tenant."                                                                                                                | https://developer.atlassian.com/cloud/jira/platform/webhooks/                                                                                                                                    | 2026-09-22    |
| P2 — "The URL that specifies where to send the webhooks. This URL must use the same base URL as the Connect app. Only a single URL per app is allowed to be registered." (`WebhookRegistrationDetails.url`)                                                                  | https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (`components.schemas.WebhookRegistrationDetails`)                                                                         | 2026-09-22    |
| P2 — `jqlFilter` obrigatório; "Fields: `issueKey`, `project`, `issuetype`, `status`, `assignee`, `reporter`, `issue.property`, and `cf[id]`... Operators: `=`, `!=`, `IN`, and `NOT IN`."                                                                                    | https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (`components.schemas.WebhookDetails`)                                                                                     | 2026-09-22    |
| P2 — Mesma restrição de JQL, redigida na página de plataforma                                                                                                                                                                                                                | https://developer.atlassian.com/cloud/jira/platform/webhooks/                                                                                                                                    | 2026-09-22    |
| P2 — "Extends the life of webhook. Webhooks registered through the REST API expire after 30 days. Call this operation to keep them alive." (`PUT /rest/api/3/webhook/refresh`)                                                                                               | https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (`paths./rest/api/3/webhook/refresh.put`)                                                                                 | 2026-09-22    |
| P2 — "The expiration period is 30 days from the time the webhook was created or refreshed..." / "Webhooks are available for up to 3 months after they expire."                                                                                                               | https://developer.atlassian.com/cloud/jira/platform/webhooks/                                                                                                                                    | 2026-09-22    |
| P2 — `security`/`x-atlassian-oauth2-scopes` = `read:jira-work` + `manage:jira-webhook` (Current) para register/get/delete/refresh; granulares Beta `write:webhook:jira`, `read:webhook:jira`, `delete:webhook:jira`, `read:field:jira`, `read:project:jira`, `read:jql:jira` | https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (`paths./rest/api/3/webhook`, `/rest/api/3/webhook/refresh`)                                                              | 2026-09-22    |
| P2 — `manage:jira-webhook` = "Fetch, register, refresh, and delete dynamically declared Jira webhooks."                                                                                                                                                                      | https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/                                                                                                       | 2026-09-22    |
| P2 — `jira:issue_updated` requer `read:issue-details:jira`                                                                                                                                                                                                                   | https://developer.atlassian.com/cloud/jira/platform/webhooks/                                                                                                                                    | 2026-09-22    |
| P2 — "NOTE: for non-public OAuth apps, webhooks are delivered only if there is a match between the app owner and the user who registered a dynamic webhook."                                                                                                                 | https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (`paths./rest/api/3/webhook.post.description`)                                                                            | 2026-09-22    |
| P2 — "Only webhooks registered by the calling app are removed. If webhooks created by other apps are specified, they are ignored."                                                                                                                                           | https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (`paths./rest/api/3/webhook.delete.description`)                                                                          | 2026-09-22    |
| P2 — registro atual usa `project = ${projectRef}` e um `webhooks[0]` por chamada                                                                                                                                                                                             | `apps/web/src/integrations/jira/server/webhook-registration.ts:32-41`                                                                                                                            | 2026-09-22    |
| P2 — não há chamada a `/rest/api/3/webhook/refresh` no repositório (só `refreshJiraToken`, OAuth token)                                                                                                                                                                      | busca em `apps/web/src` e `packages`                                                                                                                                                             | 2026-09-22    |
| P3 — exemplo publicado de `jira:issue_updated`: `issue.fields` contém apenas `summary`, `created`, `description`, `labels`, `priority` — **sem** `project` e **sem** `issuetype`                                                                                             | https://developer.atlassian.com/cloud/jira/platform/webhooks/                                                                                                                                    | 2026-09-22    |
| P3 — "The same shape returned from the Jira REST API when an issue is retrieved with NO expand parameters."                                                                                                                                                                  | https://developer.atlassian.com/cloud/jira/platform/webhooks/                                                                                                                                    | 2026-09-22    |
| P3 — `getIssue`, parâmetro `fields`: `default: "*all"`, "`*all` Returns all fields." e "Note: All fields are returned by default."                                                                                                                                           | https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (`paths./rest/api/3/issue/{issueIdOrKey}.get.parameters[fields]`)                                                         | 2026-09-22    |
| P3 — `project` e `issuetype` são campos de `fields` endereçados por `id`: exemplo oficial de `createIssue` traz `"project": {"id": "10000"}` e `"issuetype": {"id": "10000"}`                                                                                                | https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (`paths./rest/api/3/issue.post.requestBody.example`)                                                                      | 2026-09-22    |
| P3 — `IssueBean.fields` é mapa livre (`{"additionalProperties": {}, "type": "object"}`): o contrato oficial não enumera os campos da resposta                                                                                                                                | https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (`components.schemas.IssueBean`)                                                                                          | 2026-09-22    |
| P3 — o exemplo oficial de `jira:issue_updated` mostra changelog de **mudança de issue type**: `{"toString":"New Feature","to":"2","fromString":"Improvement","from":"4","fieldtype":"jira","field":"issuetype"}`                                                             | https://developer.atlassian.com/cloud/jira/platform/webhooks/                                                                                                                                    | 2026-09-22    |
| P3 — destino Jira é hoje `projectId:issueTypeId`; handler inbound lê apenas `payload.issue.key` e não emite destino                                                                                                                                                          | `apps/web/src/integrations/jira/server/hook.ts:19-28`, `issues.ts:64-74`, `inbound.ts:66-72`                                                                                                     | 2026-09-22    |
| P4 — `per_page`: "The number of results per page (max 100)", default `30`; `page` default `1`                                                                                                                                                                                | https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#list-repositories-for-the-authenticated-user                                                                                   | 2026-09-22    |
| P4 — `visibility` default `all`; `affiliation` default `owner,collaborator,organization_member`; `type` default `all`                                                                                                                                                        | https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#list-repositories-for-the-authenticated-user                                                                                   | 2026-09-22    |
| P4 — `type`: "Will cause a 422 error if used in the same request as visibility or affiliation."                                                                                                                                                                              | https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#list-repositories-for-the-authenticated-user                                                                                   | 2026-09-22    |
| P4 — header `link` com `rel` `next`/`prev`/`first`/`last`; "You can use the URLs from the `link` header to request another page of results."                                                                                                                                 | https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2022-11-28                                                                                        | 2026-09-22    |
| P4 — "If you specify a value greater than the maximum, GitHub does not return an error. Instead, the value is automatically reduced to the maximum."                                                                                                                         | https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2022-11-28                                                                                        | 2026-09-22    |
| P4 — chamada única sem paginação, header `link` ignorado                                                                                                                                                                                                                     | `apps/web/src/integrations/github/server/repos.ts:13-36`                                                                                                                                         | 2026-09-22    |

## Incertezas restantes

Nenhuma destas foi convertida em conclusão acima. São lacunas reais.

1. **`fields.project.id` e `fields.issuetype.id` no payload do webhook: provado por cadeia, não por exemplo.**
   O exemplo publicado de `jira:issue_updated` é explicitamente parcial e não mostra nenhum dos dois. A conclusão
   depende de encadear "mesma forma do Get issue sem expand" + "`fields` default `*all`, todos os campos por padrão".
   Não achei nenhuma página da Atlassian que liste, de forma enumerada e normativa, o conteúdo do `fields` no payload
   do webhook — e o próprio OpenAPI tipa `IssueBean.fields` como mapa livre, então essa página provavelmente não
   existe. **Verificação barata:** registrar um webhook de teste num site Jira e inspecionar um payload real
   (T-005/T-006 já tocam esse código). **A recomendação de P3 foi escrita para não depender desta lacuna.**

2. **Efeito dos escopos granulares sobre o conteúdo do payload.** Os escopos Beta de `registerDynamicWebhooks`
   incluem `read:field:jira` e `read:project:jira`, e a tabela por evento exige `read:issue-details:jira`. Não
   encontrei nenhuma afirmação documentada sobre se o app receber apenas um subconjunto de escopos faz o Jira
   **omitir campos** do payload entregue. Se omitir, `fields.project` poderia faltar para um app com escopos
   insuficientes. Sem prova em nenhuma direção.

3. **`project = <id numérico>` no `jqlFilter`.** O código atual passa um `projectRef` que o regex
   `/^[A-Za-z0-9_]+$/` aceita tanto como key quanto como id. O OpenAPI diz que o campo `project` é suportado, mas
   **não** diz quais formas de valor (nome / key / id) são aceitas nesse subconjunto restrito de JQL. A página de
   referência de campos JQL do Atlassian Support não pôde ser lida (conteúdo truncado nas tentativas). Como o destino
   Jira do Quackback é identificado por **id**, e o registro atual usa **key**, o planner precisa fechar isto antes de
   T-006. **Não assuma que `project = 10000` funciona no `jqlFilter`.**

4. **A nota de isolamento de webhooks de app OAuth vale para repositórios?** Ela está documentada, verbatim e em
   todos os endpoints, para webhooks de **organização**. Não a encontrei na página de webhooks de **repositório** na
   renderização atual. Se valer também para repositórios, então `findGitHubWebhookByUrl`
   (`GET /repos/{owner}/{repo}/hooks`) só enxerga hooks criados pela própria app OAuth — e o caminho de recuperação
   do `already exists` falharia (retorna `null`, re-lança) justamente quando o hook conflitante foi criado por uma
   pessoa na UI do GitHub com a mesma URL. Não provado nem refutado.

5. **Escopo OAuth do GitHub realmente solicitado pelo Quackback.** Afirmei que remover webhook exige
   `admin:repo_hook` ou `repo` (isso está provado pela página de escopos). **Não** verifiquei qual escopo a app do
   Quackback pede — fora do recorte de T-002.

6. **Limite de tamanho do `jqlFilter`.** Nenhum máximo documentado (nem `maxLength` no schema). Isso **não** é prova
   de que não exista limite no servidor. Relevante porque a recomendação abaixo propõe `project IN (...)` crescendo
   com o número de destinos.

## Recomendação

### R1 — Jira: o destino passa a ser identificado só pelo projeto (P3)

Mude a forma do destino Jira de `projectId:issueTypeId` para **`projectId`**. O `issueTypeId` continua existindo,
mas como **configuração de criação por destino** (qual tipo criar ao empurrar um post), fora da chave de identidade
e fora do `destinationKey`.

Três razões, em ordem de força:

1. O issue type **muda ao longo da vida do issue** — a documentação primária demonstra isso no próprio exemplo de
   `jira:issue_updated`. Uma identidade que o inclui quebra na primeira mudança de tipo, silenciosamente, que é
   exatamente o risco "Falha silenciosa do status sync do Jira" já na spec.
2. O `jqlFilter` do registro é escopado por `project`; não há como manter coerência entre um webhook por projeto e
   uma identidade por projeto+tipo.
3. A presença garantida de `issuetype.id` no payload não está provada por exemplo publicado (incerteza 1). Com R1,
   essa incerteza deixa de bloquear qualquer coisa — só `project.id` importa, e ele é o mais fundamental dos dois.

**Impacto na migração (T-001):** o risco "Migração de links existentes" da SPEC-0001 exige preservar o
`destinationKey` byte a byte. Se o `destinationKey` atual deriva de `config.channelId` inteiro
(`projectId:issueTypeId`), **R1 muda esse valor** e órfã os links Jira existentes. O planner precisa decidir
explicitamente: ou o `destinationKey` continua derivando da string legada (identidade estável, semântica nova), ou a
migração reescreve `syncScope` dos links Jira. **Isto não é detalhe de implementação — é uma escolha que o plano
tem de registrar.** Um teste de migração sobre fixture com links Jira pré-existentes é obrigatório.

### R2 — Jira: um webhook por conexão, não por destino (P2)

O teto de **5 webhooks por app OAuth por usuário por tenant** e a regra de **uma única URL por app** matam o desenho
"um webhook por destino". Substitua por:

- **Um** webhook dinâmico por conexão Jira, com `jqlFilter: project IN (P1, P2, ..., Pn)`.
- Adicionar ou remover destino = **reescrever o filtro** desse webhook (delete + register, já que o OpenAPI não expõe
  update de webhook dinâmico), não criar/remover um webhook.
- O `externalWebhookId` volta a ser **um por conexão**, não por destino — contrariando a premissa do enunciado de
  que "o registro passará a ser por destino". Para GitHub continua por destino; para Jira, não.

Atenção ao critério de aceite 4 da SPEC-0001 ("adicionar ou remover um destino não cancela operações de sync em voo
dos demais"): com um webhook compartilhado, a reescrita do filtro tem uma janela em que o webhook não existe. O
plano precisa dizer se isso é aceitável ou se exige register-antes-de-delete (o que temporariamente usa 2 dos 5
slots, ainda dentro do teto).

Antes de fixar isto, feche a **incerteza 3** (id vs key no `jqlFilter`) e a **incerteza 6** (tamanho do filtro).

### R3 — Jira: refresh de webhook é trabalho novo e independente (P2)

Webhooks REST expiram em 30 dias. Não achei refresh no repositório. Se confirmado, é um bug de produção **anterior**
a esta spec. Trate como ticket próprio (job periódico chamando `PUT /rest/api/3/webhook/refresh`), não como parte de
multi-destino — mas note que R2 o torna mais barato: com um webhook por conexão, há um id para renovar, não N.

### R4 — GitHub: manter um webhook por repositório, e endurecer o caminho de duplicata (P1)

O limite de 20-por-evento-por-repositório **não** restringe multi-destino. Mantenha um webhook por repositório.

Mas o tratamento de duplicata precisa parar de depender de texto de erro não documentado. Proposta:

- Trocar `catch` + regex por **`GET /repos/{owner}/{repo}/hooks` primeiro** (paginado — o mesmo bug de P4 existe no
  `per_page=100` de `findGitHubWebhookByUrl`), procurar pela `config.url`, e então `PATCH` ou `POST`.
- Se mantiver o `catch`, restrinja-o a `response.status === 422` **e** à ausência de outro hook com a mesma URL, em
  vez de casar a frase. Hoje o `Error` lançado por `registerGitHubWebhook` perde o status — só carrega a string.
- Considerar a incerteza 4: se a app OAuth não enxerga hooks alheios, nenhum dos dois caminhos recupera de um hook
  criado por humano. Nesse caso o comportamento correto é **falhar com mensagem acionável para o admin**, não
  silenciar.

Confirmar também que o escopo OAuth pedido inclui delete (`admin:repo_hook` ou `repo`) — o critério de aceite 5
depende disso.

### R5 — GitHub: T-009 é só paginação (P4)

Não mexa em `affiliation`, `visibility` ou `type`: os defaults já entregam o conjunto máximo, e combinar `type` com
os outros dois é 422 garantido. A correção é seguir `link` `rel="next"` até esgotar. Aplicar o mesmo tratamento a
`findGitHubWebhookByUrl`, que tem o mesmo defeito. Como não há header de contagem total, um seam de teste com duas
páginas (`link` com `rel="next"` na primeira, sem ele na segunda) é a forma de pinar o comportamento.

### Ordem sugerida para o planner

1. Decidir R1 (forma do destino Jira) — **bloqueia T-001, T-005, T-006**, porque muda o `destinationKey` e a migração.
2. Decidir R2 (webhook por conexão no Jira) — bloqueia T-006 e o critério de aceite 4.
3. Fechar incertezas 3 e 4 antes de escrever o plano de T-005/T-006 (ambas verificáveis contra a API em minutos).
4. R3, R4 e R5 são independentes entre si e podem ser paralelizados.

## Correções 2026-09-22 (verificação do orchestrator)

Três pontos revisados contra o repositório e contra a fonte primária. As conclusões R1–R5 seguem de pé; o que muda
é o estado de duas incertezas e a força de uma citação.

**C1 — Incerteza 3 partia de premissa errada: o código já usa o `id`, não a `key`.**
`listJiraProjects` devolve `project.id` (`integrations/jira/server/projects.ts:30`), e é esse valor que
`jira-config.tsx:144` grava em `channelId` como `${projectId}:${issueTypeId}`. Como `registerJiraWebhook` recebe
`config.channelId.split(':')[0]`, o `jqlFilter` emitido hoje em produção já é `project = <id numérico>`, não
`project = <KEY>`.

Isso reclassifica a incerteza: não é uma decisão de design pendente para T-006, é uma **questão empírica sobre o
comportamento atual**. Ou `project = <id>` é aceito no subconjunto de JQL do webhook — e então já funciona — ou o
registro de webhook Jira do Quackback **já falha hoje**, antes de qualquer multi-destino. O `registerJiraWebhook`
lança em `!response.ok`, então a falha seria visível como erro de conexão, não silenciosa. Verificação barata:
conectar um Jira e observar se o registro conclui. **Não bloqueia T-006 como decisão; bloqueia como fato a observar.**

**C2 — Incerteza 5 resolvida: o escopo GitHub pedido é `repo`.**
`apps/web/src/integrations/github/server/oauth.ts:29` pede `scope: 'repo'`. Pela própria página de escopos citada na
tabela de evidências, `repo` concede acesso a repository webhooks, incluindo delete. **O ponto de atenção de P1
sobre `write:repo_hook` não conceder delete não se aplica ao Quackback**, e o critério de aceite 5 da SPEC-0001 não
está em risco por escopo. O alerta continua válido apenas como restrição a não regredir: trocar `repo` por
`write:repo_hook` quebraria a remoção por destino.

**C3 — A citação de "uma única URL por app" tem duas fontes oficiais que divergem.**
O artefato cita o OpenAPI (`WebhookRegistrationDetails.url`): "Only a single URL per app is allowed to be registered."
A página de plataforma, relida em 2026-09-22, diz algo mais fraco: "The registered URL must use the same **base** URL
as the app." Se a segunda for a regra efetiva, path e query **poderiam** codificar o destino — o que o artefato
descarta como impossível.

Isso **não altera R2**: o teto de 5 webhooks por app OAuth por usuário por tenant, confirmado verbatim numa segunda
leitura independente, já inviabiliza "um webhook por destino" sozinho. Mas a afirmação sobre a URL deve ser tratada
como **contestada entre duas fontes oficiais**, não como fato estabelecido, caso algum desenho futuro dependa dela.

**Confirmações independentes (segunda leitura, 2026-09-22):** o limite de 5 para OAuth 2.0 e a expiração de 30 dias
com necessidade de chamar periodicamente o refresh foram ambos reconfirmados verbatim em
https://developer.atlassian.com/cloud/jira/platform/webhooks/. A ausência de qualquer chamada a
`/rest/api/3/webhook/refresh` no repositório foi reconfirmada por busca direta. **R3 procede.**

## Adendo 2026-09-25 — contrato exato dos endpoints de webhook (para T-010)

As páginas HTML da Atlassian truncam em qualquer leitura via fetch. Este adendo vem do OpenAPI oficial baixado
inteiro (`swagger-v3.v3.json`, 2.473.752 bytes, consultado em 2026-09-25) e lido programaticamente — não de
exemplo em prosa.

### `PUT /rest/api/3/webhook/refresh`

- Request: `ContainerForWebhookIDs` — `{ "webhookIds": number[] }`, `required: ["webhookIds"]`,
  `additionalProperties: false`, itens `integer/int64`. **Sem `maxItems` declarado.**
- Respostas documentadas: **200**, **400** ("Returned if the request is invalid"), **403** ("Returned if the
  caller isn't an app"). Não há 401/404 documentados.
- Escopos: `read:jira-work` + `manage:jira-webhook` (Current) — **os mesmos do registro**, então T-010 não exige
  escopo novo.

**Contradição na própria spec, que o implementador precisa tratar:** o schema `WebhooksExpirationDate` declara
`expirationDate` como `integer`/`int64`, mas o `example` do mesmo endpoint mostra
`{"expirationDate":"2019-06-01T12:42:30.000+0000"}` — uma **string ISO**. As duas afirmações são oficiais e
incompatíveis. Consequência: código que assuma um dos dois tipos quebra quando a API entregar o outro. O caminho
seguro é não depender do campo para decidir sucesso (o status 200 já decide) e, se for registrá-lo, aceitar
número e string.

### `GET /rest/api/3/webhook` — muda o desenho do T-010

Existe, é paginado (`startAt`, `maxResults`), devolve `PageBeanWebhook` de `Webhook`:

| campo            | tipo                       |
| ---------------- | -------------------------- |
| `id`             | `integer/int64` (required) |
| `url`            | `string` (required)        |
| `jqlFilter`      | `string` (required)        |
| `events`         | `array` (required)         |
| `expirationDate` | `integer/int64` (opcional) |

Escopos idênticos aos demais. Combinado com a nota já registrada acima — "Only webhooks registered by the calling
app are removed. If webhooks created by other apps are specified, they are ignored" — a listagem é **restrita aos
webhooks do próprio app**.

Isso torna o T-010 melhor do que o desenho original: em vez de renovar cegamente o `config.externalWebhookId`
gravado localmente, o job pode **listar o que de fato existe do lado do Jira**, ver o `expirationDate` real de
cada um, e renovar esses ids. Isso cobre de graça três casos que o desenho baseado em config não cobre —
`externalWebhookId` divergente do remoto, webhook removido manualmente no Jira, e webhook já expirado (que
precisa de re-registro, não de refresh).

~~**Incerteza que permanece:** não há, no OpenAPI, afirmação sobre o que `refresh` faz com um id que não pertence
ao app ou não existe — só o 400 genérico. A nota de "ignora ids de outros apps" está documentada para o
**DELETE**, não para o refresh. Não assuma simetria.~~

**Correção 2026-09-25 — o parágrafo acima estava errado.** Eu havia lido apenas o schema e os códigos de
resposta, não a `description` do endpoint. Ela afirma o contrário, verbatim:

> Extends the life of webhook. Webhooks registered through the REST API expire after 30 days. Call this
> operation to keep them alive.
>
> **Unrecognized webhook IDs (those that are not found or belong to other apps) are ignored.**
>
> **Permissions required:** Only Connect and OAuth 2.0 apps can use this operation.

(`paths./rest/api/3/webhook/refresh.put.description`, mesma cópia do OpenAPI, relida em 2026-09-25.)

A simetria com o DELETE é **documentada, não inferida**. Consequências concretas:

- Um webhook removido manualmente no Jira, ou já expirado e colhido, **não** faz o refresh falhar — é ignorado.
  Isso sustenta o critério de aceite 2 do T-010 (renovação idempotente e tolerante a webhook ausente) sem
  precisar de pré-verificação.
- O 403 documentado ("Returned if the caller isn't an app") é sobre a natureza do chamador, não sobre posse dos
  ids. Um 403 no refresh significa credencial/app errado, não "esse id não é seu" — distinção que importa para
  a mensagem que vai parar no `lastError`.
