import type { integrations } from '@/lib/server/db'
import type { TicketId } from '@quackback/ids'
import { getIntegration } from '../index'
import { getIntegrationAuth } from '../token-refresh'
import { findInstallationDestination } from '../destinations'
import { markSyncDispatched } from './ledger'
import { withSyncTransport } from './transport'
import type { SyncClaim, SyncOutcome } from './types'
import { canDispatchSync } from './eligibility'

export async function executeTicketCreate(
  claim: SyncClaim,
  integration: typeof integrations.$inferSelect
): Promise<SyncOutcome> {
  const issues = getIntegration(integration.integrationType)?.issues
  if (!issues?.create) return { state: 'cancelled', errorCode: 'installation_changed' }
  // The operation names its destination by key. Resolving it that way — rather
  // than assuming the installation's one channel — is what lets the same code
  // serve an installation with several destinations.
  const destination = await findInstallationDestination(integration, claim.operation.destinationKey)
  if (!destination) return { state: 'cancelled', errorCode: 'installation_changed' }
  const { buildTicketIssueData } =
    await import('@/lib/server/domains/tickets/ticket-external-links.service')
  const data = await buildTicketIssueData(claim.operation.sourceId as TicketId)
  const credentials = await getIntegrationAuth(integration.id)
  const auth = {
    ...credentials.config,
    ...credentials.secrets,
    accessToken: credentials.accessToken,
    // The issue is created where the key check just resolved, not wherever
    // config.channelId happens to point: the two must never be able to differ.
    channelId: destination.externalRef,
  }
  if (!(await canDispatchSync(claim.operation, integration))) return { state: 'cancelled' }
  // canDispatchSync rechecks config just before dispatch — and destinations no
  // longer live in config. Recheck the destination itself at the same point, or
  // an edit landing during the credential read above sends the issue to the
  // repository the admin just moved away from.
  if (!(await findInstallationDestination(integration, claim.operation.destinationKey)))
    return { state: 'cancelled', errorCode: 'installation_changed' }
  if (!(await markSyncDispatched(claim))) return { state: 'cancelled' }
  return withSyncTransport(async () => ({
    state: 'succeeded',
    result: { ...(await issues.create!({ auth, ...data })) },
  }))
}
