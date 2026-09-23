---
id: T-002
title: Limites das APIs GitHub e Jira para webhooks e listagem por destino
status: done
blockedBy: []
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
result: .specdriven/research/R-0002-limites-api-github-jira.md
---

# T-002: Limites das APIs GitHub e Jira para webhooks e listagem por destino

## Entrega (tracer bullet)

Artefato `.specdriven/research/R-0002-*.md` respondendo, com citação de documentação oficial por afirmação, o que
o desenho de multi-destino precisa saber antes de ser fixado no plano.

## Critérios de aceite

- [ ] Responde: quantos webhooks um app OAuth do GitHub pode registrar por repositório, e o que acontece ao
      registrar um hook duplicado com a mesma URL (hoje o código trata `already exists` com `findGitHubWebhookByUrl`
      + `PATCH` — `integrations/github/server/index.ts:62-68`; confirmar que isso é o comportamento documentado).
- [ ] Responde: o Jira Cloud permite N webhooks dinâmicos por (app, site)? Há limite de JQL/escopo por webhook?
      O registro atual usa um `projectRef` por webhook (`integrations/jira/server/webhook-registration.ts`).
- [ ] Responde: o payload de `jira:issue_updated` traz de forma confiável `issue.fields.project.id` **e** o issue
      type, dado que o `channelId` do Jira é `projectId:issueTypeId`. Se o issue type não vier, o scope do destino
      Jira precisa mudar de forma (decisão para o planner).
- [ ] Responde: paginação de `GET /user/repos` e se `affiliation`/`type` mudam o conjunto retornado (insumo de T-009).
- [ ] Cada afirmação tem URL de fonte primária e data de consulta; o que não for provado por fonte primária fica
      registrado como incerteza, não como conclusão.

## Seams TDD

N/A — worker de investigação, não escreve código de produto.

## Notas

- Pode rodar em paralelo com T-001; não compartilha arquivos.
- Bloqueia T-005 e T-006 porque a forma do registro de webhook por destino depende dessas respostas.
