/**
 * The daily webhook-refresh sweep (T-010), exercised against PostgreSQL with
 * the real Jira definition and a mocked network.
 *
 * Refreshing only helps a webhook that still exists. Jira expires dynamic
 * webhooks 30 days after the last refresh and later harvests them, so every
 * connection the original bug already hit lists NO webhook at all. Reporting
 * that as "nothing to refresh" left their status sync dead and the health panel
 * clean — the same silence the refresh was added to end. When status sync is on
 * and the webhook this installation depends on is not among the live ones, the
 * sweep has to register it again (T-010, acceptance criterion 4).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'

vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))
vi.mock('@/lib/server/secret-key', () => ({
  activeSecretKey: () => 'integration-sync-test-key-32-characters-only',
}))
// The callback URL comes from the deployment's base URL, which the full config
// validates with every other variable. Supply one here; storing the webhook and
// recording errors stay real.
vi.mock('../webhook-registration', async (original) => ({
  ...(await original<typeof import('../webhook-registration')>()),
  buildWebhookCallbackUrl: (type: string) =>
    `https://quackback.example.test/api/integrations/${type}/webhook`,
}))

import { eq, integrations } from '@/lib/server/db'
import { encryptSecrets } from '../encryption'
import { runWebhookRefresh } from '../webhook-refresh-queue'

const fixture = await createDbTestFixture()

const CLOUD = 'cloud-1'
const BASE = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/webhook`

type Installation = typeof integrations.$inferSelect

async function seedJira(config: Record<string, unknown>): Promise<Installation> {
  const [row] = await testDb
    .insert(integrations)
    .values({
      integrationType: 'jira',
      status: 'active',
      secrets: encryptSecrets({ accessToken: 'jira-token' }),
      config: { channelId: '10001:10004', cloudId: CLOUD, ...config } as Installation['config'],
      connectedAt: new Date('2026-01-15T12:00:00.000Z'),
    })
    .returning()
  return row
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Jira as seen from the sweep: which webhooks exist, and what a new registration returns. */
function jira(options: { live: number[]; registered?: number; registerStatus?: number }) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body })
      if (method === 'GET' && url.startsWith(BASE))
        return json({
          isLast: true,
          maxResults: 100,
          startAt: 0,
          total: options.live.length,
          values: options.live.map((id) => ({ id, url: 'x', jqlFilter: 'x', events: [] })),
        })
      if (method === 'PUT' && url === `${BASE}/refresh`)
        return json({ expirationDate: 1_900_000_000_000 })
      if (method === 'POST' && url === BASE)
        return options.registerStatus && options.registerStatus >= 400
          ? json({ errorMessages: ['nope'] }, options.registerStatus)
          : json({ webhookRegistrationResult: [{ createdWebhookId: options.registered ?? 999 }] })
      throw new Error(`unexpected request ${method} ${url}`)
    })
  )
  return {
    registrations: () => calls.filter((c) => c.method === 'POST'),
    refreshes: () => calls.filter((c) => c.method === 'PUT'),
  }
}

async function current(integration: Installation) {
  return (await testDb.query.integrations.findFirst({
    where: eq(integrations.id, integration.id),
  }))!
}

describe.skipIf(!fixture.available)('webhook refresh sweep (PostgreSQL)', () => {
  beforeEach(fixture.begin)
  afterEach(async () => {
    vi.unstubAllGlobals()
    await fixture.rollback()
  })
  afterAll(fixture.close)

  it('refreshes a live webhook and registers nothing', async () => {
    const integration = await seedJira({ statusSyncEnabled: true, externalWebhookId: '77' })
    const net = jira({ live: [77] })

    await runWebhookRefresh()

    expect(net.refreshes()).toHaveLength(1)
    expect(net.registrations()).toHaveLength(0)
    expect((await current(integration)).lastError).toBeNull()
  })

  it('registers the webhook again when Jira has already harvested it', async () => {
    // The connection the original bug hit: its webhook expired and is gone.
    const integration = await seedJira({
      statusSyncEnabled: true,
      externalWebhookId: '77',
      webhookSecret: 'kept-secret',
    })
    const net = jira({ live: [], registered: 501 })

    await runWebhookRefresh()

    expect(net.registrations()).toHaveLength(1)
    // Same callback and project filter the original registration used.
    expect(net.registrations()[0].body).toMatchObject({
      url: 'https://quackback.example.test/api/integrations/jira/webhook',
      webhooks: [{ jqlFilter: 'project = 10001' }],
    })
    const after = await current(integration)
    const config = after.config as Record<string, unknown>
    expect(config.externalWebhookId).toBe('501')
    // The inbound handler needs a secret on file; an unrelated rotation is not wanted.
    expect(config.webhookSecret).toBe('kept-secret')
    expect(after.lastError).toBeNull()
  })

  it('registers again when other webhooks are live but not this installation’s', async () => {
    const integration = await seedJira({ statusSyncEnabled: true, externalWebhookId: '77' })
    const net = jira({ live: [12, 13], registered: 502 })

    await runWebhookRefresh()

    expect(net.refreshes()).toHaveLength(1)
    expect(net.registrations()).toHaveLength(1)
    expect(((await current(integration)).config as Record<string, unknown>).externalWebhookId).toBe(
      '502'
    )
  })

  it('treats an empty list as normal when status sync is off', async () => {
    const integration = await seedJira({ statusSyncEnabled: false })
    const net = jira({ live: [] })

    await runWebhookRefresh()

    expect(net.registrations()).toHaveLength(0)
    expect((await current(integration)).lastError).toBeNull()
  })

  it('makes a failed re-registration visible on the health panel', async () => {
    const integration = await seedJira({ statusSyncEnabled: true, externalWebhookId: '77' })
    jira({ live: [], registerStatus: 403 })

    await runWebhookRefresh()

    const after = await current(integration)
    // Pinned to Jira's own rejection: a looser match once passed while the real
    // cause was an unrelated configuration error in the same catch.
    expect(after.lastError).toMatch(/re-registered: Jira API error 403/)
    expect((after.config as Record<string, unknown>).externalWebhookId).toBe('77')
  })
})
