---
id: T-007
title: Destino explícito nas operações manuais de push e link
status: open
blockedBy: [T-003, T-005]
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-007: Destino explícito nas operações manuais de push e link

## Entrega (tracer bullet)

Ao criar uma issue a partir de um post ou de um ticket, a pessoa escolhe em qual repositório/projeto ela nasce.
A operação enfileirada carrega esse destino, e o item criado fica ligado a ele.

## Critérios de aceite

- [ ] `createIssueForTicket` (`domains/tickets/ticket-external-links.service.ts:303-357`) aceita um destino
      explícito e o usa para montar `destination` e `operationKey`.
- [ ] `executeTicketCreate` (`sync/tickets.ts:17-40`) monta o `auth` com o destino da operação, não com
      `config.channelId`.
- [ ] `linkTicketToIssue` (`.../ticket-external-links.service.ts:244-300`) aceita destino explícito e valida a
      referência contra ele.
- [ ] O push manual de post (`syncPostIntegrations`, `lib/server/integrations/post-sync.ts`) aceita destino
      explícito; sem destino informado, mantém o comportamento atual de resolver pelos mappings.
- [ ] Seletor de destino na UI de post e de ticket, com os mesmos estados de loading/vazio/erro do seletor de T-005.
- [ ] Destino ausente, inválido ou já removido é recusado no servidor com erro de validação explícito — nunca
      substituído silenciosamente pelo destino padrão.
- [ ] Criar a mesma issue duas vezes para o mesmo (fonte, destino) continua idempotente.

## Seams TDD

- `sync/tickets.ts` — `executeTicketCreate` com destino da operação divergente do `config.channelId`.
- `domains/tickets/ticket-external-links.service.ts` — destino removido entre a escolha e o despacho deve produzir
  `CONNECTION_CHANGED`, não fallback.

## Notas

- Item I5 de R-0001: hoje essas funções simplesmente não têm parâmetro de destino na assinatura.
- Ainda **sem** filtro por time — este ticket entrega a escolha; T-008 entrega a restrição.
