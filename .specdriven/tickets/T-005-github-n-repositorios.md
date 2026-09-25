---
id: T-005
title: GitHub com N repositórios, de ponta a ponta
status: in-progress
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

- **O limite do GitHub não é risco.** São 20 webhooks _por tipo de evento, por repositório_, e cada destino é um
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

Risco em aberto, registrado como incerteza em R-0002 e não resolvido: a nota _"OAuth apps cannot list, view, or
edit webhooks that they did not create"_ está documentada verbatim para webhooks de **organização**, e não foi
encontrada na página de webhooks de **repositório**. Se valer também para repositórios, nenhum dos dois caminhos
acima recupera de um hook criado por uma pessoa na UI do GitHub com a mesma URL — e o comportamento correto passa a
ser falhar com mensagem acionável para o admin, não silenciar.

## Adendo 2026-09-25 — duas exigências vindas da correção de regressão do T-001

Ver "Correção 2026-09-25" no T-001. Este ticket substitui a tela de seleção única, então herda:

- [ ] **A tela nova não escreve `config.channelId`.** Enquanto for escrito, `syncLegacyDestination` o espelha na
      linha — e qualquer mudança nele altera o hash de `canDispatchSync` e cancela **todas** as operações em voo da
      instalação. Gestão de destinos passa só pela tabela. É o que realiza plenamente o objetivo do T-004.
- [ ] **Remover o último destino não o ressuscita.** Sem linha, o leitor cai no fallback de `config.channelId`. Se
      ele ainda apontar para o destino removido, as entregas continuam. O caminho de remoção limpa o
      `config.channelId` na mesma transação, ou o leitor para de cair no fallback para instalações já migradas.
      Teste obrigatório: remover o último destino e provar que nenhuma entrega é despachada para ele.
- [ ] A recusa `DESTINATIONS_MANAGED_ELSEWHERE` de `syncLegacyDestination` continua valendo para qualquer escrita
      legada que sobreviva — ela é o que impede a tela antiga de corromper uma instalação com N destinos.

## Adendo 2026-09-25 — decisões de INTAKE que destravam este ticket

**D-8 — Inbox do GitHub: todos os repositórios alimentam o inbox.** (decisão do usuário)
O canal de inbox (`channel_accounts`, role `connection`) usa o mesmo webhook do repositório, com o evento
`issue_comment` somado a `issues` quando o inbox está ativo (`githubWebhookEvents(inboxEnabled)`). Com N destinos,
cada webhook registrado por destino recebe o mesmo conjunto de eventos — não há seleção separada de repositórios
para o inbox.

- [ ] Registrar um destino com o inbox ativo inclui `issue_comment`; ativar ou desativar o inbox atualiza os
      eventos dos webhooks de **todos** os destinos, não só de um.

**D-9 — Formato da tela: tabela de destinos própria.** (delegada pelo usuário, decidida pelo orchestrator)
Uma linha por repositório, com filtro de board por linha e ação de remover; "adicionar" abre um diálogo que usa o
`DestinationPicker` existente. Formato parecido com o roteador de notificações do Slack, **componente novo** — o
ADR-0001 e `shared/notification-channel-router.tsx:1-9` proíbem reaproveitar aquele.

Motivo: o roteamento automático da SPEC-0001 é por board, e isso exige filtro de board **por destino** (board
"Bugs" → `acme/api`, board "Infra" → `acme/ops`). Uma lista simples não tem onde expressar isso.

## Execução 2026-09-25 — fatias 1 e 2 de 5

O ticket foi fatiado em: **(1)** gestão de destinos no servidor, **(2)** segurança de envio e prova de ponta a
ponta, **(3)** webhooks por destino, **(4)** `parseRef`, **(5)** a tela. Feitas: 1 e 2.

### Três peças que o plano original não tinha

1. **Transição do legado para o gerenciado.** Uma instalação conectada depois da `0287` tem só `config.channelId`
   e nenhuma linha. Assim que existe uma linha, o leitor para de cair no fallback — então adicionar um segundo
   repositório sem materializar o primeiro faria **o original parar de receber issues em silêncio**.
   `addInstallationDestination` materializa o destino legado antes.
2. **O mapping legado.** O gravado pela tela antiga não tem `actionConfig.channelId`, e o resolver o lê como
   "`config.channelId`". Ao gerenciar, ele vira mapping explícito do destino primário, **preservando seu filtro de
   board e seu interruptor** (um mapping legado desligado continua desligado).
3. **O espelho do primário.** Leitores fora de `sync/` ainda usam `config.channelId` (ticket → issue até o T-007,
   o inbox). Ele passa a espelhar o **primeiro** destino e só é gravado quando o primário muda — cada escrita no
   config cancela operações em voo via `canDispatchSync`, então limitar a escrita limita o cancelamento. Remover o
   último destino **apaga** a chave, e o fallback do leitor não tem o que ressuscitar.

Isso **refina** a exigência deste ticket de "não escrever `config.channelId`": continua não escrito na gestão
comum, e é escrito só na troca de primário.

### Fatia 1 — `destinations.ts`

`addInstallationDestination`, `removeInstallationDestination`, `setInstallationDestinationBoards`. Cada uma numa
transação com advisory lock por instalação (duas primeiras adições concorrentes materializariam o legado duas
vezes). Linhas inseridas com `clock_timestamp()`, não `now()`: dentro de uma transação `now()` é o mesmo instante, e
o primário é definido pela ordem de criação.

- **Flag de capability `multipleDestinations`**, declarada **só no GitHub**. O Jira fica de fora até o T-006: sem o
  webhook único com `project IN (...)` e o `destinationId` no inbound, um segundo projeto teria saída funcionando e
  status sync morto em silêncio.
- **Validação de referência.** `external_ref` é interpolado em caminhos de API (`repos/${ref}/issues`). A regex de
  rótulo seguro já existente aceita `../../orgs/acme`; segmentos `..` e `.` agora são recusados.

`__tests__/destination-management.db.test.ts`: 12 casos, vermelhos antes. Três controles positivos — sem
materializar o legado, sem apagar o espelho, sem recusar `..` — isolaram **exatamente** os testes de cada
propriedade.

### Fatia 2 — segurança de envio e ponta a ponta

`sync/__tests__/multi-destination.db.test.ts`, pelo resolver, worker e hook reais:

| Critério                                                                                  | Estado                                                                           |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Board roteado a dois repositórios cria uma issue e um link em cada, com escopos distintos | ✅ passou **sem mudança de código** — o resolver já entendia mappings explícitos |
| `#142` fechado num repositório atinge só o post daquele repositório                       | ✅ passou sem mudança — o inbound do GitHub já filtra pelo destino assinado      |
| Remover um repositório durante o envio cancela a entrega a ele                            | ❌ → ✅ **corrigido**                                                            |

O terceiro confirmou a lacuna prevista: o recheck do T-004 cobria só entregas pelo destino-padrão, e destinos
gerenciados roteiam por mapping **explícito** — nenhuma entrega era rechecada. Agora, para providers com
`multipleDestinations`, toda entrega é rechecada. Controle positivo: sem a extensão, exatamente esse teste fica
vermelho. Slack/Discord seguem fora do recheck (sem a flag), e o `provider-contracts` continua verde.

### Verificação

Suítes de `integrations` + `jobs` + providers + `events`: verdes, exceto o HubSpot (pré-existente). `tsc` = 821.

**Achado:** `sync/__tests__/ledger.test.ts` ("recovers expired ownership according to dispatch evidence") já falhou
em duas rodadas diferentes, uma em cada variante (`: false` e `: true`). Passa 3 de 3 isolado e não importa nada do
que foi tocado. É um teste de lease sensível a tempo sob carga paralela — pré-existente, e vale um ticket próprio.

### Falta

Fatia 3 (webhooks por destino: registrar ao adicionar, remover ao remover, status sync e inbox iterando os
destinos, compensação, caminho de duplicata), fatia 4 (`parseRef`) e fatia 5 (a tela). As server functions que a
tela vai chamar entram com a fatia 5.
