/**
 * Keep expiring webhook registrations alive.
 *
 * Jira's dynamic webhooks expire 30 days after registration or the last
 * refresh, and the failure mode is silence: the webhook stops delivering, no
 * error is raised anywhere, and status sync simply stops moving. Nothing else
 * in the system notices, because a webhook that never fires is
 * indistinguishable from a quiet tracker.
 *
 * Capability-gated, not provider-gated: any provider that declares
 * `webhookRegistration.refresh` is swept. Most providers' webhooks do not
 * expire and declare nothing, so they are skipped.
 *
 * Imports are static on purpose — `JOBS.md` §9 and
 * `jobs/__tests__/handler-imports.test.ts` require it, so the module's top
 * level cannot run inside a per-job workspace scope.
 */
import { db, integrations, eq } from '@/lib/server/db'
import type { IntegrationId } from '@quackback/ids'
import { getIntegration } from './index'
import { getValidAccessToken } from './token-refresh'
import {
  buildWebhookCallbackUrl,
  clearIntegrationLastError,
  generateWebhookSecret,
  recordIntegrationLastError,
  storeWebhookConfig,
} from './webhook-registration'
import type { IntegrationDefinition } from './types'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'webhook-refresh' })

export async function runWebhookRefresh(): Promise<void> {
  const rows = await db.query.integrations.findMany({
    where: eq(integrations.status, 'active'),
  })

  for (const row of rows) {
    const registration = getIntegration(row.integrationType)?.webhookRegistration
    // 'manual' is a string, and a provider whose webhooks never expire omits
    // `refresh` entirely — both are skips, not failures.
    if (typeof registration !== 'object' || !registration.refresh) continue

    const config = (row.config ?? {}) as Record<string, unknown>
    const integrationId = row.id as IntegrationId

    try {
      const accessToken = await getValidAccessToken(integrationId)
      if (!accessToken) {
        // A connection that cannot authenticate needs reconnecting, which the
        // health panel already surfaces from the refresh failure below.
        await recordIntegrationLastError(
          integrationId,
          'Webhook refresh skipped: no valid access token. Reconnect the integration.'
        )
        continue
      }

      const result = await registration.refresh({ accessToken, config })
      if (result.status === 'failed') {
        await recordIntegrationLastError(
          integrationId,
          `Webhook refresh failed: ${result.error}`.slice(0, 1000)
        )
        log.error(
          { integration_type: row.integrationType, integration_id: integrationId },
          'webhook refresh failed'
        )
        continue
      }

      // Refreshing only helps a webhook that still exists. The one this
      // installation depends on — recorded when status sync was enabled — has to
      // be among the live ones; when it is not, the provider has harvested it
      // (or someone removed it), and "nothing to refresh" would leave status
      // sync dead with a clean health panel. Register it again.
      const expected =
        typeof config.externalWebhookId === 'string' ? config.externalWebhookId : null
      if (
        config.statusSyncEnabled === true &&
        expected !== null &&
        result.liveWebhookIds !== undefined &&
        !result.liveWebhookIds.includes(expected)
      ) {
        if (
          await registerAgain(row.integrationType, integrationId, accessToken, config, registration)
        ) {
          await clearIntegrationLastError(integrationId)
          log.warn(
            { integration_type: row.integrationType, integration_id: integrationId },
            'webhook was missing and has been registered again'
          )
        }
        continue
      }

      // Only clear on a real success, so an unrelated earlier error is not
      // wiped by a sweep that happened to have nothing to do.
      if (result.status === 'refreshed') await clearIntegrationLastError(integrationId)
      log.info(
        { integration_type: row.integrationType, outcome: result.status },
        'webhook refresh swept'
      )
    } catch (error) {
      // One provider's failure must not stop the others from being refreshed.
      const message = error instanceof Error ? error.message : String(error)
      await recordIntegrationLastError(
        integrationId,
        `Webhook refresh failed: ${message}`.slice(0, 1000)
      )
      log.error({ err: error, integration_type: row.integrationType }, 'webhook refresh threw')
    }
  }
}

type AutoRegistration = Exclude<NonNullable<IntegrationDefinition['webhookRegistration']>, 'manual'>

/**
 * The same registration `enableStatusSyncFn` performs, without the request
 * context. Returns whether the webhook is registered again; a failure lands on
 * the health panel rather than being retried silently.
 *
 * Note: storing the new webhook id rewrites the installation's config, which
 * `canDispatchSync` treats as a change — so operations in flight for this
 * installation at that moment are cancelled. It happens once per lost webhook,
 * the same as re-enabling status sync by hand.
 */
async function registerAgain(
  integrationType: string,
  integrationId: IntegrationId,
  accessToken: string,
  config: Record<string, unknown>,
  registration: AutoRegistration
): Promise<boolean> {
  // Keep the secret on file: the inbound handler requires one, and losing a
  // webhook is no reason to rotate it.
  const secret =
    typeof config.webhookSecret === 'string' ? config.webhookSecret : generateWebhookSecret()
  try {
    const result = await registration.register({
      accessToken,
      config,
      callbackUrl: buildWebhookCallbackUrl(integrationType),
      secret,
    })
    await storeWebhookConfig(
      integrationId,
      result.webhookSecret ?? secret,
      result.externalWebhookId
    )
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await recordIntegrationLastError(
      integrationId,
      `Webhook expired and could not be re-registered: ${message}`.slice(0, 1000)
    )
    log.error({ err: error, integration_type: integrationType }, 'webhook re-registration failed')
    return false
  }
}
