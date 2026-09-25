---
id: T-011
title: Push manual de post para um destino escolhido, escopado por time
status: open
blockedBy: [T-007, T-008]
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-011: Push manual de post para um destino escolhido, escopado por time

## Entrega (tracer bullet)

Uma pessoa que não é admin abre um post, escolhe entre os destinos dos seus times e cria a issue naquele
repositório/projeto. O link resultante aponta para o destino escolhido, e o status sync de volta funciona.

## Por que este ticket existe

Ele é o requisito original do pedido — "separar por usuário quais repositórios/projetos ele poderá usar ao criar
postagens" — e **não estava coberto por T-001..T-010**. A investigação do planner mostrou que a capacidade não
existe para ser escopada:

- O único caminho manual de post é `retryPostIntegrationSyncFn`
  (`lib/server/functions/posts.ts:562`), gated em `INTEGRATION_MANAGE` e disparado do modal de admin
  (`components/admin/feedback/post-modal.tsx:174`).
- Ele chama `syncPostIntegrations(postId, principalId)`, que **redespacha para todos os targets resolvidos** pelo
  roteamento automático. Não recebe destino e não tem como receber.

Ou seja, hoje: posts não têm escolha humana de destino, e o único ator é admin. O gate por time de T-008 aplicado a
posts seria inócuo. Este ticket cria a capacidade que T-008 então escopa.

## Critérios de aceite

- [ ] Existe uma operação de push de post **com destino explícito**, distinta do resync que redespacha para todos.
- [ ] A operação tem permissão própria, **não** `INTEGRATION_MANAGE` — quem edita integrações e quem empurra
      feedback para um tracker são papéis diferentes. A chave nova entra no catálogo RBAC e no matrix de authz.
- [ ] O seletor mostra apenas destinos que o ator pode usar, pela regra de T-008 (`scope: 'workspace'`, ou
      `scope: 'teams'` com interseção nos times do ator).
- [ ] O gate é **de servidor**, não só de UI: chamada direta pedindo um destino fora do alcance do ator é recusada,
      com teste que prova a recusa.
- [ ] O link criado grava o `syncScope` do destino escolhido, e um webhook daquele destino encontra esse link.
- [ ] Empurrar o mesmo post para o mesmo destino duas vezes é idempotente (não cria issue duplicada) — a
      `operationKey` já inclui destino, então isso deve cair de graça; o teste existe para provar que caiu.
- [ ] Empurrar o mesmo post para **dois destinos diferentes** cria dois links independentes.
- [ ] O resync de admin existente (`retryPostIntegrationSyncFn`) continua funcionando sem mudança de
      comportamento observável.

## Seams TDD

- Autorização por destino no servidor — teste red provando que hoje não há como recusar (a função nem aceita
  destino).
- Persistência do link com o `syncScope` do destino escolhido.
- Idempotência por `(post, destino)` e independência entre dois destinos.

## Notas

- **Restrição estrutural descoberta pelo planner:** `lib/server/policy/authz-matrix/__tests__/scan.test.ts`
  afirma que **todo** gate do tipo `alias` vive em `lib/server/functions/moderation.ts`
  (`expect(aliases.every((g) => g.file === 'lib/server/functions/moderation.ts')).toBe(true)`). Se a autorização
  por time for implementada como alias `requireTeamAuth` fora de `moderation.ts`, esse teste quebra. Decidir entre
  estender o teste ou usar outra forma de gate é parte deste ticket, não descoberta tardia.
- A permissão nova precisa entrar em `packages/db/src/rbac-catalogue.ts` e no espelho de permissões, além de
  `lib/shared/permissions.ts` — é mudança que toca o repositório `db`, então entra na matriz de paridade.
- Não confundir com T-007: aquele dá destino explícito às operações manuais **que já existem** (ticket → issue,
  linkar issue existente). Este cria a operação de post, que não existe.
