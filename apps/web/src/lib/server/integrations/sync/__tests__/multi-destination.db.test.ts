/**
 * T-005, end to end: one GitHub installation, several repositories, managed
 * through `addInstallationDestination` and delivered through the real resolver,
 * worker and hook — only GitHub's HTTP is mocked.
 *
 * - A board routed to two repositories creates one issue in each, with two
 *   links under two different sync scopes.
 * - GitHub numbers issues per repository, so `#142` exists in both. Closing it
 *   in one repository must reach only the post linked there.
 * - Removing a repository while a delivery to it is between claim and dispatch
 *   must cancel that delivery. Managed destinations route through explicit
 *   mappings, which the T-004 recheck (default destination only) did not cover.
 */
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createId, type PrincipalId, type UserId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))
vi.mock('@/lib/server/secret-key', () => ({
  activeSecretKey: () => 'integration-sync-review-key-32-characters-only',
}))
vi.mock('@/lib/server/cache', () => ({
  cacheDel: vi.fn(),
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(),
  CACHE_KEYS: { INTEGRATION_MAPPINGS: 'integration-mappings' },
}))
import {
  eq,
  user,
  principal,
  boards,
  posts,
  integrations,
  integrationEventMappings,
  postExternalLinks,
  integrationSyncOperations as operations,
} from '@/lib/server/db'
import { encryptSecrets } from '@/lib/server/integrations/encryption'
import {
  addInstallationDestination,
  listInstallationDestinations,
  removeInstallationDestination,
} from '@/lib/server/integrations/destinations'
import { queueHookSync } from '@/lib/server/integrations/sync/hooks'
import { queueInboundStatus } from '@/lib/server/integrations/sync/inbound'
import { runIntegrationSync } from '@/lib/server/integrations/sync/worker'
import { syncTestJob } from '@/lib/server/integrations/sync/__tests__/job'
import { buildIntegrationTargets } from '@/lib/server/events/resolvers/integration.resolver'

const fixture = await createDbTestFixture()

type Installation = typeof integrations.$inferSelect

describe.skipIf(!fixture.available)('T-005: one GitHub installation, several repositories', () => {
  beforeEach(async () => {
    await fixture.begin()
    // GitHub numbers issues per repository: every repository answers #142.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const repo = /repos\/([^/]+\/[^/]+)\/issues$/.exec(url)?.[1]
      if (init?.method === 'POST' && repo)
        return Response.json(
          { number: 142, html_url: `https://github.com/${repo}/issues/142` },
          { status: 201 }
        )
      return new Response('', { status: 599 })
    })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fixture.rollback()
  })
  afterAll(fixture.close)

  async function seedGitHub() {
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
    const [integration] = await testDb
      .insert(integrations)
      .values({
        integrationType: 'github',
        status: 'active',
        secrets: encryptSecrets({ accessToken: 'gh-token' }),
        principalId: actor.id,
        config: { organizationName: 'acme', statusSyncEnabled: true },
        connectedAt: new Date('2026-01-15T12:00:00.000Z'),
      })
      .returning()
    return { person, actor, integration }
  }

  async function seedBoard(name: string) {
    const [board] = await testDb.insert(boards).values({ name, slug: randomUUID() }).returning()
    return board
  }

  async function seedPost(
    person: { id: string; email: string | null },
    actor: { id: string },
    board: typeof boards.$inferSelect
  ) {
    const [post] = await testDb
      .insert(posts)
      .values({
        boardId: board.id,
        principalId: actor.id as PrincipalId,
        title: `Feedback ${randomUUID()}`,
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
    return { post, event }
  }

  /** The targets the real resolver emits for this installation's mappings. */
  async function resolverTargets(integration: Installation, boardId: string) {
    const current = (await testDb.query.integrations.findFirst({
      where: eq(integrations.id, integration.id),
    }))!
    const mappings = await testDb.query.integrationEventMappings.findMany({
      where: eq(integrationEventMappings.integrationId, integration.id),
    })
    return buildIntegrationTargets(
      mappings
        .filter((m) => m.enabled)
        .map((m) => ({
          eventType: m.eventType,
          integrationType: current.integrationType,
          integrationId: current.id,
          integrationConfig: current.config,
          actionConfig: m.actionConfig,
          filters: m.filters,
        })),
      'post.created',
      [boardId]
    )
  }

  async function deliver(integration: Installation, boardId: string, event: unknown) {
    const ops = []
    for (const target of await resolverTargets(integration, boardId)) {
      const op = (await queueHookSync({ hookType: 'github', event, ...target } as never))!
      await runIntegrationSync(syncTestJob(op.id))
      ops.push(op)
    }
    return ops
  }

  function createdIn() {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === 'POST')
      .map(([input]) => String(input))
  }

  async function linksOf(postId: string) {
    return testDb.query.postExternalLinks.findMany({
      where: eq(postExternalLinks.postId, postId as never),
    })
  }

  it('a board routed to two repositories creates one issue and one link in each', async () => {
    const { person, actor, integration } = await seedGitHub()
    const board = await seedBoard('Everything')
    await addInstallationDestination(integration.id, { externalRef: 'acme/api' })
    await addInstallationDestination(integration.id, { externalRef: 'acme/web' })
    const { post, event } = await seedPost(person, actor, board)

    await deliver(integration, board.id, event)

    expect(createdIn().sort()).toEqual([
      'https://api.github.com/repos/acme/api/issues',
      'https://api.github.com/repos/acme/web/issues',
    ])
    const links = await linksOf(post.id)
    expect(links).toHaveLength(2)
    const destinations = await listInstallationDestinations(integration)
    // Same issue number, two scopes: each link belongs to its own repository.
    expect(new Set(links.map((l) => l.syncScope)).size).toBe(2)
    for (const link of links) {
      expect(link.externalId).toBe('142')
      expect(destinations.map((d) => link.syncScope.endsWith(`:${d.destinationKey}`))).toContain(
        true
      )
    }
  })

  it('closing #142 in one repository reaches only the post linked in that repository', async () => {
    const { person, actor, integration } = await seedGitHub()
    const bugs = await seedBoard('Bugs')
    const web = await seedBoard('Web')
    await addInstallationDestination(integration.id, {
      externalRef: 'acme/api',
      boardIds: [bugs.id],
    })
    await addInstallationDestination(integration.id, {
      externalRef: 'acme/web',
      boardIds: [web.id],
    })
    const inApi = await seedPost(person, actor, bugs)
    const inWeb = await seedPost(person, actor, web)
    await deliver(integration, bugs.id, inApi.event)
    await deliver(integration, web.id, inWeb.event)
    // Board routing: each post reached only its own repository.
    expect((await linksOf(inApi.post.id)).map((l) => l.externalDisplayId)).toEqual(['acme/api#142'])
    expect((await linksOf(inWeb.post.id)).map((l) => l.externalDisplayId)).toEqual(['acme/web#142'])

    const receipt = (await queueInboundStatus(
      integration,
      {
        destinationId: 'acme/web',
        externalId: '142',
        externalStatus: 'Closed',
        eventType: 'issues.closed',
        transition: 'closed',
        occurredAt: new Date().toISOString(),
      },
      randomUUID()
    ))!
    await runIntegrationSync(syncTestJob(receipt.id))

    const statusOps = (
      await testDb.query.integrationSyncOperations.findMany({
        where: eq(operations.integrationId, integration.id),
      })
    ).filter((op) => op.kind === 'status')
    expect(statusOps.map((op) => op.sourceId)).toEqual([inWeb.post.id])
  })

  it('removing a repository during dispatch cancels the delivery to it', async () => {
    const { person, actor, integration } = await seedGitHub()
    const board = await seedBoard('Everything')
    await addInstallationDestination(integration.id, { externalRef: 'acme/api' })
    const web = await addInstallationDestination(integration.id, { externalRef: 'acme/web' })
    const { post, event } = await seedPost(person, actor, board)
    const target = (await resolverTargets(integration, board.id)).find(
      (t) => (t.target as { channelId: string }).channelId === 'acme/web'
    )!
    const op = (await queueHookSync({ hookType: 'github', event, ...target } as never))!
    // After the mapping check, during the credential read. acme/web is not the
    // primary, so config does not change and canDispatchSync cannot see it.
    const auth = await import('@/lib/server/integrations/token-refresh')
    const original = auth.getIntegrationAuth
    vi.spyOn(auth, 'getIntegrationAuth').mockImplementationOnce(async (id, rejected) => {
      await removeInstallationDestination(integration.id, web.id!)
      return original(id, rejected)
    })

    await runIntegrationSync(syncTestJob(op.id))

    expect(createdIn()).toEqual([])
    expect(
      await testDb.query.integrationSyncOperations.findFirst({ where: eq(operations.id, op.id) })
    ).toMatchObject({ state: 'cancelled', errorCode: 'installation_changed', dispatchedAt: null })
    expect(await linksOf(post.id)).toHaveLength(0)
  })
})
