---
id: T-010
title: Renovar webhooks dinâmicos do Jira antes dos 30 dias
status: open
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

Fonte primária (R-0002): *"The expiration period is 30 days from the time the webhook was created or refreshed"* e
*"it's necessary to periodically call the Extend webhook life API to keep them alive. Each call to the API extends
the expiration date by another 30 days."*

Consequência provável hoje: o status sync do Jira para de funcionar ~30 dias após a conexão, sem erro visível —
o webhook simplesmente deixa de entregar. Vale confirmar empiricamente numa conexão Jira antiga antes de dimensionar.

Interação com SPEC-0001: a decisão D-5 (um webhook por conexão, com `project IN (...)`) **barateia** este ticket —
há um único id de webhook para renovar por conexão, não N. Mas T-010 não depende de D-5 e pode ser entregue antes,
já que o bug é atual.

Escopo OAuth necessário para o refresh, conforme R-0002: `read:jira-work` + `manage:jira-webhook` (o mesmo usado
no registro, então nenhuma mudança de escopo é esperada — confirmar contra o que a app pede hoje).
