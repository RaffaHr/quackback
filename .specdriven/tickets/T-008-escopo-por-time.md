---
id: T-008
title: Escopo por time — cada pessoa só usa os destinos dos seus times
status: open
blockedBy: [T-007]
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-008: Escopo por time — cada pessoa só usa os destinos dos seus times

## Entrega (tracer bullet)

Um destino é associado a times. Uma pessoa do time Frontend abre o seletor de destino e vê apenas
`acme/web`; uma chamada direta ao servidor pedindo `acme/api` é recusada com 403, não apenas escondida.

## Critérios de aceite

- [ ] Associação destino ↔ time persistida, com UI de administração para gerenciá-la.
- [ ] O seletor manual lista apenas destinos dos times do ator.
- [ ] O gate é **no servidor**: a autorização vive junto de `validateSyncSource` /
      `syncSourceForActor` (`sync/eligibility.ts:73-234`), não só no filtro da query da UI. Teste que chama a
      server function diretamente com um destino fora do escopo e espera recusa.
- [ ] Destino sem time associado é utilizável por quem tem `INTEGRATION_MANAGE` (decisão de ADR-0001).
- [ ] O roteamento **automático** por board não é afetado: ele é configuração de admin, não ação de usuário.
- [ ] Remover alguém de um time não invalida links ou operações já criadas — só restringe operações futuras.
- [ ] Admin com `INTEGRATION_MANAGE` continua enxergando e gerenciando todos os destinos.

## Seams TDD

- `sync/eligibility.ts` — nova checagem de destino por time: teste red com ator de um time pedindo destino de outro.
- Resolução dos times do ator — ator sem time nenhum, ator em múltiplos times, ator service/principal de integração
  (que não deve ser barrado pelo gate de time).

## Notas

- Ativa a dimensão `principal_role_assignments.team_id`, hoje sempre `NULL`
  (`packages/db/src/schema/rbac.ts:73-76,95-99`). O próprio schema chama isso de "the team-scoping phase" —
  vale confirmar se há trabalho já planejado nessa fase antes de modelar por conta própria.

## Adendo 2026-09-22 — perguntas fechadas

As três perguntas que este ticket precisava esperar estão decididas em SPEC-0001 (D-1/D-2/D-3) e ADR-0001. Ele
deixa de estar bloqueado por decisão e passa a depender só de T-007.

- **D-1** — destino pertence a **vários** times, via tabela de junção (criada em T-001).
- **D-2** — o destino declara `scope: 'workspace' | 'teams'`. Este ticket entrega a UI e a escrita que colocam um
  destino em `'teams'`; a coluna e a validação já existem desde T-001.
- **D-3** — o gate vale **só** para o caminho manual. O roteamento automático não consulta times.

Critérios de aceite revisados (substituem os equivalentes acima):

- [ ] Um destino `scope: 'workspace'` é utilizável por qualquer pessoa autorizada a empurrar — não só por quem
      tem `INTEGRATION_MANAGE`. Esta é a diferença em relação ao que ADR-0001 assumia antes do adendo.
- [ ] Um destino `scope: 'teams'` sem associação é rejeitado na escrita; não existe caminho que o deixe salvo
      e inacessível.
- [ ] Um destino associado a dois times aparece uma única vez para quem pertence aos dois.
- [ ] Um `post.created` de autor anônimo do portal continua sendo roteado pelo automático. Teste explícito: o
      gate de time **não** é consultado nesse caminho.
- [ ] Trocar um destino de `'workspace'` para `'teams'` (e vice-versa) não invalida links nem operações já criadas.

### Notas adicionais

- **Restrição estrutural (planner, 2026-09-23):** `lib/server/policy/authz-matrix/__tests__/scan.test.ts` afirma
  que **todo** gate do tipo `alias` vive em `lib/server/functions/moderation.ts`
  (`expect(aliases.every((g) => g.file === 'lib/server/functions/moderation.ts')).toBe(true)`). Implementar o gate
  por time como alias `requireTeamAuth` fora dali quebra esse teste. Decidir a forma do gate faz parte deste
  ticket.
- **Alcance real menor do que a spec sugeria:** não existe push manual de post hoje, então este ticket escopa
  apenas o caminho de **ticket** (`TICKET_ASSIGN`). O caminho de post é criado em
  [T-011](T-011-push-manual-de-post.md), que depende deste.
- A associação de destino usa `team_members` para resolver os times do ator
  (`packages/db/src/schema/teams.ts:92`), não `principal_role_assignments` — este é sobre grants de papel, aquele
  sobre pertencimento. Confirmar essa escolha com o planner.

## Adendo 2026-09-25 — invariante herdado do T-001

O T-001 deveria garantir que **`scope = 'teams'` exige ao menos uma associação de time**. Não garantiu, e o motivo é
estrutural: o invariante atravessa `integration_destinations` e `integration_destination_teams`, então não cabe num
`CHECK` — o que existe hoje (`integration_destinations_scope_known`) só garante que `scope` seja `workspace` ou
`teams`.

Nada grava `'teams'` antes deste ticket, então o invariante pertence ao caminho de escrita que este ticket cria.

- [ ] Não existe caminho de escrita que deixe um destino com `scope = 'teams'` e zero associações. Duas formas
      aceitáveis, a decidir no plano: validação no serviço que escreve destino + times **na mesma transação**, ou
      trigger com `DEFERRABLE INITIALLY DEFERRED` (para permitir inserir o destino e depois os times dentro da
      transação). A primeira é mais simples e testável; a segunda também protege escrita direta no banco.
- [ ] Remover o último time de um destino `teams` é recusado, ou converte o destino — nunca o deixa inacessível.
