import { describe, expect, it, vi, afterEach } from 'vitest'
import { refreshJiraWebhooks } from '../webhook-registration'

/**
 * T-010 seam — Jira dynamic webhook refresh (R-0002 / P2 / R3, addendum 2026-09-25).
 *
 * Dynamic webhooks registered through the REST API expire 30 days after they
 * are created or refreshed. Nothing in this repository calls
 * `PUT /rest/api/3/webhook/refresh` today, so every Jira status-sync webhook
 * dies silently about 30 days after the connection is made.
 *
 * The seam under test is the API pair, nothing else:
 *
 *   1. `GET  /rest/api/3/webhook` — paginated (`startAt` / `maxResults`),
 *      returns a `PageBeanWebhook`, and is *already* scoped to the webhooks
 *      registered by the calling app ("Returns a paginated list of the
 *      webhooks registered by the calling app").
 *   2. `PUT  /rest/api/3/webhook/refresh` — body `ContainerForWebhookIDs`,
 *      i.e. `{ webhookIds: number[] }`, items `integer/int64`,
 *      `additionalProperties: false`.
 *
 * Finding the active Jira integration in the database, the job wrapper and the
 * `definitions.ts` entry are deliberately out of scope here: they are DB-bound
 * and belong to a `.db.test.ts` that self-skips without Postgres.
 *
 * ---------------------------------------------------------------------------
 * The return contract this file fixes
 * ---------------------------------------------------------------------------
 * Acceptance criterion 3 of T-010 requires a refresh failure to be *observable*
 * (it feeds `lastError` / `lastErrorAt` on the installation, which feeds the
 * `IntegrationHealthPanel`). A thrown error inside a periodic job is the exact
 * shape of failure that criterion forbids: it is easy to swallow and it carries
 * no structured stage. So the contract pinned here is a returned, total result
 * — `refreshJiraWebhooks` never rejects on an HTTP failure:
 *
 *   { status: 'refreshed',          webhookIds: number[] }   // renewed N
 *   { status: 'nothing-to-refresh', webhookIds: [] }         // nothing to do
 *   { status: 'failed', stage: 'list' | 'refresh', error: string }
 *
 * Three situations, three discriminants. `stage` exists because "we could not
 * even list" and "we listed but the refresh was rejected" need different
 * operator action, and `lastError` is where an operator reads it.
 *
 * ---------------------------------------------------------------------------
 * Why every webhook is refreshed, not just the ones close to expiry
 * ---------------------------------------------------------------------------
 * Refresh is idempotent and simply pushes expiry to now+30d. Picking a subset
 * by `expirationDate` would make this function depend on a field whose type the
 * official spec contradicts itself about (see below). The scheduling window
 * ("comfortably before expiry") is a separate seam, driven by a controlled
 * clock at the job level — not by this function.
 *
 * ---------------------------------------------------------------------------
 * The `expirationDate` trap
 * ---------------------------------------------------------------------------
 * `Webhook.expirationDate` and `WebhooksExpirationDate.expirationDate` are both
 * declared `integer` / `int64` in the official OpenAPI, while the published
 * `example` of BOTH endpoints shows a string:
 * `"expirationDate":"2019-06-01T12:42:30.000+0000"`. Two official statements,
 * incompatible. Whichever type an implementation assumes, the other one is a
 * production-only crash. The tests below therefore run the same scenario three
 * ways — int64 number, ISO string, field absent — and demand identical results.
 */

const CLOUD_ID = 'cloud-42'
const TOKEN = 'tok'
const WEBHOOK_BASE = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/webhook`
const REFRESH_URL = `${WEBHOOK_BASE}/refresh`

/** `expirationDate` as the OpenAPI *schema* declares it: epoch millis, int64. */
const EXPIRES_AS_INT64 = 1_559_392_950_000
/** `expirationDate` as the OpenAPI *example* of the same endpoints shows it. */
const EXPIRES_AS_ISO = '2019-06-01T12:42:30.000+0000'

/** A `PageBeanWebhook`, shaped exactly like the schema. */
function webhookPage(
  values: Array<Record<string, unknown>>,
  page: { startAt: number; maxResults: number; total: number; isLast: boolean; nextPage?: string }
) {
  return jsonResponse(200, {
    startAt: page.startAt,
    maxResults: page.maxResults,
    total: page.total,
    isLast: page.isLast,
    ...(page.nextPage ? { nextPage: page.nextPage } : {}),
    self: `${WEBHOOK_BASE}?startAt=${page.startAt}&maxResults=${page.maxResults}`,
    values,
  })
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function errorResponse(status: number, messages: string[]) {
  return jsonResponse(status, { errorMessages: messages, errors: {} })
}

/**
 * Reads a header from either a plain object init or a `Headers` init, so
 * passing either one is equally valid — this file pins the request, not the
 * way the request happens to be spelled.
 */
function headerOf(init: unknown, name: string): string | undefined {
  const headers = (init as { headers?: unknown } | undefined)?.headers
  if (!headers) return undefined
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined
  }
  const record = headers as Record<string, string>
  const hit = Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase())
  return hit ? record[hit] : undefined
}

const requestedUrl = (call: unknown[]) => String(call[0])
const methodOf = (call: unknown[]) =>
  String((call[1] as { method?: string } | undefined)?.method ?? 'GET').toUpperCase()
const rawBodyOf = (call: unknown[]) => String((call[1] as { body?: unknown } | undefined)?.body)
const parsedBodyOf = (call: unknown[]) => JSON.parse(rawBodyOf(call)) as { webhookIds?: unknown }

/** Any call that is not the `PUT .../refresh` is a listing call. */
const listCalls = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => methodOf(call) !== 'PUT')
const refreshCalls = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => methodOf(call) === 'PUT')

// ---------------------------------------------------------------------------

describe('refreshJiraWebhooks', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // -------------------------------------------------------------------------
  // The happy path: list, then refresh those ids
  // -------------------------------------------------------------------------

  it('refreshes exactly the webhook ids the listing returned', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10000,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10001',
              events: ['jira:issue_updated'],
              expirationDate: EXPIRES_AS_INT64,
            },
            {
              id: 10042,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10002',
              events: ['jira:issue_updated'],
              expirationDate: EXPIRES_AS_INT64,
            },
          ],
          { startAt: 0, maxResults: 100, total: 2, isLast: true }
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, { expirationDate: EXPIRES_AS_INT64 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    expect(result.status).toBe('refreshed')
    expect(result.webhookIds).toEqual([10000, 10042])

    const puts = refreshCalls(fetchMock)
    expect(puts).toHaveLength(1)
    expect(requestedUrl(puts[0])).toBe(REFRESH_URL)
    expect(parsedBodyOf(puts[0])).toEqual({ webhookIds: [10000, 10042] })
  })

  it('sends webhookIds as int64 numbers, never as strings', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10000,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10001',
              events: ['jira:issue_updated'],
            },
          ],
          { startAt: 0, maxResults: 100, total: 1, isLast: true }
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, { expirationDate: EXPIRES_AS_INT64 }))
    vi.stubGlobal('fetch', fetchMock)

    await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    const put = refreshCalls(fetchMock)[0]
    const ids = parsedBodyOf(put).webhookIds as unknown[]
    expect(ids.every((id) => typeof id === 'number')).toBe(true)
    // `ContainerForWebhookIDs` is `additionalProperties: false` with integer
    // items — a quoted id is a 400, and `String(id)` is the easy mistake given
    // that `deleteJiraWebhook` in this same file carries ids around as strings.
    expect(rawBodyOf(put)).not.toContain('"10000"')
  })

  it('authenticates both the listing and the refresh, and sends JSON on the refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10000,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10001',
              events: ['jira:issue_updated'],
            },
          ],
          { startAt: 0, maxResults: 100, total: 1, isLast: true }
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, { expirationDate: EXPIRES_AS_INT64 }))
    vi.stubGlobal('fetch', fetchMock)

    await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    const get = listCalls(fetchMock)[0]
    const put = refreshCalls(fetchMock)[0]
    expect(requestedUrl(get).startsWith(WEBHOOK_BASE)).toBe(true)
    expect(requestedUrl(get)).not.toContain('/refresh')
    expect(headerOf(get[1], 'authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headerOf(put[1], 'authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headerOf(put[1], 'content-type')).toContain('application/json')
  })

  // -------------------------------------------------------------------------
  // Empty listing must not issue the PUT
  // -------------------------------------------------------------------------

  it('does not call refresh at all when the listing is empty', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(webhookPage([], { startAt: 0, maxResults: 100, total: 0, isLast: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    // `{ webhookIds: [] }` is a malformed request (documented 400) and pure
    // noise in the logs of a job that runs on every active connection.
    expect(refreshCalls(fetchMock)).toHaveLength(0)
    expect(result.status).toBe('nothing-to-refresh')
    expect(result.webhookIds).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Pagination of the listing
  // -------------------------------------------------------------------------

  it('refreshes ids from every page of the listing, not just the first', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10000,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10001',
              events: ['jira:issue_updated'],
            },
            {
              id: 10001,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10002',
              events: ['jira:issue_updated'],
            },
          ],
          {
            startAt: 0,
            maxResults: 2,
            total: 3,
            isLast: false,
            nextPage: `${WEBHOOK_BASE}?startAt=2&maxResults=2`,
          }
        )
      )
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10042,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10003',
              events: ['jira:issue_updated'],
            },
          ],
          { startAt: 2, maxResults: 2, total: 3, isLast: true }
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, { expirationDate: EXPIRES_AS_INT64 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    expect(listCalls(fetchMock)).toHaveLength(2)
    // The `nextPage` URL handed over is byte-identical to what `startAt`
    // arithmetic would build, so either traversal satisfies this — the test
    // pins that the second page was fetched, not how its URL was derived.
    expect(requestedUrl(listCalls(fetchMock)[1])).toContain('startAt=2')

    expect(result.status).toBe('refreshed')
    expect(result.webhookIds).toEqual([10000, 10001, 10042])
    expect(refreshCalls(fetchMock)).toHaveLength(1)
    expect(parsedBodyOf(refreshCalls(fetchMock)[0])).toEqual({
      webhookIds: [10000, 10001, 10042],
    })
  })

  it('stops listing on the last page instead of walking off the end', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10000,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10001',
              events: ['jira:issue_updated'],
            },
          ],
          { startAt: 0, maxResults: 100, total: 1, isLast: true }
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, { expirationDate: EXPIRES_AS_INT64 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    expect(listCalls(fetchMock)).toHaveLength(1)
    expect(result.status).toBe('refreshed')
  })

  // -------------------------------------------------------------------------
  // The `expirationDate` type contradiction — the point of this file
  // -------------------------------------------------------------------------

  it('handles expirationDate as the int64 the schema declares', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10000,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10001',
              events: ['jira:issue_updated'],
              expirationDate: EXPIRES_AS_INT64,
            },
          ],
          { startAt: 0, maxResults: 100, total: 1, isLast: true }
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, { expirationDate: EXPIRES_AS_INT64 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    expect(result.status).toBe('refreshed')
    expect(result.webhookIds).toEqual([10000])
  })

  it('handles expirationDate as the ISO string the official example shows', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10000,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10001',
              events: ['jira:issue_updated'],
              expirationDate: EXPIRES_AS_ISO,
            },
          ],
          { startAt: 0, maxResults: 100, total: 1, isLast: true }
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, { expirationDate: EXPIRES_AS_ISO }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    // Identical to the int64 case. Any arithmetic or `Number()` comparison on
    // this field turns the published example into a production-only failure.
    expect(result.status).toBe('refreshed')
    expect(result.webhookIds).toEqual([10000])
  })

  it('refreshes a webhook whose listing entry carries no expirationDate at all', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10000,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10001',
              events: ['jira:issue_updated'],
            },
          ],
          { startAt: 0, maxResults: 100, total: 1, isLast: true }
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    // `expirationDate` is optional on `Webhook`, and the 200 status alone
    // decides success on the refresh — the response field must not gate it.
    expect(result.status).toBe('refreshed')
    expect(result.webhookIds).toEqual([10000])
  })

  it('refreshes both webhooks when one page mixes an int64 and an ISO expirationDate', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10000,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10001',
              events: ['jira:issue_updated'],
              expirationDate: EXPIRES_AS_INT64,
            },
            {
              id: 10001,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10002',
              events: ['jira:issue_updated'],
              expirationDate: EXPIRES_AS_ISO,
            },
          ],
          { startAt: 0, maxResults: 100, total: 2, isLast: true }
        )
      )
      .mockResolvedValueOnce(jsonResponse(200, { expirationDate: EXPIRES_AS_ISO }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    expect(result.status).toBe('refreshed')
    expect(result.webhookIds).toEqual([10000, 10001])
  })

  // -------------------------------------------------------------------------
  // Failure is observable through the return value (T-010 AC3)
  // -------------------------------------------------------------------------

  it('reports a failed listing without throwing and without issuing the refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorResponse(403, ["Returned if the caller isn't an app"]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    expect(result.status).toBe('failed')
    expect(result.stage).toBe('list')
    expect(result.error).toContain('403')
    expect(refreshCalls(fetchMock)).toHaveLength(0)
  })

  it('reports a failed refresh as a distinct stage from a failed listing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        webhookPage(
          [
            {
              id: 10000,
              url: 'https://app.example/hook',
              jqlFilter: 'project = 10001',
              events: ['jira:issue_updated'],
            },
          ],
          { startAt: 0, maxResults: 100, total: 1, isLast: true }
        )
      )
      .mockResolvedValueOnce(errorResponse(400, ['Returned if the request is invalid']))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    // A 400 here means every listed webhook keeps its old 30-day clock. It has
    // to reach `lastError`, not be mistaken for "renewed 1".
    expect(result.status).toBe('failed')
    expect(result.stage).toBe('refresh')
    expect(result.error).toContain('400')
  })

  it('reports a transport failure as failed instead of rejecting', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshJiraWebhooks(TOKEN, CLOUD_ID)

    // A rejected promise inside a periodic job is the silent-death shape that
    // T-010 exists to remove.
    expect(result.status).toBe('failed')
    expect(result.stage).toBe('list')
    expect(result.error).toContain('ECONNRESET')
  })
})
