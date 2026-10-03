/**
 * `updateIntegrationFn` is where the settings screens write `config.channelId`.
 * Once 0287 has seeded a destination row, that write has to move the row too —
 * otherwise the resolver aims at config while `hooks.ts` checks against the row,
 * and every automatic delivery is cancelled as `installation_changed` with no
 * error anywhere (T-001 regression, fixed by `syncLegacyDestination`).
 *
 * `destinations.db.test.ts` proves `syncLegacyDestination` itself. This file
 * proves the last mile: that the server function actually calls it, with the
 * value the screen sent, inside the same transaction as the config write.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { toUuid } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'

const hoisted = vi.hoisted(() => ({ requireAuth: vi.fn() }))

// A server function is a plain handler once the chain returns it as-is.
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = {
      validator: () => chain,
      handler: (fn: (args: unknown) => unknown) => fn,
    }
    return chain
  },
}))
vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: hoisted.requireAuth,
}))
vi.mock('@/lib/server/cache', () => ({
  cacheDel: vi.fn(),
  CACHE_KEYS: { INTEGRATION_MAPPINGS: 'integration-mappings' },
}))
vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import { eq, integrations } from '@/lib/server/db'
import { updateIntegrationFn } from '../integrations'

const fixture = await createDbTestFixture({
  probe: async (db) =>
    void (await db.execute(sql`select external_ref from integration_destinations limit 0`)),
})

type Installation = typeof integrations.$inferSelect
type UpdateInput = { id: string; config?: Record<string, unknown> }
const update = updateIntegrationFn as unknown as (args: { data: UpdateInput }) => Promise<unknown>

async function seedGitHub(channelId: string): Promise<Installation> {
  const [row] = await testDb
    .insert(integrations)
    .values({
      integrationType: 'github',
      status: 'active',
      config: { channelId, organizationName: 'acme' } as Installation['config'],
      connectedAt: new Date('2026-01-15T12:00:00.000Z'),
    })
    .returning()
  return row
}

async function seedRow(integration: Installation, externalRef: string) {
  await testDb.execute(
    sql`INSERT INTO integration_destinations (integration_id, external_ref)
        VALUES (${toUuid(integration.id)}::uuid, ${externalRef})`
  )
}

async function refs(integration: Installation) {
  const rows = (await testDb.execute(
    sql`SELECT external_ref FROM integration_destinations
        WHERE integration_id = ${toUuid(integration.id)}::uuid ORDER BY external_ref`
  )) as unknown as { external_ref: string }[]
  return rows.map((r) => r.external_ref)
}

async function channelIdOf(integration: Installation) {
  const row = await testDb.query.integrations.findFirst({
    where: eq(integrations.id, integration.id),
  })
  return (row?.config as Record<string, unknown> | undefined)?.channelId
}

describe.skipIf(!fixture.available)('updateIntegrationFn keeps the destination row in step', () => {
  beforeEach(async () => {
    await fixture.begin()
    hoisted.requireAuth.mockResolvedValue({ principal: { id: 'principal_test' } })
  })
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  it('moves the migrated row along with config.channelId', async () => {
    const integration = await seedGitHub('acme/api')
    await seedRow(integration, 'acme/api')

    await update({ data: { id: integration.id, config: { channelId: 'acme/web' } } })

    expect(await channelIdOf(integration)).toBe('acme/web')
    expect(await refs(integration)).toEqual(['acme/web'])
  })

  it('leaves a config write that does not touch channelId away from the row', async () => {
    const integration = await seedGitHub('acme/api')
    await seedRow(integration, 'acme/api')

    await update({ data: { id: integration.id, config: { statusSyncEnabled: true } } })

    expect(await refs(integration)).toEqual(['acme/api'])
  })

  it('refuses an ambiguous write and leaves config untouched in the same transaction', async () => {
    // The single-select screen cannot say which of two rows it means. The row
    // update refuses — and because it shares the config write's transaction,
    // config must not move either. A half-applied write is the divergence
    // this whole path exists to prevent.
    const integration = await seedGitHub('acme/api')
    await seedRow(integration, 'acme/api')
    await seedRow(integration, 'acme/web')

    await expect(
      update({ data: { id: integration.id, config: { channelId: 'acme/mobile' } } })
    ).rejects.toThrow('several destinations')

    expect(await channelIdOf(integration)).toBe('acme/api')
    expect(await refs(integration)).toEqual(['acme/api', 'acme/web'])
  })
})
