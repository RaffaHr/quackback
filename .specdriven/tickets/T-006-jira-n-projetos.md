---
id: T-006
title: Jira com N projetos, com destino identificado no inbound
status: open
blockedBy: [T-001, T-002, T-004]
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-006: Jira com N projetos, com destino identificado no inbound

## Entrega (tracer bullet)

Um admin adiciona um segundo projeto Jira. Uma mudança de status numa issue do projeto B produz uma revisão ligada
ao post do projeto B — hoje esse webhook não encontra link nenhum quando o projeto não é o configurado.

## Critérios de aceite

- [ ] `jiraInboundHandler.parseStatusChange` devolve `destinationId` no mesmo formato do `channelId` do destino
      (`projectId:issueTypeId`, ou a forma decidida em T-002 se o issue type não vier no payload).
- [ ] `fanOutInboundStatus` encontra o link do projeto B sem cair no fallback `config.channelId`
      (`sync/inbound.ts:208-218`).
- [ ] Registro de webhook por projeto, com uma identidade de webhook por destino
      (`integrations/jira/server/index.ts:35-48` hoje grava um só).
- [ ] UI de roteamento de destinos na tela do Jira, reusando o componente de T-005, com a seleção dependente
      projeto → issue type (a capability `destinations` já modela `childOf`).
- [ ] O `statusMode: 'review'` do Jira é preservado: nada passa a atualizar status automaticamente por causa
      deste ticket.
- [ ] Status mapping continua global por instalação; teste que prova que mapear "Done" funciona para os dois
      projetos (os statuses do Jira são listados por site e deduplicados por nome —
      `integrations/jira/server/statuses.ts:20-28`).

## Seams TDD

- `integrations/jira/server/inbound.ts` — teste red: webhook do projeto B com um link existente no projeto B
  encontra o link. Hoje falha em silêncio, que é o pior modo de falha do escopo inteiro.
- `sync/inbound.ts` — fan-out com dois links da mesma instalação em destinos diferentes.

## Notas

- Item I2 de R-0001, o bloqueador de maior risco: a falha atual é silenciosa (nenhum erro, nenhum link encontrado,
  operação encerra normalmente).
- `integrations/jira/server/__tests__/inbound.test.ts` e `webhook-registration.test.ts` já existem e serão os
  pontos de extensão.

## Adendo 2026-09-22 — R-0002 invalida o desenho original deste ticket

Dois critérios acima estão errados e ficam **substituídos**. O ticket continua válido no objetivo; muda a forma.

### O que caiu

- **"Registro de webhook por projeto, com uma identidade de webhook por destino"** — inviável. Um app OAuth 2.0 tem
  teto de **5 webhooks por app por usuário por tenant**. N projetos quebrariam no sexto.
- **`destinationId` no formato `projectId:issueTypeId`** — perigoso. O issue type é mutável, e o exemplo oficial de
  `jira:issue_updated` publicado pela Atlassian é justamente um changelog de mudança de tipo. A identidade quebraria
  silenciosamente na primeira troca.

### O que vale (D-4 e D-5 de SPEC-0001)

- [ ] `jiraInboundHandler.parseStatusChange` devolve `destinationId` = **`projectId`**, lido de
      `issue.fields.project.id` do payload.
- [ ] O destino Jira é identificado por `projectId`; o `issueTypeId` fica no destino como configuração de criação.
- [ ] **Um** webhook dinâmico por conexão Jira, com `jqlFilter: project IN (P1, ..., Pn)` — não um por destino.
- [ ] Adicionar ou remover destino **reescreve o filtro**: registra o webhook novo, confirma, e só então remove o
      antigo. Usa 2 dos 5 slots por um instante e não deixa janela sem webhook (critério de aceite 17 da spec).
- [ ] Adicionar o sexto projeto funciona; não existe caminho que tente registrar um sexto webhook.
- [ ] Mudar o issue type de um issue vinculado não quebra o status sync daquele link.

### Fato a observar antes de começar (não é decisão)

O código já emite `project = <id numérico>` no `jqlFilter` hoje — `listJiraProjects` devolve `project.id`
(`integrations/jira/server/projects.ts:30`) e é isso que chega em `registerJiraWebhook`. A documentação não
enumera quais formas de valor o subconjunto de JQL do webhook aceita. Como `registerJiraWebhook` lança em
`!response.ok`, uma rejeição seria ruidosa, não silenciosa: **conectar um Jira e observar se o registro conclui
responde isso em minutos.** Se não concluir, é bug atual de produção e vira pré-requisito deste ticket.

### Seams TDD adicionais

- Construção do `jqlFilter` com N projetos, incluindo N=1 e o caso de remoção que deixa o conjunto vazio (o que
  deve **remover** o webhook, não registrar um filtro vazio).
- Ordem register-antes-de-delete: teste que prova que uma falha no registro do novo **não** remove o antigo.
