---
id: T-009
title: Paginar a listagem de repositórios do GitHub
status: open
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
