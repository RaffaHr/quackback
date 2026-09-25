import { integrationFetch } from '@/lib/server/integrations/sync/transport'
/**
 * Jira dynamic webhook registration for inbound status sync.
 *
 * Uses POST /rest/api/3/webhook (Connect / OAuth 2.0). That API accepts only
 * `=`, `!=`, `IN`, `NOT IN` in jqlFilter — not `IS` / `IS NOT`.
 * Dynamic webhooks have no HMAC secret field.
 */

interface JiraWebhookResult {
  webhookId: string
}

const PROJECT_REF = /^[A-Za-z0-9_]+$/

export async function registerJiraWebhook(
  accessToken: string,
  cloudId: string,
  callbackUrl: string,
  projectRef: string
): Promise<JiraWebhookResult> {
  if (!PROJECT_REF.test(projectRef)) {
    throw new Error('Invalid Jira project reference')
  }

  const response = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/webhook`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: callbackUrl,
      webhooks: [
        {
          jqlFilter: `project = ${projectRef}`,
          events: ['jira:issue_updated'],
        },
      ],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Jira API error ${response.status}: ${body}`)
  }

  const result = (await response.json()) as {
    webhookRegistrationResult?: Array<{ createdWebhookId?: number; errors?: string[] }>
  }
  const first = result.webhookRegistrationResult?.[0]
  if (!first?.createdWebhookId) {
    const detail = first?.errors?.join('; ')
    throw new Error(detail || 'No webhook ID returned from Jira')
  }

  return { webhookId: String(first.createdWebhookId) }
}

export async function deleteJiraWebhook(
  accessToken: string,
  cloudId: string,
  webhookId: string
): Promise<void> {
  await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/webhook`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ webhookIds: [Number(webhookId)] }),
  })
}

/**
 * Outcome of one refresh pass, returned instead of thrown.
 *
 * A refresh runs inside a periodic job, where a rejected promise is trivially
 * swallowed — and a silently unrefreshed webhook dies 30 days later with no
 * symptom, which is the exact bug this code exists to remove. So the failure is
 * a value: `stage` separates "could not even list" from "listed, refresh
 * rejected" (different operator action) and `error` is what reaches `lastError`
 * on the installation. The `?: undefined` members keep every field readable on
 * the union without narrowing first, while still making the shapes exclusive.
 */
export type JiraWebhookRefreshResult =
  | { status: 'refreshed'; webhookIds: number[]; stage?: undefined; error?: undefined }
  | { status: 'nothing-to-refresh'; webhookIds: number[]; stage?: undefined; error?: undefined }
  | { status: 'failed'; stage: 'list' | 'refresh'; error: string; webhookIds?: undefined }

/**
 * `maxResults` for the listing. The documented ceiling is 5 webhooks per OAuth
 * app per user per tenant, so one page always suffices in practice.
 */
const WEBHOOK_PAGE_SIZE = 100

/**
 * Bound on the listing traversal. At the documented ceiling of 5 webhooks this
 * is unreachable; it only stops an endless loop if `isLast` never turns true.
 */
const MAX_WEBHOOK_PAGES = 10

interface JiraWebhookPage {
  isLast?: boolean
  startAt?: number
  values?: Array<{ id?: unknown }>
}

/**
 * Extend the life of every dynamic webhook this app registered on `cloudId`.
 *
 * Webhooks registered through the REST API expire 30 days after creation or
 * refresh, so this has to run periodically or inbound status sync dies without
 * an error. Listing first (`GET /rest/api/3/webhook`, already scoped to the
 * calling app) rather than trusting a locally stored id also covers the cases
 * where the stored id drifted or the webhook was removed in Jira.
 *
 * Every listed id is refreshed, never a subset: refresh is idempotent, it just
 * pushes expiry to now+30d, and selecting by `expirationDate` would mean
 * reading a field the official spec contradicts itself about — the schema
 * declares `integer/int64` while the published example of the same endpoints
 * shows an ISO string. The field is therefore never read here; HTTP 200 is what
 * decides success. Choosing *when* to run is the job's business, not this
 * function's.
 *
 * Never throws — see `JiraWebhookRefreshResult`.
 */
export async function refreshJiraWebhooks(
  accessToken: string,
  cloudId: string
): Promise<JiraWebhookRefreshResult> {
  const base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/webhook`
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  }

  const webhookIds: number[] = []
  let startAt = 0

  for (let page = 0; ; page++) {
    if (page >= MAX_WEBHOOK_PAGES) {
      // Refreshing only what was listed so far would leave the rest to expire
      // unnoticed, so this surfaces as a failure instead of a partial pass.
      return {
        status: 'failed',
        stage: 'list',
        error: `Jira still reported more webhooks after ${MAX_WEBHOOK_PAGES} pages`,
      }
    }

    let body: JiraWebhookPage
    try {
      // The page URL is built here rather than followed from the response's
      // `nextPage`: `startAt` arithmetic reaches the same place without sending
      // the bearer token to whatever URL a response body happens to carry.
      const response = await integrationFetch(
        `${base}?startAt=${startAt}&maxResults=${WEBHOOK_PAGE_SIZE}`,
        { headers }
      )
      if (!response.ok) {
        return {
          status: 'failed',
          stage: 'list',
          error: `Jira API error ${response.status}: ${await response.text()}`,
        }
      }
      body = (await response.json()) as JiraWebhookPage
    } catch (error) {
      return { status: 'failed', stage: 'list', error: errorMessage(error) }
    }

    const values = body.values ?? []
    for (const webhook of values) {
      // `ContainerForWebhookIDs` takes `integer` items and refuses anything
      // else, so ids stay numbers here — `deleteJiraWebhook` above carries them
      // as strings, and `String(id)` would be a guaranteed 400.
      const id = Number(webhook?.id)
      if (Number.isFinite(id)) webhookIds.push(id)
    }

    if (body.isLast !== false || values.length === 0) break
    startAt = (typeof body.startAt === 'number' ? body.startAt : startAt) + values.length
  }

  // `{ webhookIds: [] }` is a documented 400 and pure noise in a job that runs
  // for every active connection.
  if (webhookIds.length === 0) return { status: 'nothing-to-refresh', webhookIds: [] }

  try {
    const response = await integrationFetch(`${base}/refresh`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      // Unrecognized ids — removed in Jira, expired and harvested, or owned by
      // another app — are documented as ignored, so no pre-check is needed.
      body: JSON.stringify({ webhookIds }),
    })
    if (!response.ok) {
      return {
        status: 'failed',
        stage: 'refresh',
        error: `Jira API error ${response.status}: ${await response.text()}`,
      }
    }
  } catch (error) {
    return { status: 'failed', stage: 'refresh', error: errorMessage(error) }
  }

  return { status: 'refreshed', webhookIds }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
