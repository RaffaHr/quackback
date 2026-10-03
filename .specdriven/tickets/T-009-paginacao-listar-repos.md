---
id: T-009
title: Paginar a listagem de repositórios do GitHub
status: done
blockedBy: []
specRef: .specdriven/specs/SPEC-0001-multi-destino-trackers.md
trackerRef: N/A
---

# T-009: Paginar a listagem de repositórios do GitHub

## Entrega (tracer bullet)

Uma conta com mais de 100 repositórios passa a ver todos eles no seletor. Hoje a lista é truncada silenciosamente.

## Critérios de aceite

- [ ] `listGitHubRepos` (`integrations/github/server/repos.ts:13`) pagina em vez de pedir `per_page=100` uma vez só.
- [ ] Há um teto de páginas e um comportamento definido ao atingi-lo — truncar em silêncio deixa de ser aceitável.
- [ ] A chamada respeita os limites de transporte do framework (`integrationFetch` / `withSyncTransport`), como as
      demais chamadas remotas do provider.
- [ ] Teste com resposta paginada mockada (duas páginas) provando que os repositórios da segunda página aparecem.

## Seams TDD

- `integrations/github/server/repos.ts` — teste red com duas páginas mockadas.

## Notas

- Bug latente encontrado durante a validação de R-0001, independente de multi-destino: já afeta contas grandes hoje.
- Fica mais grave com multi-destino, porque o repositório que a pessoa quer adicionar pode estar fora das 100
  primeiras.
- Não bloqueia nem é bloqueado por nenhum outro ticket; pode ser entregue isolado a qualquer momento.

## Adendo 2026-09-22 — R-0002 (R5)

A pesquisa fecha a forma da correção e **exclui** uma tentação:

- **Não mexer em `affiliation`, `visibility` ou `type`.** Os defaults documentados já entregam o conjunto máximo
  (`visibility=all`, `affiliation=owner,collaborator,organization_member`, `type=all`), e `type` usado junto com
  qualquer um dos outros dois é **422 garantido**. Passar esses parâmetros seria regressão, não melhoria.
- **A correção é seguir o header `link` com `rel="next"`** até ele não existir mais, sem construir URLs à mão.
  Não há header de contagem total: a ausência de `rel="next"` é o único sinal de fim.
- `per_page` acima de 100 **não dá erro** — o GitHub reduz em silêncio para 100. Ou seja, o bug atual não tem
  nenhuma manifestação observável do lado do cliente.

Critérios de aceite revisados:

- [ ] A travessia segue `link` `rel="next"`, não incrementa `page` manualmente.
- [ ] O seam de teste usa duas páginas: `link` com `rel="next"` na primeira, ausente na segunda.
- [ ] `findGitHubWebhookByUrl` (`integrations/github/server/webhook-registration.ts:91`) recebe o mesmo
      tratamento — tem o defeito idêntico e afeta a recuperação de webhook duplicado em T-005.

## Execução 2026-09-23 — implementado

Ciclo TDD real: teste vermelho antes da implementação, vermelho comprovado por execução, depois verde.

**Arquivos:**

- `apps/web/src/integrations/github/server/__tests__/pagination.test.ts` (novo) — 9 testes
- `apps/web/src/integrations/github/server/pagination.ts` (novo) — `nextPageUrl`, parser do header `link`
- `apps/web/src/integrations/github/server/repos.ts` — travessia paginada
- `apps/web/src/integrations/github/server/webhook-registration.ts` — só `findGitHubWebhookByUrl`

**Vermelho → verde:** `Tests 6 failed | 3 passed (9)` antes; `Tests 9 passed (9)` depois. Os 3 que já passavam
são guardas de parada (header `link` sem `rel="next"`, e sem header algum); existem para ficar vermelhos se a
implementação tratar "header existe" como "tem mais" e entrar em loop.

**Decisões tomadas na implementação:**

- Teto de 20 páginas (2000 itens) em ambas as funções, **lançando erro** ao estourar. O critério de aceite 2
  exigia comportamento definido e não-silencioso; em `findGitHubWebhookByUrl` um `null` falso é justamente o que
  faz o chamador registrar webhook duplicado. Não há teste para o teto — cobri-lo exigiria fixar em spec o
  número e a forma do erro, o que o adendo R5 não fez.
- `fetch` → `integrationFetch` nas duas funções (critério de aceite 3). Verificado seguro fora de escopo
  `withSyncTransport`: sem store, é só um `fetch` com timeout de 20s, e `GET` não registra evidência de entrega.
- O parser do `link` foi extraído para `pagination.ts` em vez de duplicado. `folder-conformance.test.ts` segue
  verde — ele exige pasta registrada, `server/` como entrypoint e não-importação entre providers; um módulo
  interno a mais não viola nada.
- `affiliation`, `visibility` e `type` **não** foram tocados, conforme R5.

**Verificação executada** (com o vitest/tsc/oxlint fixados no repositório, via `node` — ver caveat):

| Checagem                                                                  | Resultado                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pagination.test.ts` + pasta `integrations/github` + `folder-conformance` | 16 passed                                                        |
| `oxlint apps/web/src/integrations/github`                                 | limpo                                                            |
| `tsc --noEmit -p apps/web/tsconfig.json`                                  | 821 erros, **todos pré-existentes**, zero nos arquivos alterados |

### Caveat de gate — a verificação acima não é o gate

`bun` **não está instalado nesta máquina**, então `doctor.ps1` retorna `MISSING_CAPABILITY` para lint, typecheck,
build e unit nos três repositórios de produto. As checagens acima usaram os mesmos binários fixados no
`node_modules`, mas **pelo `node`, não pelo comando canônico**. Isso é evidência de que o código está correto;
**não** é `PASS` de gate, e não deve ser registrado como tal.

Os 821 erros de typecheck têm causa única identificada: `apps/web/src/routeTree.gen.ts` não existe neste working
tree — o TanStack Router só o gera em dev/build. O gate de typecheck não tem como passar antes de alguém gerar a
route tree.
