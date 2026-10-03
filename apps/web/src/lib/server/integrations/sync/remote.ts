import { SyncRequestError } from './errors'
import { getIntegration } from '../index'
import { getIntegrationAuth } from '../token-refresh'
import { currentSyncIntegration } from './eligibility'
import { readSyncPayload } from './ledger'
import { syncDestination, syncHash } from './identity'
import { findInstallationDestination } from '../destinations'
import type { SyncOperation } from './types'

export async function inspectSyncRemote(op: SyncOperation, reference: string) {
  const integration = await currentSyncIntegration(op)
  const inspect = getIntegration(op.provider)?.issues?.inspect
  if (!integration || !inspect)
    throw new SyncRequestError('Remote verification is unavailable for this connection')
  const credentials = await getIntegrationAuth(integration.id)
  if (credentials.installation !== op.installation)
    throw new SyncRequestError('The connection changed. This sync cannot use the new connection.')
  const config = credentials.config
  const payload = readSyncPayload(op)
  // Hook operations persist their target; ticket creations queue `data: {}`, so
  // theirs is recovered from the key the operation was queued under. The hash
  // check below still has the final word, against the current credentials.
  const resolved = payload.data.target
    ? null
    : await findInstallationDestination(integration, op.destinationKey)
  const target = payload.data.target ?? (resolved ? { channelId: resolved.externalRef } : null)
  if (
    !target ||
    syncHash(syncDestination(target, config, getIntegration(integration.integrationType))) !==
      op.destinationKey
  )
    throw new SyncRequestError('The destination changed. This sync cannot use the new destination.')
  const auth = {
    ...credentials.config,
    ...credentials.secrets,
    accessToken: credentials.accessToken,
    ...(target as Record<string, unknown>),
  }
  try {
    return await inspect({ auth, reference })
  } catch {
    throw new SyncRequestError(
      'Could not verify that item in the original destination. Check its reference and connection.'
    )
  }
}
