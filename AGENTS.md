# AGENTS — Quackback

<!-- specdriven:begin -->

Bloco gerado e mantido pelo `setup-facilitator` do SpecDriven Workflow. Reexecução é merge: nada fora
destes marcadores é tocado. A configuração mecânica correspondente vive em
`.specdriven/repositories.json` (`workflow.profile`).

## Escopo do produto

Quackback é uma suíte open source de suporte e feedback de produto: boards de feedback com voto,
inbox de atendimento, help center, changelog, portal público, widget embarcável, API REST, webhooks,
servidor MCP e ~25 integrações (Slack, Linear, Jira, GitHub, Intercom, Zendesk e outras). O mesmo
código roda self-hosted e na nuvem; o bloco `cloud` é default-off e uma instalação sem configuração
de nuvem é entitled a tudo, sem chamadas externas.

## Arquitetura

Monorepo Bun workspaces, estilo **domain-modular**:

- `apps/web` — TanStack Start + TanStack Router (React 19, SSR/Nitro). Server functions e domínios de
  servidor em `src/lib/server/domains/<domínio>/`; rotas file-based em `src/routes`; UI em
  `src/components`. Tailwind v4 + shadcn/ui.
- `packages/db` — Drizzle ORM sobre PostgreSQL: schema, migrations, seed, drift check e fila de jobs.
- `packages/widget` — bundle embarcável (tsup), consumido por `apps/web` via Vite `?raw`; **precisa
  ser buildado antes** do build do web.
- `packages/email`, `packages/ids`, `packages/logger` — infraestrutura compartilhada, sem gates próprios.

Regras que o planner e o reviewer devem tratar como invariantes:

- Um domínio novo nasce em `src/lib/server/domains/<nome>/`; lógica de domínio não mora em rota nem
  em componente.
- Server function que o grafo do cliente nunca referencia fica fora do manifesto gerado e só quebra
  em build de produção — por isso `check:server-fn-manifest` roda depois do build, nunca antes.
- Mudança de schema em `packages/db` sem migration correspondente é drift (`db:check-drift`), e drift
  é divergência de paridade, não detalhe de implementação.
- Decisões arquiteturais duráveis viram `docs/adr/ADR-*.md`. Ver `ADR-0001` para a modelagem de
  destinos de tracker.

## Consumidores canônicos e paridade

Consumidores com gates próprios: **web**, **widget**, **db**. Paridade é obrigatória nas dimensões
`contract-usage`, `states`, `routes` e `schema` — divergência sem decisão explícita do usuário é
`BLOCKED_PARITY`, resolvida antes do código.

## Fluxo

- Tracker: **GitHub** via `gh`, repositório `RaffaHr/quackback` (fork). O remote `origin` aponta para
  o upstream `QuackbackIO/quackback` e não recebe escrita do workflow.
- Estágios upstream: `spec` **required**, `tickets` **required**, `triage` optional, `wayfind` off.
  Toda mudança nasce de um `SPEC-*` em `.specdriven/specs/` e de tickets `T-*` com blocking edges.
- TDD: modo **seams** — o planner marca os seams críticos (lógica de domínio, contrato, migration) e
  o `tdd-driver` escreve o teste vermelho antes da implementação naqueles pontos.
- Superfícies: web sim, e2e sim (Playwright), mobile **não** neste repositório — os apps nativos
  vivem em `quackback-ios` e `quackback-android`, fora daqui, então `mobile-mcp-tester` registra
  `N/A` justificado.

## Perfil do desenvolvedor

Sênior. Revisão direta ao ponto, sem explicar fundamentos. O planner decide o rotineiro sozinho e só
consulta o usuário quando a resposta muda o resultado — contrato, paridade, escopo e migration
destrutiva continuam sendo decisão do usuário.

## Comandos de quality

| Gate | web | widget | db |
|---|---|---|---|
| lint | `bun run lint` | `bun run --cwd ../.. lint packages/widget` | `bun run --cwd ../.. lint packages/db` |
| typecheck | `bun run typecheck` | `bun run typecheck` | `bun run typecheck` |
| build | widget build → `bun run build` | `bun run build` | — (pacote consumido como fonte) |
| unit | `bun run --cwd ../.. test --run apps/web` | `bun run test` | `bun run --cwd ../.. test --run packages/db` |

Não obrigatórios hoje: **coverage** (nenhum provider `@vitest/coverage-*` instalado), **integration**
(`test:api` exige Postgres + servidor live) e **e2e** (Playwright exige Postgres + dev server em
`acme.localhost:3080`). Os três ficam com `detectPaths` **vazio** de propósito: a política do runner é
`required-when-command-configured-or-detected`, então apontar a infraestrutura existente
(`playwright.config.ts`, `e2e/tests`) tornaria o gate obrigatório sem runner configurado e bloquearia
todo readiness com `MISSING_CAPABILITY`. Ligar qualquer um deles = preencher `commands` (e, se quiser
detecção automática, `detectPaths`) em `.specdriven/repositories.json`. Enquanto vazios, o gate
registra `N/A` — nunca `PASS`.

Pré-requisito de ambiente: Bun 1.4.0 e `bun install`. Sem `bun` no PATH os gates retornam
`MISSING_CAPABILITY` — comportamento correto, não falha de configuração.

## Worktrees

Workspace irmão: `C:/Users/Raffa/Documents/code/quackback-worktrees`, fora de todos os roots de
produto. Criar, mergear ou remover worktree/branch exige aprovação explícita do usuário; o checkout
principal segue sendo o agregador final.

<!-- specdriven:end -->
