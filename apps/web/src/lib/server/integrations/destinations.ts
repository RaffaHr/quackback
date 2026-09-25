/**
 * Where an installation may create work.
 *
 * `sync/` used to read `config.channelId` directly, which is why an
 * installation had exactly one destination. This is the single place that
 * question is answered now, and it answers it the same way for an installation
 * that has been migrated and one that has not.
 *
 * **The destination key is derived here, never stored.** `sync_scope` on every
 * existing link is `installation:syncHash(syncDestination(...))`, so the key a
 * destination reports has to come out of the very same function that wrote
 * those links — a second implementation, in SQL or in a cached column, is a
 * second chance to disagree, and disagreement means silently orphaned links.
 */
import {
  db,
  sql,
  and,
  eq,
  integrations,
  integrationDestinations,
  integrationEventMappings,
} from '@/lib/server/db'
import type { SQL } from 'drizzle-orm'
import { fromUuid, toUuid, type IntegrationDestinationId, type IntegrationId } from '@quackback/ids'
import { ValidationError } from '@/lib/shared/errors'
import { getExecuteRows } from '@/lib/server/utils/execute-rows'
import { getIntegration } from './index'
import { safeDestinationLabel } from './destination'
import { syncDestination, syncHash } from './sync/identity'

/**
 * Reads go through the caller's transaction when it has one. Several callers
 * already hold a transaction, and a second connection taken from a one-slot
 * pool while the first is held would wait on itself.
 *
 * Only `execute` is required — the same narrow shape as `JobSqlExecutor`, and
 * for the same reason: it is satisfied by `db`, by a drizzle transaction, and by
 * the job executor `sync/status.ts` holds, which has nothing else.
 */
type Reader = { execute: (query: SQL) => Promise<unknown> }
type Writer = Pick<typeof db, 'select' | 'update'>

/**
 * What the reader needs from an installation. A full row satisfies it, and so
 * does the partial a raw query yields — `sync/status.ts` builds one inside its
 * own transaction and must not re-read the row just to ask this.
 */
export type DestinationSource = Pick<
  typeof integrations.$inferSelect,
  'id' | 'config' | 'integrationType'
>

export interface InstallationDestination {
  /** `null` marks the compatibility path: no row yet, read from `config.channelId`. */
  id: IntegrationDestinationId | null
  /** Exactly as stored. Any normalization here changes the key and orphans links. */
  externalRef: string
  /** Decides WHAT to create, not WHERE — Jira's issue type (SPEC-0001, D-4). */
  settings: Record<string, unknown>
  /**
   * `syncDestination(...)` itself: what an operation records as its
   * destination. Digests only — never a raw target (see identity.ts).
   */
  destination: Record<string, unknown>
  /** `syncHash(destination)`, the value `sync_scope` is built from. */
  destinationKey: string
}

/**
 * Every destination an installation can target, newest last.
 *
 * Falls back to `config.channelId` only when the installation has no rows —
 * once it has any, `config.channelId` is the legacy default and must not be
 * appended on top, or the same place would be delivered to twice.
 */
export async function listInstallationDestinations(
  integration: DestinationSource,
  executor: Reader = db
): Promise<InstallationDestination[]> {
  const config = (integration.config ?? {}) as Record<string, unknown>
  const definition = getIntegration(integration.integrationType)
  const describe = (externalRef: string) => {
    const destination = syncDestination({ channelId: externalRef }, config, definition)
    return { destination, destinationKey: syncHash(destination) }
  }

  // Raw SQL, not the query builder: see `Reader`. Ids cross the ORM boundary by
  // hand here, exactly as the typeid column type would convert them.
  const rows = getExecuteRows<{
    id: string
    external_ref: string
    settings: Record<string, unknown> | null
  }>(
    await executor.execute(sql`
      SELECT id, external_ref, settings FROM integration_destinations
      WHERE integration_id = ${toUuid(integration.id)}::uuid
      ORDER BY created_at, id`)
  )

  if (rows.length > 0) {
    return rows.map((row) => ({
      id: fromUuid('integration_destination', row.id) as IntegrationDestinationId,
      externalRef: row.external_ref,
      settings: row.settings ?? {},
      ...describe(row.external_ref),
    }))
  }

  const legacy = config.channelId
  if (typeof legacy !== 'string' || legacy === '') return []
  return [{ id: null, externalRef: legacy, settings: {}, ...describe(legacy) }]
}

/**
 * The destination an operation was queued for, found by its key.
 *
 * This is the lookup to prefer: it is exact for any number of destinations,
 * because an operation already names its destination by key. `null` means the
 * destination is no longer one of this installation's — removed, or the
 * connection moved to another org — and the operation must not proceed.
 */
export async function findInstallationDestination(
  integration: DestinationSource,
  destinationKey: string,
  executor: Reader = db
): Promise<InstallationDestination | null> {
  const destinations = await listInstallationDestinations(integration, executor)
  return destinations.find((d) => d.destinationKey === destinationKey) ?? null
}

/**
 * The destination for a caller that has no key of its own to look up: a legacy
 * event mapping written before mappings named their channel, or an inbound
 * event that arrived without a signed destination.
 *
 * **Only exact while an installation has a single destination**, which every
 * installation does until destinations can be added (T-005). Each remaining
 * caller is replaced by a real lookup in the ticket that makes it multi-
 * destination — T-006 for inbound, which emits a signed `destinationId`.
 */
export async function defaultInstallationDestination(
  integration: DestinationSource,
  executor: Reader = db
): Promise<InstallationDestination | null> {
  return (await listInstallationDestinations(integration, executor))[0] ?? null
}

/**
 * Keep a table-backed installation's destination in step with a legacy
 * `config.channelId` write.
 *
 * The settings screens write `config.channelId` and will until T-005 replaces
 * them. Once an installation has a row, the reader trusts the row — so without
 * this, choosing another repository on the existing screen moves config and
 * leaves the row behind, and every automatic delivery after it is cancelled as
 * `installation_changed`, because the resolver aims at config while `hooks.ts`
 * checks against the row. Nothing in that path raises an error.
 *
 * An installation with no row is left alone: config is still its source of
 * truth, and creating a row here would be a second source rather than a bridge.
 */
export async function syncLegacyDestination(
  integration: DestinationSource,
  channelId: string,
  executor: Writer = db
): Promise<void> {
  const rows = await executor
    .select({ id: integrationDestinations.id, externalRef: integrationDestinations.externalRef })
    .from(integrationDestinations)
    .where(eq(integrationDestinations.integrationId, integration.id))

  if (rows.length === 0) return
  // A single-select screen can only name one destination. With several rows
  // there is no row the write faithfully means, and guessing one — or ignoring
  // the write — would recreate the silent divergence this exists to prevent.
  if (rows.length > 1)
    throw new ValidationError(
      'DESTINATIONS_MANAGED_ELSEWHERE',
      'This connection has several destinations. Manage them from the destinations list.'
    )

  const [row] = rows
  if (row.externalRef === channelId) return
  await executor
    .update(integrationDestinations)
    .set({
      externalRef: channelId,
      // The stored webhook id was registered on the previous repository. Keeping
      // it would be a value known to be wrong for this one.
      externalWebhookId: null,
      updatedAt: new Date(),
    })
    .where(eq(integrationDestinations.id, row.id))
}

// ---------------------------------------------------------------------------
// Managing destinations (T-005)
// ---------------------------------------------------------------------------

/** The one event a tracker destination routes today: new feedback becomes an item. */
const ROUTED_EVENT = 'post.created'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface DestinationInput {
  /** Provider reference, stored exactly as given: `owner/repo`, a project id. */
  externalRef: string
  displayLabel?: string | null
  /** Boards whose new feedback routes here. Empty or absent: every board. */
  boardIds?: string[] | null
}

/**
 * A reference is interpolated into provider API paths (`repos/${ref}/issues`),
 * so beyond the safe-label charset it must not contain a `..` segment — that
 * would walk the request out of the repository it names.
 */
function assertSafeReference(externalRef: string): void {
  if (
    safeDestinationLabel(externalRef) === null ||
    externalRef.split('/').some((segment) => segment === '..' || segment === '.')
  )
    throw new ValidationError('INVALID_DESTINATION', 'That is not a valid destination reference')
}

async function lockInstallation(tx: Tx, integrationId: IntegrationId) {
  // Serialize every change to one installation's destinations: two concurrent
  // first additions would otherwise both materialize the legacy destination.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`integration-destinations:${integrationId}`}))`
  )
  const [integration] = await tx
    .select()
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .for('update')
  if (!integration)
    throw new ValidationError('INTEGRATION_UNAVAILABLE', 'Connect the integration first')
  if (!getIntegration(integration.integrationType)?.multipleDestinations)
    throw new ValidationError(
      'SINGLE_DESTINATION',
      'This integration routes to a single destination'
    )
  return integration
}

async function rowsOf(tx: Tx, integrationId: IntegrationId) {
  return tx
    .select()
    .from(integrationDestinations)
    .where(eq(integrationDestinations.integrationId, integrationId))
    .orderBy(integrationDestinations.createdAt, integrationDestinations.id)
}

async function insertRow(
  tx: Tx,
  integrationId: IntegrationId,
  externalRef: string,
  displayLabel: string | null
) {
  await tx.insert(integrationDestinations).values({
    integrationId,
    externalRef,
    displayLabel,
    // clock_timestamp, not now(): rows added in one transaction must keep the
    // order they were added in, because the first one is the primary.
    createdAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  })
}

/**
 * Point every legacy mapping — written before mappings named their channel,
 * and read by the resolver as "config.channelId" — at an explicit destination.
 * Once an installation is managed, routing must not depend on a config field
 * that only mirrors the primary.
 */
async function adoptLegacyMappings(tx: Tx, integrationId: IntegrationId, primaryRef: string) {
  const mappings = await tx
    .select()
    .from(integrationEventMappings)
    .where(eq(integrationEventMappings.integrationId, integrationId))
  for (const mapping of mappings) {
    const action = (mapping.actionConfig ?? {}) as Record<string, unknown>
    if (typeof action.channelId === 'string' && action.channelId !== '') continue
    const explicit = mappings.some(
      (other) =>
        other.id !== mapping.id &&
        other.eventType === mapping.eventType &&
        other.actionType === mapping.actionType &&
        other.targetKey === primaryRef
    )
    if (explicit) {
      // The primary already has its own mapping for this event; the legacy one
      // would only route there a second time.
      await tx.delete(integrationEventMappings).where(eq(integrationEventMappings.id, mapping.id))
      continue
    }
    await tx
      .update(integrationEventMappings)
      .set({
        targetKey: primaryRef,
        actionConfig: { ...action, channelId: primaryRef },
        updatedAt: new Date(),
      })
      .where(eq(integrationEventMappings.id, mapping.id))
  }
}

/**
 * Keep `config.channelId` equal to the primary destination — the first one.
 * Readers outside `sync/` still use it (ticket → issue until T-007, the inbox).
 * Written only when the primary changes, because any config write cancels the
 * installation's in-flight operations through `canDispatchSync`. With no
 * destination left the key is removed, so the reader's config fallback cannot
 * bring a removed destination back.
 */
async function mirrorPrimary(tx: Tx, integration: DestinationSource, primaryRef: string | null) {
  const config = (integration.config ?? {}) as Record<string, unknown>
  if ((config.channelId ?? null) === primaryRef) return
  const { channelId: _previous, ...rest } = config
  await tx
    .update(integrations)
    .set({
      config: primaryRef === null ? rest : { ...rest, channelId: primaryRef },
      updatedAt: new Date(),
    })
    .where(eq(integrations.id, integration.id))
}

async function invalidateRouting(): Promise<void> {
  const { cacheDel, CACHE_KEYS } = await import('@/lib/server/cache')
  await cacheDel(CACHE_KEYS.INTEGRATION_MAPPINGS)
}

/**
 * Add a destination, or update the boards of one that already exists.
 *
 * On an installation still served from `config.channelId`, the original
 * destination is materialized first: once any row exists the reader stops
 * falling back to config, and the original would silently stop receiving.
 */
export async function addInstallationDestination(
  integrationId: IntegrationId,
  input: DestinationInput
): Promise<InstallationDestination> {
  assertSafeReference(input.externalRef)
  const filters = input.boardIds?.length ? { boardIds: input.boardIds } : null

  const added = await db.transaction(async (tx) => {
    const integration = await lockInstallation(tx, integrationId)
    const config = (integration.config ?? {}) as Record<string, unknown>

    let rows = await rowsOf(tx, integrationId)
    const legacy = typeof config.channelId === 'string' ? config.channelId : ''
    if (rows.length === 0 && legacy !== '') {
      assertSafeReference(legacy)
      await insertRow(tx, integrationId, legacy, null)
      rows = await rowsOf(tx, integrationId)
    }
    if (!rows.some((row) => row.externalRef === input.externalRef)) {
      await insertRow(tx, integrationId, input.externalRef, input.displayLabel ?? null)
      rows = await rowsOf(tx, integrationId)
    }

    const primaryRef = rows[0].externalRef
    await adoptLegacyMappings(tx, integrationId, primaryRef)
    await tx
      .insert(integrationEventMappings)
      .values({
        integrationId,
        eventType: ROUTED_EVENT,
        actionType: 'send_message',
        targetKey: input.externalRef,
        actionConfig: { channelId: input.externalRef },
        filters,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: [
          integrationEventMappings.integrationId,
          integrationEventMappings.eventType,
          integrationEventMappings.actionType,
          integrationEventMappings.targetKey,
        ],
        // Boards only: whether routing is switched on is its own control.
        set: { filters: sql`excluded.filters`, updatedAt: new Date() },
      })
    await mirrorPrimary(tx, integration, primaryRef)

    const destinations = await listInstallationDestinations(
      { ...integration, config: { ...config, channelId: primaryRef } },
      tx
    )
    return destinations.find((d) => d.externalRef === input.externalRef)!
  })

  await invalidateRouting()
  return added
}

async function ownedRow(
  tx: Tx,
  integrationId: IntegrationId,
  destinationId: IntegrationDestinationId
) {
  const [row] = await tx
    .select()
    .from(integrationDestinations)
    .where(
      and(
        eq(integrationDestinations.id, destinationId),
        eq(integrationDestinations.integrationId, integrationId)
      )
    )
  if (!row)
    throw new ValidationError(
      'DESTINATION_NOT_FOUND',
      'That destination is not part of this connection'
    )
  return row
}

/** Remove a destination and its routing, moving the primary mirror if needed. */
export async function removeInstallationDestination(
  integrationId: IntegrationId,
  destinationId: IntegrationDestinationId
): Promise<void> {
  await db.transaction(async (tx) => {
    const integration = await lockInstallation(tx, integrationId)
    const row = await ownedRow(tx, integrationId, destinationId)
    const before = await rowsOf(tx, integrationId)
    // A legacy mapping routes to the primary; make that explicit first, so
    // removing the primary removes its routing instead of leaving a mapping
    // that silently follows the mirror to the next destination.
    await adoptLegacyMappings(tx, integrationId, before[0].externalRef)
    await tx
      .delete(integrationEventMappings)
      .where(
        and(
          eq(integrationEventMappings.integrationId, integrationId),
          eq(integrationEventMappings.targetKey, row.externalRef)
        )
      )
    await tx.delete(integrationDestinations).where(eq(integrationDestinations.id, row.id))
    const remaining = before.filter((r) => r.id !== row.id)
    await mirrorPrimary(tx, integration, remaining[0]?.externalRef ?? null)
  })
  await invalidateRouting()
}

/** Route a destination from these boards only (empty or null: every board). */
export async function setInstallationDestinationBoards(
  integrationId: IntegrationId,
  destinationId: IntegrationDestinationId,
  boardIds: string[] | null
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockInstallation(tx, integrationId)
    const row = await ownedRow(tx, integrationId, destinationId)
    const before = await rowsOf(tx, integrationId)
    await adoptLegacyMappings(tx, integrationId, before[0].externalRef)
    await tx
      .update(integrationEventMappings)
      .set({ filters: boardIds?.length ? { boardIds } : null, updatedAt: new Date() })
      .where(
        and(
          eq(integrationEventMappings.integrationId, integrationId),
          eq(integrationEventMappings.targetKey, row.externalRef)
        )
      )
  })
  await invalidateRouting()
}
