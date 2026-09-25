/**
 * Managing a tracker installation's destinations (T-005, slice 1): add, remove,
 * and route by board — server side only, before any webhook or screen.
 *
 * The transitions are what can lose data, so they are what this pins:
 *
 * - **Legacy → managed.** An installation connected after migration 0287 has
 *   only `config.channelId` and no row. The reader serves it from that
 *   fallback — until a first row exists, after which the fallback stops. Adding
 *   a second repository must therefore materialize the original one first, or
 *   it silently stops receiving issues.
 * - **The legacy mapping.** The old screen wrote a mapping with no
 *   `actionConfig.channelId`, which the resolver reads as "config.channelId".
 *   With several destinations it becomes an explicit mapping per destination.
 * - **The primary mirror.** Readers outside `sync/` still use
 *   `config.channelId` (ticket → issue until T-007, the inbox). It mirrors the
 *   first destination and is written only when that one changes.
 * - **Removing the last destination** must not resurrect it through the
 *   config fallback.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { toUuid } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'

vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))
const cache = vi.hoisted(() => ({ cacheDel: vi.fn() }))
vi.mock('@/lib/server/cache', () => ({
  cacheDel: cache.cacheDel,
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(),
  CACHE_KEYS: { INTEGRATION_MAPPINGS: 'integration-mappings' },
}))

import { eq, integrations, integrationEventMappings } from '@/lib/server/db'
import { buildIntegrationTargets } from '@/lib/server/events/resolvers/integration.resolver'
import {
  addInstallationDestination,
  listInstallationDestinations,
  removeInstallationDestination,
  setInstallationDestinationBoards,
} from '../destinations'

const fixture = await createDbTestFixture()

type Installation = typeof integrations.$inferSelect

async function seed(
  integrationType: string,
  config: Record<string, unknown>,
  legacyMapping?: { enabled?: boolean; boardIds?: string[] }
): Promise<Installation> {
  const [row] = await testDb
    .insert(integrations)
    .values({
      integrationType,
      status: 'active',
      config: config as Installation['config'],
      connectedAt: new Date('2026-01-15T12:00:00.000Z'),
    })
    .returning()
  if (legacyMapping)
    // Exactly what updateIntegrationFn writes: no actionConfig, targetKey 'default'.
    await testDb.insert(integrationEventMappings).values({
      integrationId: row.id,
      eventType: 'post.created',
      actionType: 'send_message',
      enabled: legacyMapping.enabled ?? true,
      filters: legacyMapping.boardIds ? { boardIds: legacyMapping.boardIds } : null,
    })
  return row
}

async function reload(integration: Installation) {
  return (await testDb.query.integrations.findFirst({
    where: eq(integrations.id, integration.id),
  }))!
}

async function mappingsOf(integration: Installation) {
  return testDb.query.integrationEventMappings.findMany({
    where: eq(integrationEventMappings.integrationId, integration.id),
  })
}

async function refsOf(integration: Installation) {
  return (await listInstallationDestinations(await reload(integration))).map((d) => d.externalRef)
}

/** Where the real resolver would send a `post.created` on `boardId`. */
async function routedTo(integration: Installation, boardId = 'board_any') {
  const current = await reload(integration)
  const mappings = (await mappingsOf(integration))
    .filter((m) => m.enabled)
    .map((m) => ({
      eventType: m.eventType,
      integrationType: current.integrationType,
      integrationId: current.id,
      integrationConfig: current.config,
      actionConfig: m.actionConfig,
      filters: m.filters,
    }))
  return buildIntegrationTargets(mappings, 'post.created', [boardId])
    .map((t) => (t.target as { channelId: string }).channelId)
    .sort()
}

describe.skipIf(!fixture.available)('tracker destination management (PostgreSQL)', () => {
  beforeEach(fixture.begin)
  afterEach(async () => {
    cache.cacheDel.mockClear()
    await fixture.rollback()
  })
  afterAll(fixture.close)

  it('keeps the original repository when a legacy installation gains a second one', async () => {
    const integration = await seed(
      'github',
      { channelId: 'acme/api', organizationName: 'acme' },
      { enabled: true }
    )

    await addInstallationDestination(integration.id, { externalRef: 'acme/web' })

    expect(await refsOf(integration)).toEqual(['acme/api', 'acme/web'])
    expect(await routedTo(integration)).toEqual(['acme/api', 'acme/web'])
    // The legacy mapping became an explicit one; nothing still reads config for routing.
    const mappings = await mappingsOf(integration)
    expect(mappings.map((m) => m.targetKey).sort()).toEqual(['acme/api', 'acme/web'])
    expect(mappings.every((m) => (m.actionConfig as { channelId?: string }).channelId)).toBe(true)
    // The primary is unchanged, so config is not rewritten.
    expect((await reload(integration)).config).toMatchObject({ channelId: 'acme/api' })
    expect(cache.cacheDel).toHaveBeenCalledWith('integration-mappings')
  })

  it('carries the legacy mapping’s own board filter and switch into its explicit form', async () => {
    const integration = await seed(
      'github',
      { channelId: 'acme/api', organizationName: 'acme' },
      { enabled: false, boardIds: ['board_bugs'] }
    )

    await addInstallationDestination(integration.id, { externalRef: 'acme/web' })

    const api = (await mappingsOf(integration)).find((m) => m.targetKey === 'acme/api')!
    expect(api.enabled).toBe(false)
    expect(api.filters).toEqual({ boardIds: ['board_bugs'] })
    // Only the new destination routes; the original stays switched off as it was.
    expect(await routedTo(integration, 'board_bugs')).toEqual(['acme/web'])
  })

  it('routes each destination only from its own boards', async () => {
    const integration = await seed('github', { organizationName: 'acme' })

    await addInstallationDestination(integration.id, {
      externalRef: 'acme/api',
      boardIds: ['board_bugs'],
    })
    await addInstallationDestination(integration.id, {
      externalRef: 'acme/ops',
      boardIds: ['board_infra'],
    })

    expect(await routedTo(integration, 'board_bugs')).toEqual(['acme/api'])
    expect(await routedTo(integration, 'board_infra')).toEqual(['acme/ops'])
  })

  it('makes the first destination of a new installation its primary', async () => {
    const integration = await seed('github', { organizationName: 'acme' })

    await addInstallationDestination(integration.id, { externalRef: 'acme/api' })

    expect((await reload(integration)).config).toMatchObject({ channelId: 'acme/api' })
  })

  it('treats adding an existing repository as an update of its boards, not a duplicate', async () => {
    const integration = await seed('github', { organizationName: 'acme' })
    await addInstallationDestination(integration.id, { externalRef: 'acme/api' })

    await addInstallationDestination(integration.id, {
      externalRef: 'acme/api',
      boardIds: ['board_bugs'],
    })

    expect(await refsOf(integration)).toEqual(['acme/api'])
    const mappings = await mappingsOf(integration)
    expect(mappings).toHaveLength(1)
    expect(mappings[0].filters).toEqual({ boardIds: ['board_bugs'] })
  })

  it('removes one destination without touching the others or the primary', async () => {
    const integration = await seed('github', { organizationName: 'acme' })
    await addInstallationDestination(integration.id, { externalRef: 'acme/api' })
    const web = await addInstallationDestination(integration.id, { externalRef: 'acme/web' })

    await removeInstallationDestination(integration.id, web.id!)

    expect(await refsOf(integration)).toEqual(['acme/api'])
    expect(await routedTo(integration)).toEqual(['acme/api'])
    expect((await reload(integration)).config).toMatchObject({ channelId: 'acme/api' })
  })

  it('moves the primary mirror when the primary destination is removed', async () => {
    const integration = await seed('github', { organizationName: 'acme' })
    const api = await addInstallationDestination(integration.id, { externalRef: 'acme/api' })
    await addInstallationDestination(integration.id, { externalRef: 'acme/web' })

    await removeInstallationDestination(integration.id, api.id!)

    expect((await reload(integration)).config).toMatchObject({ channelId: 'acme/web' })
  })

  it('does not resurrect the last destination through the config fallback', async () => {
    const integration = await seed(
      'github',
      { channelId: 'acme/api', organizationName: 'acme' },
      { enabled: true }
    )
    const [api] = await listInstallationDestinations(integration)
    // Materialize it first, as the screen would before offering removal.
    const managed = await addInstallationDestination(integration.id, { externalRef: 'acme/api' })
    expect(managed.id).not.toBeNull()
    expect(api.externalRef).toBe('acme/api')

    await removeInstallationDestination(integration.id, managed.id!)

    expect(await refsOf(integration)).toEqual([])
    expect(await routedTo(integration)).toEqual([])
    expect((await reload(integration)).config).not.toHaveProperty('channelId')
  })

  it('changes a destination’s boards without touching the others', async () => {
    const integration = await seed('github', { organizationName: 'acme' })
    const api = await addInstallationDestination(integration.id, { externalRef: 'acme/api' })
    await addInstallationDestination(integration.id, { externalRef: 'acme/web' })

    await setInstallationDestinationBoards(integration.id, api.id!, ['board_bugs'])

    expect(await routedTo(integration, 'board_other')).toEqual(['acme/web'])
    expect(await routedTo(integration, 'board_bugs')).toEqual(['acme/api', 'acme/web'])
  })

  it('refuses a destination id that belongs to another installation', async () => {
    const github = await seed('github', { organizationName: 'acme' })
    // Another installation's row, written directly: Jira is not multi-destination until T-006.
    const jira = await seed('jira', { channelId: '10001:10004', cloudId: 'cloud-1' })
    await testDb.execute(
      sql`INSERT INTO integration_destinations (integration_id, external_ref)
          VALUES (${toUuid(jira.id)}::uuid, '10001:10004')`
    )
    const [foreign] = await listInstallationDestinations(jira)

    await expect(removeInstallationDestination(github.id, foreign.id!)).rejects.toThrow()

    expect(await refsOf(jira)).toEqual(['10001:10004'])
  })

  it('refuses providers that do not route to several destinations yet', async () => {
    // Jira included: its status sync cannot follow a second project until T-006.
    const jira = await seed('jira', { channelId: '10001:10004', cloudId: 'cloud-1' })
    const linear = await seed('linear', { channelId: 'team' })

    await expect(
      addInstallationDestination(jira.id, { externalRef: '10002:10004' })
    ).rejects.toThrow('single destination')
    await expect(
      addInstallationDestination(linear.id, { externalRef: 'other-team' })
    ).rejects.toThrow('single destination')
    expect(await refsOf(jira)).toEqual(['10001:10004'])
  })

  it('refuses a reference that could escape the provider path', async () => {
    const integration = await seed('github', { organizationName: 'acme' })

    for (const externalRef of ['', '../../orgs/acme', 'https://evil.example/x', 'acme/api?x=1'])
      await expect(addInstallationDestination(integration.id, { externalRef })).rejects.toThrow(
        'destination reference'
      )
    expect(await refsOf(integration)).toEqual([])
  })
})
