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
import { db, sql, integrations, integrationDestinations, eq } from '@/lib/server/db'
import type { SQL } from 'drizzle-orm'
import { fromUuid, toUuid, type IntegrationDestinationId } from '@quackback/ids'
import { ValidationError } from '@/lib/shared/errors'
import { getExecuteRows } from '@/lib/server/utils/execute-rows'
import { getIntegration } from './index'
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
