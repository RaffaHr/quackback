---
id: T-004
title: Editar um destino não cancela operações em voo dos demais
status: done
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

## Fechamento 2026-09-25

### A premissa deste ticket caiu — mas ele não era vazio

Este ticket foi escrito supondo destinos **dentro** do `config`, e propunha excluí-los do hash de `canDispatchSync`.
O T-001 os pôs numa tabela própria. Como o hash cobre só `integration.config`, **adicionar ou alterar uma linha de
destino não o altera**: os critérios 1 e 2 ficaram verdadeiros por construção, e o critério 1 não precisa ser
implementado — precisa ser reescrito.

Parecia, então, um ticket só de prova. **Não era.** Ao provar o critério 3, o `tdd-driver` achou um bug real.

### O bug: a janela entre pegar e enviar

`canDispatchSync` é o _"recheck immediately before dispatch"_ do código — mas ele só recheca o **config**. Com os
destinos fora do config, uma edição de destino que chegue **entre o worker pegar a operação e enviá-la** (durante a
leitura de credenciais em `getIntegrationAuth`) não é vista por ninguém. Resultado medido:
`{"state":"succeeded","posts":["https://api.github.com/repos/acme/api/issues"]}` — a issue criada no repositório
**que o admin acabou de abandonar**.

**Latente hoje, ativo depois do T-005.** Hoje toda edição de destino passa pela tela antiga, que muda também o
`config.channelId`; o hash do config muda e `canDispatchSync` cancela. A janela só abre quando a edição toca a
tabela _sem_ tocar o config — que é exatamente o que o adendo do T-005 exige. **O T-005 abriria este buraco.**

### A correção

Recheck do próprio destino **no mesmo ponto** em que o config é rechecado — entre `canDispatchSync` e
`markSyncDispatched`:

- `sync/tickets.ts` — sempre, porque criação por ticket sempre resolve o destino pela tabela.
- `sync/hooks.ts` — **só quando a entrega foi autorizada pelo destino-padrão**. Uma rota de canal explícito (todo
  canal de Slack) tem chave que não é linha nenhuma da tabela; rechecar ali cancelaria toda notificação de Slack.

### Verificação

| Teste                                                                          | Resultado                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `destination-stability.db.test.ts` (novo, 7 testes)                            | 7/7                                                          |
| └ caso novo: _editar X com X em voo cancela X antes do envio_                  | vermelho (`succeeded`) → verde                               |
| `destination-source.db.test.ts` + caso novo _edição do padrão DURANTE o envio_ | 10/10                                                        |
| Controle positivo do recheck de `hooks.ts` removido                            | **exatamente** o caso novo fica vermelho, os outros 9 passam |
| Guardas de canal explícito (Discord em `provider-contracts`)                   | seguem passando — a delimitação não afeta Slack/Discord      |

O controle positivo do próprio `tdd-driver` — recolocar os destinos no hash de estabilidade, recriando o que este
ticket temia — deixou vermelhos **exatamente os dois testes de sobrevivência de Y** na janela do hash.

**Nada disto foi test-first de verdade** na propriedade original (ela já era verdadeira). O caso do bug, sim: o
teste foi escrito vermelho, e só então a correção.

### Estado dos critérios

| Critério                             | Estado                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| 1. excluir destinos do hash          | verdadeiro por construção — o hash nunca os viu                                   |
| 2. X sobrevive à adição de Y         | ✅ provado, com controle positivo                                                 |
| 3. X é cancelado quando X é alterado | ✅ **agora também dentro da janela de envio**, via recheck                        |
| 4. reconexão cancela tudo            | ✅ provado no nível do worker (antes só havia cobertura para `inspectSyncRemote`) |
