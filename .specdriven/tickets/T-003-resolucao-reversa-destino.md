---
id: T-003
title: Resolução reversa destinationKey → destino, para inspect e revisão de link
status: open
blockedBy: [T-001]
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-003: Resolução reversa destinationKey → destino, para inspect e revisão de link

## Entrega (tracer bullet)

Um link cujo `syncScope` aponta para um destino que **não** é o `config.channelId` atual deixa de ser tratado como
"não verificado": `issues.inspect` roda contra o repositório/projeto correto daquele link, e a revisão de conteúdo
apresenta o item remoto certo.

## Critérios de aceite

- [ ] Existe resolução `(installation, destinationKey) → destino` sobre a tabela de T-001.
- [ ] `reviewDestination` (`sync/identity.ts:51-67`) resolve pelo `syncScope` do link, não pelo `config.channelId`.
- [ ] `inspectSyncRemote` (`sync/remote.ts:19-24`) monta o `auth` com o destino do link.
- [ ] `githubIssues.inspect` recebe o `owner/repo` do link, não o da instalação
      (`integrations/github/server/issues.ts:23-28`).
- [ ] Um `destinationKey` desconhecido ou de um destino removido continua devolvendo o envelope
      `{ unverifiedLink, previousScope }` — degradar é permitido, adivinhar não.

## Seams TDD

- `sync/identity.ts` — `reviewDestination` com um link de outro destino: teste red que prova que hoje devolve
  `unverifiedLink` e depois passa a devolver o destino real.
- `sync/remote.ts` — `inspectSyncRemote` recusa quando o destino do link não existe mais, em vez de cair no atual.

## Notas

- Este é o item I6 de R-0001, classificado como a mudança estrutural mais séria: o `destinationKey` é hoje um hash
  SHA-256 unidirecional (`syncHash`), sem caminho de volta.
- Não introduz nenhum destino novo — opera sobre o destino único migrado em T-001.
