---
id: T-005
title: GitHub com N repositórios, de ponta a ponta
status: open
blockedBy: [T-001, T-002, T-004]
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-005: GitHub com N repositórios, de ponta a ponta

## Entrega (tracer bullet)

Um admin adiciona um segundo repositório na tela de configuração do GitHub. Um post criado num board mapeado para
os dois repositórios vira **duas** issues, uma em cada um. Fechar a issue `#142` do repositório B atualiza o post
ligado ao repositório B — e não o post que por acaso também tem uma issue `#142` no repositório A.

## Critérios de aceite

- [ ] UI de roteamento de destinos na tela do GitHub: adicionar destino, remover destino, filtro por board por
      destino, com estados de loading/vazio/erro. **Componente próprio**, não `NotificationChannelRouter`
      (ver ADR-0001 e `shared/notification-channel-router.tsx:1-9`).
- [ ] Adicionar um destino registra o webhook naquele repositório e persiste a identidade do webhook no destino.
- [ ] Remover um destino desregistra **apenas** aquele webhook; os demais seguem ativos.
- [ ] Falha no registro de webhook não deixa destino meio-criado (compensação como a de
      `save.ts:135-158`/`install-cleanup-queue`).
- [ ] `post.created` num board mapeado para dois repositórios enfileira duas operações com `destinationKey`
      distintos e persiste dois `post_external_links`.
- [ ] Duas issues com o **mesmo número** em repositórios diferentes: webhook de fechamento de uma delas atualiza
      só o post correspondente.
- [ ] `githubIssues.parseRef` deixa de pinar o repositório único e passa a aceitar qualquer repositório **entre os
      destinos configurados**, recusando os de fora (a validação `REPO_MISMATCH` muda de alvo, não desaparece —
      `integrations/github/server/issues.ts:69-78`).
- [ ] O canal de inbox do GitHub (`channel_accounts`, role `connection`) continua funcionando; a decisão sobre
      quais repositórios alimentam o inbox fica explícita (não herdada por acidente do conjunto de destinos).

## Seams TDD

- `integrations/github/server/inbound.ts` + `sync/inbound.ts` — fan-out com `externalId` colidente entre dois
  destinos: teste red que hoje atualiza o post errado.
- `integrations/github/server/issues.ts` — `parseRef` contra um conjunto de destinos.
- Registro/remoção de webhook por destino, incluindo o caminho `already exists` → `PATCH`.

## Notas

- O cache `INTEGRATION_MAPPINGS` (`CACHE_KEYS.INTEGRATION_MAPPINGS`, TTL 300s) precisa ser invalidado em toda
  mutação de destino, como já acontece nas mutações de notification channel.
- Não inclui escolha manual de destino (T-007) nem escopo por time (T-008).

## Adendo 2026-09-22 — R-0002 (R4)

O que a pesquisa confirmou e o que ela endureceu:

- **O limite do GitHub não é risco.** São 20 webhooks *por tipo de evento, por repositório*, e cada destino é um
  repositório distinto. "Um webhook por destino" segue válido para o GitHub — ao contrário do Jira (ver T-006).
- **O escopo OAuth pedido é `repo`** (`integrations/github/server/oauth.ts:29`), que concede delete de webhook. O
  critério de aceite 5 não está em risco. Restrição a não regredir: trocar por `write:repo_hook` quebraria a
  remoção por destino, porque esse escopo não concede delete.

Critério de aceite adicional:

- [ ] O caminho de duplicata para de depender de texto de erro. A string `already exists` casada pelo regex em
      `integrations/github/server/index.ts:66` **não aparece em nenhuma página oficial do GitHub** — é mensagem
      observada, não contrato. Substituir por listar os hooks do repositório e procurar pela `config.url` antes de
      criar; ou, mantendo o `catch`, restringi-lo a `422` **e** à existência comprovada de hook com a mesma URL.
      Hoje o `Error` lançado por `registerGitHubWebhook` descarta o status e só carrega a string.
- [ ] `findGitHubWebhookByUrl` pagina (mesmo defeito de T-009: `per_page=100` sem seguir o header `link`).

Risco em aberto, registrado como incerteza em R-0002 e não resolvido: a nota *"OAuth apps cannot list, view, or
edit webhooks that they did not create"* está documentada verbatim para webhooks de **organização**, e não foi
encontrada na página de webhooks de **repositório**. Se valer também para repositórios, nenhum dos dois caminhos
acima recupera de um hook criado por uma pessoa na UI do GitHub com a mesma URL — e o comportamento correto passa a
ser falhar com mensagem acionável para o admin, não silenciar.
