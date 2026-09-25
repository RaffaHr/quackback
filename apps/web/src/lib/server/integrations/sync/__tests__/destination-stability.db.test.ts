/**
 * T-004: editing one destination cancels only that destination's operations.
 *
 * T-004 was written when destinations were expected to live inside the
 * `config` blob, and proposed excluding them from the stability hash in
 * `canDispatchSync`. T-001 put them in their own table instead, and that hash
 * covers `integration.config` only (minus `tokenExpiresAt`). So adding or
 * editing a destination row cannot change it, by construction. No production
 * code changes here: this file proves the property.
 *
 * Two windows matter, and they are guarded by different checks:
 *
 * - **Queued, not yet claimed.** The worker resolves the operation's
 *   destination by key (`findInstallationDestination`). An edited X no longer
 *   reports X's key, so X's operation cancels; Y's key still resolves, so Y's
 *   operation completes. The stability hash plays no part here: the worker
 *   takes its `expected` snapshot at claim time, after the edit, so both sides
 *   of the comparison already see the edited state.
 * - **Claimed, not yet dispatched.** Between the claim snapshot and dispatch
 *   the executor refreshes credentials (network I/O). An edit landing in that
 *   window is what the stability hash sees. These are the cases that would go
 *   red if destination rows ever leaked into the hash — the regression T-004
 *   feared. The edit is injected there the same way
 *   `provider-contracts.db.test.ts` injects a reconnect: a one-shot wrapper
 *   around `getIntegrationAuth` that writes, then delegates.
 *
 * Reconnection still cancels everything: `installationIdentity` folds
 * `connectedAt` in, and the worker's `currentSyncIntegration` refuses a
 * changed identity before any destination is resolved.
 *
 * Kept apart from `destination-source.db.test.ts` on purpose: that file is
 * T-001's migrated-row witness with one destination per installation, and its
 * expectations must not move. The helpers below mirror its own (installation
 * seeded, then 0287's real backfill; an operation built the way its case "2c"
 * builds one, keyed to a given row) because they are closures there and not
 * exported.
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
vi.mock('@/lib/server/domains/tickets/ticket.webhooks', () => ({
  emitTicketCreated: vi.fn().mockResolvedValue(undefined),
  emitTicketStatusChanged: vi.fn().mockResolvedValue(undefined),
  emitTicketAssigned: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/server/realtime/conversation-channels', () => ({ publishTicketEvent: vi.fn() }))
import {
  sql,
  eq,
  and,
  user,
  principal,
  settings,
  ticketStatuses,
  integrations,
  integrationDestinations,
  ticketExternalLinks,
  integrationSyncOperations as operations,
} from '@/lib/server/db'
import { encryptSecrets } from '@/lib/server/integrations/encryption'
import { getIntegration } from '@/lib/server/integrations/index'
import { listInstallationDestinations } from '@/lib/server/integrations/destinations'
import {
  installationIdentity,
  syncDestination,
  syncOperationKey,
} from '@/lib/server/integrations/sync/identity'
import { queueSyncOperation } from '@/lib/server/integrations/sync/ledger'
import { runIntegrationSync } from '@/lib/server/integrations/sync/worker'
import { syncTestJob } from '@/lib/server/integrations/sync/__tests__/job'
import { createTicket } from '@/lib/server/domains/tickets/ticket.service'
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

/** The data-writing statements of 0287, verbatim, as destination-source.db.test.ts reads them. */
const MIGRATION_BACKFILL = readFileSync(
  join(__dirname, '../../../../../../../../packages/db/drizzle/0287_integration_destinations.sql'),
  'utf8'
)
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim())
  .filter((statement) =>
    /^(--.*\n)*\s*(INSERT INTO|UPDATE) "integration_destinations"/m.test(statement)
  )

/** Destination X: the migrated row, mirroring config.channelId. */
const X = 'acme/api'
/** Destination Y: a second row on the same installation, as T-005's screen will add. */
const Y = 'acme/web'
/** Where X is edited to. */
const X_EDITED = 'acme/api-v2'
const suffix = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!fixture.available)(
  'T-004: editing destination X cancels only the operations of X',
  () => {
    beforeEach(async () => {
      await fixture.begin()
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        // Every POST is an issue creation; answer with the repo it was sent to.
        const repo = /repos\/([^/]+\/[^/]+)\/issues/.exec(String(input))?.[1] ?? 'unknown'
        return Response.json(
          { number: 1, html_url: `https://github.com/${repo}/issues/1` },
          { status: 201 }
        )
      })
    })
    afterEach(async () => {
      vi.restoreAllMocks()
      await fixture.rollback()
    })
    afterAll(fixture.close)

    it('reads the two data statements out of the real 0287 migration', () => {
      expect(MIGRATION_BACKFILL).toHaveLength(2)
    })

    /** A migrated GitHub installation (row X from 0287) plus a second row Y. */
    async function seedTwoDestinations() {
      const [person] = await testDb
        .insert(user)
        .values({
          id: createId('user') as UserId,
          name: 'Admin',
          email: `${randomUUID()}@example.test`,
        })
        .returning()
      const [row] = await testDb
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
          principalId: row.id,
          config: {
            channelId: X,
            organizationName: 'acme',
            externalWebhookId: '99',
            statusSyncEnabled: true,
          },
        })
        .returning()
      for (const statement of MIGRATION_BACKFILL) await testDb.execute(sql.raw(statement))
      await testDb.insert(integrationDestinations).values({
        integrationId: integration.id,
        externalRef: Y,
      })

      const destinations = await listInstallationDestinations(integration)
      // Two real rows, not the config fallback.
      expect(destinations.map((d) => d.externalRef).sort()).toEqual([X, Y])
      expect(destinations.every((d) => d.id !== null)).toBe(true)

      const actor: Actor = {
        principalId: row.id as PrincipalId,
        role: 'admin',
        principalType: 'user',
        segmentIds: new Set(),
        permissions: resolveActorPermissions('admin'),
      }
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
      return { actor, integration }
    }

    /**
     * A ticket-to-issue operation for the row named by `externalRef`, built
     * exactly as createIssueForTicket builds one — createIssueForTicket itself
     * still derives the destination from config.channelId, so it can only
     * ever queue for X.
     */
    async function queueTicketIssue(
      actor: Actor,
      integration: typeof integrations.$inferSelect,
      externalRef: string
    ) {
      const ticketId: TicketId = (
        await createTicket({ type: 'customer', title: `ticket ${suffix()}` }, actor)
      ).id
      const config = (integration.config ?? {}) as Record<string, unknown>
      const installation = installationIdentity(integration)
      const destination = syncDestination(
        { channelId: externalRef },
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
      return { operationId: queued.id, ticketId }
    }

    /** How the T-005 screen will edit a destination: the row only, never config.channelId. */
    async function editRow(integrationId: string, from: string, to: string) {
      const moved = await testDb
        .update(integrationDestinations)
        .set({ externalRef: to, updatedAt: new Date() })
        .where(
          and(
            eq(integrationDestinations.integrationId, integrationId as never),
            eq(integrationDestinations.externalRef, from)
          )
        )
        .returning()
      expect(moved).toHaveLength(1)
    }

    /**
     * Run `write` inside the executor's claim-to-dispatch window, once: after
     * the worker has taken its config snapshot and resolved the destination,
     * before `canDispatchSync` compares hashes.
     */
    async function duringNextDispatch(write: (integrationId: string) => Promise<void>) {
      const auth = await import('@/lib/server/integrations/token-refresh')
      const original = auth.getIntegrationAuth
      vi.spyOn(auth, 'getIntegrationAuth').mockImplementationOnce(async (id, rejected) => {
        await write(id)
        return original(id, rejected)
      })
    }

    function createdIn() {
      return vi
        .mocked(fetch)
        .mock.calls.filter(([, init]) => init?.method === 'POST')
        .map(([input]) => String(input))
    }

    async function stored(id: string) {
      return (await testDb.query.integrationSyncOperations.findFirst({
        where: eq(operations.id, id),
      }))!
    }

    async function linksOf(ticketId: TicketId) {
      return testDb.query.ticketExternalLinks.findMany({
        where: eq(ticketExternalLinks.ticketId, ticketId),
      })
    }

    const config = (integration: typeof integrations.$inferSelect) =>
      (integration.config ?? {}) as Record<string, unknown>

    describe('queued, not yet claimed — destination resolved by key', () => {
      it('editing row X cancels X and lets Y complete in its own repository', async () => {
        const { actor, integration } = await seedTwoDestinations()
        const x = await queueTicketIssue(actor, integration, X)
        const y = await queueTicketIssue(actor, integration, Y)

        await editRow(integration.id, X, X_EDITED)
        const after = (await testDb.query.integrations.findFirst({
          where: eq(integrations.id, integration.id),
        }))!
        // The edit touched the row only; config — the whole stability hash input — is intact.
        expect(config(after)).toEqual(config(integration))

        await runIntegrationSync(syncTestJob(x.operationId))
        await runIntegrationSync(syncTestJob(y.operationId))

        expect(await stored(x.operationId)).toMatchObject({
          state: 'cancelled',
          errorCode: 'installation_changed',
          dispatchedAt: null,
        })
        expect(await linksOf(x.ticketId)).toHaveLength(0)

        expect(await stored(y.operationId)).toMatchObject({ state: 'succeeded' })
        expect(createdIn()).toEqual([`https://api.github.com/repos/${Y}/issues`])
        const [link] = await linksOf(y.ticketId)
        expect(link).toMatchObject({ externalId: '1', externalDisplayId: `${Y}#1` })
      })

      it('reconnecting the installation cancels both X and Y', async () => {
        const { actor, integration } = await seedTwoDestinations()
        const x = await queueTicketIssue(actor, integration, X)
        const y = await queueTicketIssue(actor, integration, Y)

        const [reconnected] = await testDb
          .update(integrations)
          .set({
            connectedAt: new Date(),
            secrets: encryptSecrets({ accessToken: 'new-account-token' }),
          })
          .where(eq(integrations.id, integration.id))
          .returning()
        // Same destinations, same config: only the connection identity moved.
        expect(installationIdentity(reconnected)).not.toBe(installationIdentity(integration))
        expect(config(reconnected)).toEqual(config(integration))

        await runIntegrationSync(syncTestJob(x.operationId))
        await runIntegrationSync(syncTestJob(y.operationId))

        for (const op of [x, y]) {
          expect(await stored(op.operationId)).toMatchObject({
            state: 'cancelled',
            errorCode: 'installation_changed',
            dispatchedAt: null,
          })
          expect(await linksOf(op.ticketId)).toHaveLength(0)
        }
        expect(createdIn()).toEqual([])
      })
    })

    describe('claimed, not yet dispatched — the stability hash window', () => {
      it('editing row X while Y is in flight does not cancel Y', async () => {
        const { actor, integration } = await seedTwoDestinations()
        const y = await queueTicketIssue(actor, integration, Y)
        await duringNextDispatch((id) => editRow(id, X, X_EDITED))

        await runIntegrationSync(syncTestJob(y.operationId))

        expect(
          vi.mocked((await import('@/lib/server/integrations/token-refresh')).getIntegrationAuth)
        ).toHaveBeenCalledTimes(1)
        expect(
          (await listInstallationDestinations(integration)).map((d) => d.externalRef).sort()
        ).toEqual([X_EDITED, Y])
        expect(await stored(y.operationId)).toMatchObject({ state: 'succeeded' })
        expect(createdIn()).toEqual([`https://api.github.com/repos/${Y}/issues`])
        expect(await linksOf(y.ticketId)).toHaveLength(1)
      })

      it('editing row X while X itself is in flight cancels X before dispatch', async () => {
        // Destinations live outside config, so canDispatchSync's recheck cannot
        // see this edit. Without a recheck of the destination itself the issue
        // is created in X's PREVIOUS repository — the one the admin just moved
        // away from. Latent while edits arrive through config.channelId (the
        // config hash catches them); live once T-005 edits the table directly.
        const { actor, integration } = await seedTwoDestinations()
        const x = await queueTicketIssue(actor, integration, X)
        await duringNextDispatch((id) => editRow(id, X, X_EDITED))

        await runIntegrationSync(syncTestJob(x.operationId))

        expect(await stored(x.operationId)).toMatchObject({
          state: 'cancelled',
          errorCode: 'installation_changed',
          dispatchedAt: null,
        })
        expect(createdIn()).toEqual([])
        expect(await linksOf(x.ticketId)).toHaveLength(0)
      })

      it('adding a destination while Y is in flight does not cancel Y', async () => {
        const { actor, integration } = await seedTwoDestinations()
        const y = await queueTicketIssue(actor, integration, Y)
        await duringNextDispatch(async (id) => {
          await testDb
            .insert(integrationDestinations)
            .values({ integrationId: id as never, externalRef: 'acme/docs' })
        })

        await runIntegrationSync(syncTestJob(y.operationId))

        expect(await listInstallationDestinations(integration)).toHaveLength(3)
        expect(await stored(y.operationId)).toMatchObject({ state: 'succeeded' })
        expect(createdIn()).toEqual([`https://api.github.com/repos/${Y}/issues`])
      })

      it('reconnecting while Y is in flight still cancels Y before dispatch', async () => {
        const { actor, integration } = await seedTwoDestinations()
        const y = await queueTicketIssue(actor, integration, Y)
        await duringNextDispatch(async (id) => {
          await testDb
            .update(integrations)
            .set({ connectedAt: new Date() })
            .where(eq(integrations.id, id as never))
        })

        await runIntegrationSync(syncTestJob(y.operationId))

        expect(await stored(y.operationId)).toMatchObject({
          state: 'cancelled',
          dispatchedAt: null,
        })
        expect(createdIn()).toEqual([])
      })
    })
  }
)
