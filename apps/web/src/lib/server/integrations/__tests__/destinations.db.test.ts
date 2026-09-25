/**
 * The destination reader: what `sync/` will call instead of reading
 * `config.channelId` (T-001).
 *
 * The property under test is not "the reader returns rows". It is that the
 * **derived destination key stays byte-identical across the migration**.
 * `post_external_links.sync_scope` and `ticket_external_links.sync_scope` are
 * `${installationIdentity(integration)}:${syncHash(destination)}`, so a reader
 * that produces any other hash orphans every existing link in silence — no
 * error, no log, just status sync that stops finding its own links. That is the
 * worst failure mode this ticket has, and the reason cases 1 and 2 below assert
 * the same expected value computed two different ways.
 *
 * Every expected key here is computed by calling the REAL `syncDestination` /
 * `syncHash` from `sync/identity.ts`. A hardcoded hex digest would pass while
 * the production path changed underneath it.
 *
 * Jira is the deliberate exception (SPEC-0001 D-4/D-6): its identity drops to
 * `projectId` alone because the issue type is mutable and its change fires the
 * very webhook we consume. Case 3 pins that the key therefore *differs* — which
 * is exactly why the `sync_scope` backfill is not optional.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { fromUuid, toUuid } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'

vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import { integrations } from '@/lib/server/db'
import { getIntegration } from '@/lib/server/integrations/index'
import { syncDestination, syncHash } from '@/lib/server/integrations/sync/identity'

const fixture = await createDbTestFixture({
  // 0287 is recent; a database still on 0286 must skip, not fail mid-test.
  probe: async (db) =>
    void (await db.execute(
      sql`select external_ref, settings, scope from integration_destinations limit 0`
    )),
})

/** `installationIdentity` folds `connectedAt` in — keep it out of the clock. */
const CONNECTED_AT = new Date('2026-01-15T12:00:00.000Z')

type Installation = typeof integrations.$inferSelect

/**
 * The contract this suite fixes for
 * `apps/web/src/lib/server/integrations/destinations.ts`:
 *
 *   listInstallationDestinations(integration): Promise<InstallationDestination[]>
 *
 * with, per destination:
 *   - `id`: the `integration_destinations` row id as a TypeId, or `null` when
 *     the destination came from the `config.channelId` compatibility path (so a
 *     caller can tell "not migrated yet" from "migrated", and T-003 can write
 *     back to a real row).
 *   - `externalRef`: the provider reference exactly as stored — the value the
 *     key is derived from, never reformatted.
 *   - `settings`: creation-time config that is NOT identity (Jira issue type).
 *   - `destinationKey`: `syncHash(syncDestination({ channelId: externalRef },
 *     config, definition))` — derived, never stored.
 */
async function readDestinations(integration: Installation) {
  const module = await import('@/lib/server/integrations/destinations')
  return module.listInstallationDestinations(integration)
}

/** The key the codebase produced before this ticket, and must keep producing. */
function keyFor(target: string, integration: Installation) {
  return syncHash(
    syncDestination(
      { channelId: target },
      integration.config as Record<string, unknown>,
      getIntegration(integration.integrationType)
    )
  )
}

async function seedInstallation(
  integrationType: string,
  config: Record<string, unknown>
): Promise<Installation> {
  const [row] = await testDb
    .insert(integrations)
    .values({
      integrationType,
      status: 'active',
      config: config as Installation['config'],
      connectedAt: CONNECTED_AT,
    })
    .returning()
  return row
}

// Raw SQL on purpose: `integrationDestinations` is not re-exported from
// `@/lib/server/db` yet, and `lib/**` may not import `@quackback/db/schema`
// (.oxlintrc.json). Adding that export is implementation, not test.
async function seedDestination(
  integration: Installation,
  externalRef: string,
  settings: Record<string, unknown> = {}
) {
  const rows = (await testDb.execute(
    sql`INSERT INTO integration_destinations (integration_id, external_ref, settings)
        VALUES (${toUuid(integration.id)}::uuid, ${externalRef}, ${JSON.stringify(settings)}::jsonb)
        RETURNING id`
  )) as unknown as { id: string }[]
  return fromUuid('integration_destination', rows[0].id)
}

async function countDestinations(integration: Installation) {
  const rows = (await testDb.execute(
    sql`SELECT count(*)::int AS n FROM integration_destinations
        WHERE integration_id = ${toUuid(integration.id)}::uuid`
  )) as unknown as { n: number }[]
  return rows[0].n
}

describe.skipIf(!fixture.available)('installation destination reader (PostgreSQL)', () => {
  beforeEach(fixture.begin)
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  it('1. reads config.channelId when the installation has no destination row, with the historical key', async () => {
    // The un-migrated installation: this is what every existing tenant looks
    // like the instant before the backfill runs.
    const integration = await seedInstallation('github', {
      channelId: 'acme/api',
      organizationName: 'acme',
    })
    expect(await countDestinations(integration)).toBe(0)

    const destinations = await readDestinations(integration)

    expect(destinations).toHaveLength(1)
    expect(destinations[0]).toMatchObject({
      id: null,
      externalRef: 'acme/api',
      settings: {},
      destinationKey: keyFor('acme/api', integration),
    })
  })

  it('2. GitHub: the seeded row yields the SAME key as the config.channelId fallback', async () => {
    // If this ever fails, every post_external_links.sync_scope written before
    // the migration stops matching and status sync silently loses its links.
    const integration = await seedInstallation('github', {
      channelId: 'acme/api',
      organizationName: 'acme',
    })
    const destinationId = await seedDestination(integration, 'acme/api')
    expect(await countDestinations(integration)).toBe(1)

    const destinations = await readDestinations(integration)

    expect(destinations).toHaveLength(1)
    expect(destinations[0]).toMatchObject({ id: destinationId, externalRef: 'acme/api' })
    // Computed from the legacy config value, not from the row — the two paths
    // must converge on one hash.
    expect(destinations[0].destinationKey).toBe(
      keyFor((integration.config as Record<string, unknown>).channelId as string, integration)
    )
  })

  it('3. Jira: identity drops the issue type, so the key changes and settings carry it', async () => {
    const integration = await seedInstallation('jira', {
      channelId: '10001:10004',
      cloudId: 'cloud-acme',
      siteUrl: 'https://acme.atlassian.net',
    })
    const destinationId = await seedDestination(integration, '10001', { issueTypeId: '10004' })

    const destinations = await readDestinations(integration)

    expect(destinations).toHaveLength(1)
    expect(destinations[0]).toMatchObject({
      id: destinationId,
      externalRef: '10001',
      settings: { issueTypeId: '10004' },
      destinationKey: keyFor('10001', integration),
    })
    // The divergence is the point: this is the whole reason SPEC-0001 D-4/D-6
    // requires a sync_scope backfill for Jira and forbids one for GitHub.
    expect(destinations[0].destinationKey).not.toBe(keyFor('10001:10004', integration))
  })

  it('4. returns one entry per row, with distinct keys', async () => {
    const integration = await seedInstallation('github', {
      channelId: 'acme/api',
      organizationName: 'acme',
    })
    await seedDestination(integration, 'acme/api')
    await seedDestination(integration, 'acme/web')
    expect(await countDestinations(integration)).toBe(2)

    const destinations = await readDestinations(integration)

    expect(destinations).toHaveLength(2)
    expect(destinations.map((d) => d.externalRef).sort()).toEqual(['acme/api', 'acme/web'])
    expect(new Set(destinations.map((d) => d.destinationKey)).size).toBe(2)
    for (const destination of destinations)
      expect(destination.destinationKey).toBe(keyFor(destination.externalRef, integration))
  })

  it('5. does not append config.channelId on top of existing rows', async () => {
    // config.channelId stays written for rollback. Reading it *as well as* the
    // rows would double-deliver to the legacy destination.
    const integration = await seedInstallation('github', {
      channelId: 'acme/api',
      organizationName: 'acme',
    })
    await seedDestination(integration, 'acme/web')

    const destinations = await readDestinations(integration)

    expect(destinations).toHaveLength(1)
    expect(destinations[0].externalRef).toBe('acme/web')
    expect(destinations.map((d) => d.externalRef)).not.toContain('acme/api')
  })

  it('6. returns an empty list, without throwing, when there is no row and no channelId', async () => {
    const integration = await seedInstallation('github', { organizationName: 'acme' })

    await expect(readDestinations(integration)).resolves.toEqual([])
  })

  /**
   * The settings screens still write `config.channelId` (github-config.tsx,
   * jira-config.tsx) — they will until T-005 replaces them. Once 0287 has seeded
   * a row, the reader trusts the row. So a repository change made on the
   * existing screen updates config and leaves the row behind, and every
   * automatic delivery after it is cancelled as `installation_changed`, because
   * the resolver aims at config while `hooks.ts` checks against the row.
   *
   * `syncLegacyDestination` is the bridge: while the table is the source of
   * truth for an installation, a legacy write has to move the row with it.
   */
  describe('legacy config.channelId writes (T-001 regression)', () => {
    async function syncLegacy(integration: Installation, channelId: string) {
      const module = await import('@/lib/server/integrations/destinations')
      return module.syncLegacyDestination(integration, channelId)
    }

    it('moves a migrated row when the settings screen picks another repository', async () => {
      const integration = await seedInstallation('github', {
        channelId: 'acme/api',
        organizationName: 'acme',
      })
      const rowId = await seedDestination(integration, 'acme/api')

      await syncLegacy(integration, 'acme/web')

      const destinations = await readDestinations(integration)
      expect(destinations).toHaveLength(1)
      // Updated in place, not replaced: the row keeps its identity.
      expect(destinations[0].id).toBe(rowId)
      expect(destinations[0].externalRef).toBe('acme/web')
      expect(destinations[0].destinationKey).toBe(keyFor('acme/web', integration))
      expect(await countDestinations(integration)).toBe(1)
    })

    it('mirrors a Jira value exactly, without splitting it', async () => {
      // Jira identity stays the full string until T-006 separates it with its
      // backfill; splitting here would drop the issue type the hook reads.
      const integration = await seedInstallation('jira', {
        channelId: '10001:10004',
        cloudId: 'cloud-1',
      })
      await seedDestination(integration, '10001:10004')

      await syncLegacy(integration, '10001:10007')

      const destinations = await readDestinations(integration)
      expect(destinations.map((d) => d.externalRef)).toEqual(['10001:10007'])
    })

    it('leaves an installation that has no row on the config fallback', async () => {
      // Not table-backed yet: config.channelId is still its source of truth, so
      // creating a row here would be a second source, not a bridge.
      const integration = await seedInstallation('github', {
        channelId: 'acme/api',
        organizationName: 'acme',
      })

      await syncLegacy(integration, 'acme/web')

      expect(await countDestinations(integration)).toBe(0)
    })

    it('does nothing when the value did not change', async () => {
      const integration = await seedInstallation('github', {
        channelId: 'acme/api',
        organizationName: 'acme',
      })
      const rowId = await seedDestination(integration, 'acme/api')

      await syncLegacy(integration, 'acme/api')

      const destinations = await readDestinations(integration)
      expect(destinations.map((d) => [d.id, d.externalRef])).toEqual([[rowId, 'acme/api']])
    })
  })
})
