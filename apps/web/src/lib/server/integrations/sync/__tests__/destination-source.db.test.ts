/**
 * T-001 tracer bullet, end to end: a connected GitHub installation keeps working
 * exactly as before, but its destination now comes from an
 * `integration_destinations` row instead of `config.channelId`.
 *
 * The rows here are written by the real `0287` backfill statement, read from
 * the migration file and executed against the seeded installation, so the
 * "migrated" state is the one production gets and not a hand-copied imitation.
 *
 * Each flow that consults the destination reader has two kinds of case:
 *
 * - **Green**: the row mirrors `config.channelId`, as the migration leaves it,
 *   and the flow completes exactly as it did before the table existed.
 * - **Positive control**: the row's `external_ref` is moved away from
 *   `config.channelId`, which stays untouched. If the table is the source, the
 *   flow now behaves differently — it cancels, or it creates in the row's
 *   repository. If it behaved the same, the table was not being read. These are
 *   the cases that prove the tracer bullet; the green cases alone would pass
 *   just as well against the `config.channelId` fallback.
 *
 * Only flows that really go through the reader are covered. GitHub's signed
 * inbound path uses `result.destinationId` and never asks the reader, so a
 * "webhook closes issue" test would pass with or without the switch and prove
 * nothing here.
 *
 * Kept apart from `provider-contracts.db.test.ts` on purpose: T-001 requires
 * that suite to pass with its expectations unchanged, and its installations
 * carry no destination row — they are the compatibility-fallback witness. This
 * file is the migrated-row witness.
 */
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createId, type PrincipalId, type TicketId, type UserId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))
vi.mock('@/lib/server/secret-key', () => ({
  activeSecretKey: () => 'integration-sync-review-key-32-characters-only',
}))
// createTicket emits ticket.created through a fire-and-forget bridge and a
// realtime publish; neither is under test here.
vi.mock('@/lib/server/domains/tickets/ticket.webhooks', () => ({
  emitTicketCreated: vi.fn().mockResolvedValue(undefined),
  emitTicketStatusChanged: vi.fn().mockResolvedValue(undefined),
  emitTicketAssigned: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/server/realtime/conversation-channels', () => ({ publishTicketEvent: vi.fn() }))
import {
  sql,
  eq,
  user,
  principal,
  boards,
  posts,
  settings,
  ticketStatuses,
  integrations,
  integrationDestinations,
  integrationEventMappings,
  postExternalLinks,
  ticketExternalLinks,
  integrationSyncOperations as operations,
} from '@/lib/server/db'
import { encryptSecrets } from '@/lib/server/integrations/encryption'
import { getIntegration } from '@/lib/server/integrations/index'
import { listInstallationDestinations } from '@/lib/server/integrations/destinations'
import {
  installationIdentity,
  syncDestination,
  syncHash,
  syncOperationKey,
} from '@/lib/server/integrations/sync/identity'
import { queueHookSync } from '@/lib/server/integrations/sync/hooks'
import { queueInboundStatus } from '@/lib/server/integrations/sync/inbound'
import { queueSyncOperation } from '@/lib/server/integrations/sync/ledger'
import { runIntegrationSync } from '@/lib/server/integrations/sync/worker'
import { syncTestJob } from '@/lib/server/integrations/sync/__tests__/job'
import { buildIntegrationTargets } from '@/lib/server/events/resolvers/integration.resolver'
import { createTicket } from '@/lib/server/domains/tickets/ticket.service'
import { createIssueForTicket } from '@/lib/server/domains/tickets/ticket-external-links.service'
import { resolveActorPermissions } from '@/lib/server/policy/permissions'
import type { Actor } from '@/lib/server/policy/types'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db
      .select({ id: integrationDestinations.id, ref: integrationDestinations.externalRef })
      .from(integrationDestinations)
      .limit(0)
  },
})

/** The data-writing statements of 0287, verbatim: the backfill and the webhook-id copy. */
const MIGRATION_BACKFILL = readFileSync(
  join(__dirname, '../../../../../../../../packages/db/drizzle/0287_integration_destinations.sql'),
  'utf8'
)
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim())
  .filter((statement) =>
    /^(--.*\n)*\s*(INSERT INTO|UPDATE) "integration_destinations"/m.test(statement)
  )

const CONFIGURED = 'acme/api'
const ELSEWHERE = 'acme/elsewhere'
const suffix = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!fixture.available)('T-001: sync reads the migrated destination row', () => {
  beforeEach(async () => {
    await fixture.begin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 599 }))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fixture.rollback()
  })
  afterAll(fixture.close)

  it('reads the two data statements out of the real 0287 migration', () => {
    expect(MIGRATION_BACKFILL).toHaveLength(2)
    expect(MIGRATION_BACKFILL[0]).toContain('INSERT INTO "integration_destinations"')
    expect(MIGRATION_BACKFILL[1]).toContain('UPDATE "integration_destinations"')
  })

  /** Run 0287's backfill as production would, after the installation already exists. */
  async function migrate() {
    for (const statement of MIGRATION_BACKFILL) await testDb.execute(sql.raw(statement))
  }

  /** Point the migrated row somewhere else, leaving config.channelId exactly as it was. */
  async function moveRow(integrationId: string, externalRef: string) {
    const moved = await testDb
      .update(integrationDestinations)
      .set({ externalRef })
      .where(eq(integrationDestinations.integrationId, integrationId as never))
      .returning()
    expect(moved).toHaveLength(1)
  }

  async function seedAdmin() {
    const [person] = await testDb
      .insert(user)
      .values({
        id: createId('user') as UserId,
        name: 'Admin',
        email: `${randomUUID()}@example.test`,
      })
      .returning()
    const [actor] = await testDb
      .insert(principal)
      .values({
        id: createId('principal') as PrincipalId,
        userId: person.id,
        type: 'user',
        role: 'admin',
        displayName: 'Admin',
        createdAt: new Date(),
      })
      .returning()
    return { person, actor }
  }

  /** A GitHub installation connected before T-001, with the mapping updateIntegrationFn writes. */
  async function seedGitHub() {
    const { person, actor } = await seedAdmin()
    const [integration] = await testDb
      .insert(integrations)
      .values({
        integrationType: 'github',
        status: 'active',
        secrets: encryptSecrets({ accessToken: 'gh-token' }),
        principalId: actor.id,
        config: {
          channelId: CONFIGURED,
          organizationName: 'acme',
          externalWebhookId: '99',
          statusSyncEnabled: true,
        },
      })
      .returning()
    // updateIntegrationFn writes no actionConfig: the mapping means "this
    // installation's destination", which is what sends it to the reader.
    await testDb.insert(integrationEventMappings).values({
      integrationId: integration.id,
      eventType: 'post.created',
      actionType: 'send_message',
      enabled: true,
    })
    await migrate()
    return { person, actor, integration }
  }

  async function seedPostEvent(
    actor: { id: string },
    person: { id: string; email: string | null }
  ) {
    const [board] = await testDb
      .insert(boards)
      .values({ name: 'Board', slug: randomUUID() })
      .returning()
    const [post] = await testDb
      .insert(posts)
      .values({
        boardId: board.id,
        principalId: actor.id as PrincipalId,
        title: 'Export breaks',
        content: 'Body',
      })
      .returning()
    const event = {
      id: createId('event'),
      type: 'post.created' as const,
      timestamp: new Date().toISOString(),
      actor: {
        type: 'user' as const,
        principalId: actor.id,
        userId: person.id,
        email: person.email!,
      },
      data: {
        post: {
          id: post.id,
          boardId: board.id,
          boardSlug: board.slug,
          title: post.title,
          content: post.content,
          voteCount: 0,
          authorEmail: person.email!,
        },
      },
    }
    return { board, post, event }
  }

  /** The hook target the real integration resolver emits for this installation's mappings. */
  async function resolverTargets(integrationId: string, boardId: string) {
    const rows = await testDb
      .select({
        eventType: integrationEventMappings.eventType,
        integrationType: integrations.integrationType,
        integrationId: integrations.id,
        integrationConfig: integrations.config,
        actionConfig: integrationEventMappings.actionConfig,
        filters: integrationEventMappings.filters,
      })
      .from(integrationEventMappings)
      .innerJoin(integrations, eq(integrationEventMappings.integrationId, integrations.id))
      .where(eq(integrations.id, integrationId as never))
    return buildIntegrationTargets(rows, 'post.created', [boardId])
  }

  function githubIssueCreated(number: number, repo: string) {
    return Response.json(
      { number, html_url: `https://github.com/${repo}/issues/${number}` },
      { status: 201 }
    )
  }

  /** Every issue-creating POST that reached GitHub, by URL. */
  function createdAt() {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === 'POST')
      .map(([input]) => String(input))
  }

  async function operation(id: string) {
    return (await testDb.query.integrationSyncOperations.findFirst({
      where: eq(operations.id, id),
    }))!
  }

  describe('path 1 — outbound hook through a legacy mapping (hooks.ts, defaultInstallationDestination)', () => {
    it('green: the migrated row mirrors config, and the issue is created and linked as before', async () => {
      const { person, actor, integration } = await seedGitHub()
      const [row] = await listInstallationDestinations(integration)
      // Not the fallback: the destination the reader returns is the migrated row.
      expect(row).toMatchObject({ externalRef: CONFIGURED, id: expect.any(String) })
      const { board, post, event } = await seedPostEvent(actor, person)
      const [target] = await resolverTargets(integration.id, board.id)
      expect(target.target).toEqual({ channelId: CONFIGURED })
      vi.mocked(fetch).mockResolvedValue(githubIssueCreated(11, CONFIGURED))

      const op = (await queueHookSync({ hookType: 'github', event, ...target }))!
      await runIntegrationSync(syncTestJob(op.id))

      expect(createdAt()).toEqual([`https://api.github.com/repos/${CONFIGURED}/issues`])
      const stored = await operation(op.id)
      expect(stored).toMatchObject({ state: 'succeeded', result: { externalId: '11' } })
      const links = await testDb.query.postExternalLinks.findMany({
        where: eq(postExternalLinks.postId, post.id),
      })
      expect(links).toHaveLength(1)
      // The link is scoped under the key the migrated row reports, which is
      // the key config.channelId always produced.
      expect(links[0].syncScope).toBe(`${stored.installation}:${row.destinationKey}`)
    })

    it('positive control: with the row moved away from config, the same delivery is refused', async () => {
      const { person, actor, integration } = await seedGitHub()
      await moveRow(integration.id, ELSEWHERE)
      const { board, post, event } = await seedPostEvent(actor, person)
      // config.channelId is untouched, so the resolver still aims at it...
      const [target] = await resolverTargets(integration.id, board.id)
      expect(target.target).toEqual({ channelId: CONFIGURED })
      vi.mocked(fetch).mockResolvedValue(githubIssueCreated(12, CONFIGURED))

      const op = (await queueHookSync({ hookType: 'github', event, ...target }))!
      await runIntegrationSync(syncTestJob(op.id))

      // ...but the executor asks the table, which no longer names that repo.
      // Were config.channelId still the source, this would have been created.
      expect(createdAt()).toEqual([])
      expect(await operation(op.id)).toMatchObject({
        state: 'cancelled',
        errorCode: 'installation_changed',
        dispatchedAt: null,
      })
      expect(
        await testDb.query.postExternalLinks.findMany({
          where: eq(postExternalLinks.postId, post.id),
        })
      ).toHaveLength(0)
    })

    it('positive control: a delivery aimed at the row repo is accepted although config names another', async () => {
      const { person, actor, integration } = await seedGitHub()
      await moveRow(integration.id, ELSEWHERE)
      const { event } = await seedPostEvent(actor, person)
      vi.mocked(fetch).mockResolvedValue(githubIssueCreated(13, ELSEWHERE))

      const op = (await queueHookSync({
        hookType: 'github',
        event,
        target: { channelId: ELSEWHERE },
        config: { integrationId: integration.id },
      }))!
      await runIntegrationSync(syncTestJob(op.id))

      expect(createdAt()).toEqual([`https://api.github.com/repos/${ELSEWHERE}/issues`])
      expect(await operation(op.id)).toMatchObject({ state: 'succeeded' })
    })

    it('an edit to the default row DURING dispatch cancels the delivery', async () => {
      // Unlike the control above, the row moves after the mapping check has
      // already read the default destination — during the credential read. The
      // config recheck cannot see it (moveRow leaves config untouched), so only
      // the destination recheck before markSyncDispatched stands between this
      // delivery and the repository the admin just moved away from.
      const { person, actor, integration } = await seedGitHub()
      const { board, post, event } = await seedPostEvent(actor, person)
      const [target] = await resolverTargets(integration.id, board.id)
      vi.mocked(fetch).mockResolvedValue(githubIssueCreated(13, CONFIGURED))
      const op = (await queueHookSync({ hookType: 'github', event, ...target }))!
      const auth = await import('@/lib/server/integrations/token-refresh')
      const original = auth.getIntegrationAuth
      vi.spyOn(auth, 'getIntegrationAuth').mockImplementationOnce(async (id, rejected) => {
        await moveRow(integration.id, ELSEWHERE)
        return original(id, rejected)
      })

      await runIntegrationSync(syncTestJob(op.id))

      expect(createdAt()).toEqual([])
      expect(await operation(op.id)).toMatchObject({
        state: 'cancelled',
        errorCode: 'installation_changed',
        dispatchedAt: null,
      })
      expect(
        await testDb.query.postExternalLinks.findMany({
          where: eq(postExternalLinks.postId, post.id),
        })
      ).toHaveLength(0)
    })
  })

  describe('path 2 — ticket to issue (tickets.ts, findInstallationDestination)', () => {
    async function seedTicket(actor: Actor): Promise<TicketId> {
      await testDb
        .insert(settings)
        .values({ name: 'WS', slug: `ws_${suffix()}`, createdAt: new Date() })
      await testDb
        .update(ticketStatuses)
        .set({ isDefault: false })
        .where(eq(ticketStatuses.isDefault, true))
      await testDb.insert(ticketStatuses).values({
        name: 'Open',
        slug: `open_${suffix()}`,
        category: 'open',
        position: 100,
        isDefault: true,
        publicStage: 'received',
      })
      return (await createTicket({ type: 'customer', title: `ticket ${suffix()}` }, actor)).id
    }

    async function seedTicketCase() {
      const { actor: row, integration } = await seedGitHub()
      const actor: Actor = {
        principalId: row.id as PrincipalId,
        role: 'admin',
        principalType: 'user',
        segmentIds: new Set(),
        permissions: resolveActorPermissions('admin'),
      }
      return { actor, integration, ticketId: await seedTicket(actor) }
    }

    it('green: the migrated row mirrors config, and the issue is created where it always was', async () => {
      const { actor, integration, ticketId } = await seedTicketCase()
      const [row] = await listInstallationDestinations(integration)
      expect(row).toMatchObject({ externalRef: CONFIGURED, id: expect.any(String) })
      vi.mocked(fetch).mockResolvedValue(githubIssueCreated(21, CONFIGURED))

      const queued = await createIssueForTicket(ticketId, 'github', actor)
      await runIntegrationSync(syncTestJob(queued.operationId))

      expect(createdAt()).toEqual([`https://api.github.com/repos/${CONFIGURED}/issues`])
      const stored = await operation(queued.operationId)
      expect(stored).toMatchObject({ state: 'succeeded' })
      // The producer still keys the operation from config.channelId; the row
      // must report that very key or this ticket's link would be orphaned.
      expect(stored.destinationKey).toBe(row.destinationKey)
      const [link] = await testDb.query.ticketExternalLinks.findMany({
        where: eq(ticketExternalLinks.ticketId, ticketId),
      })
      expect(link).toMatchObject({
        externalId: '21',
        externalDisplayId: `${CONFIGURED}#21`,
        syncScope: `${stored.installation}:${row.destinationKey}`,
      })
    })

    it('positive control: with the row moved away from config, the key no longer resolves and nothing is created', async () => {
      const { actor, integration, ticketId } = await seedTicketCase()
      await moveRow(integration.id, ELSEWHERE)
      vi.mocked(fetch).mockResolvedValue(githubIssueCreated(22, CONFIGURED))

      // Queued under the config-derived key, exactly as the producer does today.
      const queued = await createIssueForTicket(ticketId, 'github', actor)
      await runIntegrationSync(syncTestJob(queued.operationId))

      expect(createdAt()).toEqual([])
      expect(await operation(queued.operationId)).toMatchObject({
        state: 'cancelled',
        errorCode: 'installation_changed',
        dispatchedAt: null,
      })
      expect(
        await testDb.query.ticketExternalLinks.findMany({
          where: eq(ticketExternalLinks.ticketId, ticketId),
        })
      ).toHaveLength(0)
    })

    it('positive control: an operation keyed to the row creates the issue in the row repo, not in config.channelId', async () => {
      const { actor, integration, ticketId } = await seedTicketCase()
      await moveRow(integration.id, ELSEWHERE)
      vi.mocked(fetch).mockResolvedValue(githubIssueCreated(23, ELSEWHERE))
      // No producer can name a non-default destination yet (that arrives with
      // T-005/T-011), so this builds the operation exactly as
      // createIssueForTicket does, only for the row's repository instead of
      // config.channelId.
      const config = (integration.config ?? {}) as Record<string, unknown>
      const installation = installationIdentity(integration)
      const destination = syncDestination(
        { channelId: ELSEWHERE },
        config,
        getIntegration('github')
      )
      const queued = (await queueSyncOperation({
        operationKey: syncOperationKey({
          installation,
          destination,
          sourceType: 'ticket',
          sourceId: ticketId,
          kind: 'create',
        }),
        integrationId: integration.id,
        installation,
        provider: 'github',
        direction: 'outbound',
        kind: 'create',
        sourceType: 'ticket',
        sourceId: ticketId,
        requestedBy: actor.principalId!,
        destination,
        payload: { executor: 'ticket-create', data: {} },
      }))!

      await runIntegrationSync(syncTestJob(queued.id))

      // The resolved row is the creation target, not a mere key check beside
      // a separate read of config.channelId.
      expect(createdAt()).toEqual([`https://api.github.com/repos/${ELSEWHERE}/issues`])
      const stored = await operation(queued.id)
      expect(stored).toMatchObject({ state: 'succeeded' })
      const [link] = await testDb.query.ticketExternalLinks.findMany({
        where: eq(ticketExternalLinks.ticketId, ticketId),
      })
      expect(link).toMatchObject({ externalId: '23', externalDisplayId: `${ELSEWHERE}#23` })
    })
  })

  describe('path 3 — inbound status without a signed destination (inbound.ts, defaultInstallationDestination)', () => {
    /** A Jira installation (statusMode 'review', no destinationId) with a link written before T-001. */
    async function seedJiraLinked() {
      const { person, actor } = await seedAdmin()
      const channelId = '10001:10004'
      const config = {
        channelId,
        cloudId: 'cloud-1',
        siteUrl: 'https://acme.atlassian.net',
        statusSyncEnabled: true,
      }
      const [integration] = await testDb
        .insert(integrations)
        .values({
          integrationType: 'jira',
          status: 'active',
          secrets: encryptSecrets({ accessToken: 'jira-token' }),
          principalId: actor.id,
          config,
        })
        .returning()
      await migrate()
      const { post } = await seedPostEvent(actor, person)
      // The link's scope is computed the pre-T-001 way, from config.channelId:
      // this is an existing production link, not one written by new code.
      const legacyKey = syncHash(syncDestination({ channelId }, config, getIntegration('jira')))
      await testDb.insert(postExternalLinks).values({
        postId: post.id,
        integrationId: integration.id,
        integrationType: 'jira',
        externalId: 'PROJ-7',
        externalUrl: 'https://acme.atlassian.net/browse/PROJ-7',
        syncScope: `${installationIdentity(integration)}:${legacyKey}`,
      })
      return { integration, post }
    }

    async function receiveUnsigned(integration: typeof integrations.$inferSelect) {
      const receipt = (await queueInboundStatus(
        integration,
        { externalId: 'PROJ-7', externalStatus: 'Done', eventType: 'item.updated' },
        randomUUID()
      ))!
      await runIntegrationSync(syncTestJob(receipt.id))
      return (
        await testDb.query.integrationSyncOperations.findMany({
          where: eq(operations.integrationId, integration.id),
        })
      ).filter((row) => row.kind === 'status')
    }

    it('green: a pre-existing link is still found through the migrated row', async () => {
      const { integration, post } = await seedJiraLinked()
      const [row] = await listInstallationDestinations(integration)
      expect(row).toMatchObject({ externalRef: '10001:10004', id: expect.any(String) })

      const review = await receiveUnsigned(integration)

      expect(review).toHaveLength(1)
      expect(review[0]).toMatchObject({ sourceId: post.id, state: 'conflict', remoteId: 'PROJ-7' })
    })

    it('positive control: with the row moved away from config, the same event finds no link', async () => {
      const { integration } = await seedJiraLinked()
      await moveRow(integration.id, '10002:10004')

      expect(await receiveUnsigned(integration)).toHaveLength(0)
    })
  })
})
