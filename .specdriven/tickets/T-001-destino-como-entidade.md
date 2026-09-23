---
id: T-001
title: Destino de tracker vira entidade própria, com migração de compatibilidade
status: open
blockedBy: []
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-001: Destino de tracker vira entidade própria, com migração de compatibilidade

## Entrega (tracer bullet)

Uma instalação GitHub **já conectada, com um repositório e links existentes**, continua criando issues e recebendo
status sync exatamente como antes — só que o destino agora vem de uma linha de `integration_destinations` em vez de
`config.channelId`. Nenhuma reconexão, nenhum link órfão, nenhuma mudança visível ao usuário.

Esta é a fatia que prova que o novo modelo é um superset do antigo antes de qualquer segundo destino existir.

## Critérios de aceite

- [ ] Existe tabela de destinos com `installation_id` (FK para `integrations.id`), `destination_key`,
      referência externa legível (`owner/repo` ou `projectId:issueTypeId`), identidade de webhook e timestamps.
- [ ] A migração cria uma linha por instalação ativa de GitHub e Jira a partir do `config.channelId` atual.
- [ ] O `destination_key` gerado pela migração é **idêntico** ao `syncHash(syncDestination(...))` usado hoje, de
      modo que todo `post_external_links.sync_scope` e `ticket_external_links.sync_scope` existente continua casando.
- [ ] `config.channelId` permanece gravado e é tratado como destino-padrão de compatibilidade; nada o lê dentro de
      `sync/` depois deste ticket, exceto o caminho explícito de fallback.
- [ ] Rollback da migração é possível sem perder links (a tabela é aditiva; `config.channelId` não é removido).
- [ ] `sync/__tests__/provider-contracts.db.test.ts` passa sem alteração de expectativas.

## Seams TDD

- Cálculo do `destination_key` na migração — teste red que monta uma fixture com link pré-existente e prova que o
  `sync_scope` do link continua casando com o destino migrado. Este é o seam que, se errado, órfã todos os links
  em produção.
- Leitura de destino em `lib/server/integrations/sync/identity.ts` — o novo resolvedor devolve o mesmo valor que
  `syncDestination({ channelId: config.channelId }, ...)` devolvia, para instalação de destino único.

## Notas

- Não adiciona nenhum destino novo nem toca UI. Se este ticket sozinho mudar comportamento observável, ele falhou.
- A tabela precisa nascer com o vínculo a times já previsto (ver T-008), mesmo que nulo, para evitar segunda migração.
- `packages/db/src/schema/` + `packages/db/drizzle/`; o projeto tem drift check de constraints multi-coluna que
  exige ordem alfabética nas UNIQUE — ver comentários em `packages/db/src/schema/integrations.ts:129-131`.

## Adendo 2026-09-22 — forma do escopo por time

Decisões D-1 e D-2 de SPEC-0001 fixam a forma da tabela e tornam duas coisas obrigatórias já neste ticket, para
não exigir uma segunda migração em T-008:

- A tabela de destinos nasce com a coluna discriminadora `scope` (`'workspace' | 'teams'`), com CHECK.
- A tabela de junção `destino × time` nasce junto, mesmo que vazia, com FK para `teams` e `ON DELETE CASCADE`
  (acompanhando `principal_role_assignments_team_id_teams_id_fk`).

Critérios de aceite adicionais:

- [ ] Os destinos criados pela migração recebem `scope: 'workspace'` e **nenhuma** associação de time. Isso preserva
      literalmente o comportamento de hoje e não depende de `teams.isDefault` existir.
- [ ] O CHECK/validação que exige ao menos uma associação quando `scope = 'teams'` já existe, mesmo que nada
      escreva `'teams'` até T-008.
- [ ] Rollback continua possível: as duas tabelas são aditivas e `config.channelId` segue intacto.

## Adendo 2026-09-22 (2) — a migração do Jira deixa de ser byte-a-byte

Decisões D-4 e D-6 de SPEC-0001, vindas de [R-0002](../research/R-0002-limites-api-github-jira.md), mudam o
critério central deste ticket. A regra "o `destination_key` gerado pela migração é idêntico ao valor atual"
**continua valendo para o GitHub** e **deixa de valer para o Jira**.

Motivo: a identidade do destino Jira passa a ser só `projectId` (o issue type é mutável e sua mudança dispara o
próprio evento que consumimos), então o `destination_key` calculado muda por construção.

Critérios de aceite revisados para o Jira:

- [ ] O `destination_key` dos destinos Jira deriva de `projectId` apenas; o `issueTypeId` é preservado no destino
      como configuração de criação, fora da identidade.
- [ ] A migração atualiza `sync_scope` em `post_external_links` e `ticket_external_links` para
      `integration_type = 'jira'`, do valor derivado de `projectId:issueTypeId` para o derivado de `projectId`.
- [ ] Fixture com links Jira pré-existentes prova que, depois da migração, o fan-out inbound encontra o link.
      Este é o teste que, se faltar, órfã links em produção.
- [ ] O valor anterior de `sync_scope` é recuperável para rollback (coluna de backup, tabela de migração ou
      derivação determinística a partir do `config.channelId` legado, que segue intacto).
- [ ] Links de outros providers não são tocados pela migração.

