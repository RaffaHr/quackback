---
id: T-003
title: Resolução reversa destinationKey → destino, para inspect e revisão de link
status: done
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

## Fechamento 2026-09-25

### Menor do que o ticket previa — o T-001 já tinha dado a primitiva

Este ticket foi escrito quando o `destinationKey` era "um hash SHA-256 unidirecional, sem caminho de volta" (item I6
de R-0001, "a mudança estrutural mais séria"). O planner corrigiu o remédio — resolução reversa é **enumerar os
destinos e recomputar para frente**, não inverter hash — e o T-001 entregou exatamente essa primitiva
(`findInstallationDestination`). Três dos cinco critérios já estavam cumpridos quando este ticket começou:

- resolução `(instalação, chave) → destino` sobre a tabela — `findInstallationDestination` (T-001);
- `inspectSyncRemote` montar o `auth` com o destino do link — T-001 fez para operações sem alvo gravado;
- `githubIssues.inspect` receber o `owner/repo` do link — segue do anterior, via `auth.channelId`.

### O que este ticket fez: `reviewDestination`

Ela comparava o link com **o único** destino que `config.channelId` nomeava, então todo link em qualquer outro
destino voltava como "não verificado" — e depois era inspecionado com as credenciais do repositório errado, ou não
era. Agora recebe a lista de destinos da instalação e procura entre **todos**.

- **Continua pura.** O chamador fornece os destinos já com chave, então o seam principal virou teste unitário sem
  banco (`sync/__tests__/review-destination.test.ts`, 4 testes).
- **Degradar continua permitido; adivinhar, não.** Link cuja chave não bate com nenhum destino — removido, ou
  conexão movida de org — ainda devolve o envelope `{ unverifiedLink, previousScope }`.
- **Chave igual não basta.** Um link de uma conexão _anterior_ da mesma instalação (reconexão muda o `connectedAt`,
  logo a identidade da instalação) não é verificado mesmo com a mesma chave de destino.

**E fecha a última leitura de `config.channelId` em `sync/`**, que o T-001 havia deixado pendente aqui. Conferido:
zero ocorrências fora de comentário.

### Uma decisão de desenho que vale registrar

O leitor passou a consultar com **SQL cru via `execute`**, não pelo query builder. Motivo: `sync/status.ts` chama
isto dentro de uma transação cujo executor é um `JobSqlExecutor` — que **só tem `execute`**. O próprio tipo documenta
a convenção: _"Narrow enough for `db` and a drizzle transaction"_. Seguindo-a, o leitor serve `db`, transação drizzle
e o executor de job. A alternativa — o `status.ts` resolver destinos por conta própria — criaria uma segunda
implementação da chave, o que todo este desenho existe para evitar.

Os três chamadores leem pela transação que já seguram quando seguram uma: `post.cascade-delete.ts` (transação da
exclusão do post) e `sync/status.ts` (executor do job). `post-sync.ts` não está em transação.

### Um teste que precisou ser ajustado, e por quê

`post-sync.test.ts` falhou com a mudança. **Não era bug de produção.** O teste é unitário e mocka o `db`; o mock não
tinha `execute`, e o fixture usava `'linear'` como **id** de integração — que não é TypeID válida, então `toUuid`
lança. Em produção ids vêm do banco e são sempre válidos, e eu não vou blindar o código de produção contra id
malformado só para agradar um fixture: isso mascararia bugs reais.

Correção no teste: `execute` responde lista vazia (modela instalação sem linha → fallback de `config.channelId`,
**exatamente** o que o código antigo comparava), e o id virou uma TypeID válida gerada pela própria `typeid-js`.
Onde `'linear'` significa **tipo** (`integrationType`, `getIntegration('linear')`), ficou intocado. **Nenhuma
expectativa do teste mudou.**

### Verificação

|                                              |                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `review-destination.test.ts`                 | 4/4 (vermelho antes: o link em destino não-padrão voltava como envelope) |
| Suites de `integrations` + `posts` + ligação | verdes, exceto HubSpot (pré-existente)                                   |
| `tsc` web                                    | 821 = baseline, zero nos arquivos tocados                                |
| oxlint                                       | limpo nos arquivos tocados                                               |

### Sobre as falhas "novas" na suíte ampla

Três rodadas completas mostraram falhas fora do baseline — **e um conjunto diferente a cada rodada**:
`regressions.db.test.ts` (reagendamento), depois `onboarding-bootstrap-claim` (promoção do primeiro usuário), depois
`config-file/watcher`. Nenhuma recorreu. Todas passam **3 de 3 isoladas**, e as duas últimas estão em código que este
trabalho não tocou. É contenção da suíte paralela contra um único banco — o `onboarding` literalmente depende de
"nenhum usuário reivindicou o workspace", que outro teste paralelo pode ter violado. Nenhuma falha consistente é
atribuível a estas mudanças.
