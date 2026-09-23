---
id: T-004
title: Editar um destino não cancela operações em voo dos demais
status: open
blockedBy: [T-001]
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-004: Editar um destino não cancela operações em voo dos demais

## Entrega (tracer bullet)

Com uma operação de sync enfileirada e ainda não despachada, mexer na configuração de destinos deixa de cancelá-la.
O que continua cancelando é o que de fato invalida o despacho: troca de credencial, reconexão, mudança do próprio
destino daquela operação.

## Critérios de aceite

- [ ] `canDispatchSync` (`sync/eligibility.ts:58-63`) exclui a lista de destinos do hash de estabilidade, do mesmo
      modo que já exclui `tokenExpiresAt`.
- [ ] Operação enfileirada para o destino X sobrevive à adição de um destino Y.
- [ ] Operação enfileirada para o destino X **é** cancelada (`installation_changed`) quando o destino X é removido
      ou alterado.
- [ ] Reconexão da instalação continua cancelando tudo (o `installationIdentity` muda — comportamento preservado).

## Seams TDD

- `sync/eligibility.ts` — `canDispatchSync` com config mutado: três testes red (adicionar outro destino → sobrevive;
  remover o próprio destino → cancela; reconectar → cancela).

## Notas

- Item I4 de R-0001.
- Depende de T-001 apenas porque a "lista de destinos" precisa ter saído do blob `config` para que a exclusão do
  hash seja bem definida.
