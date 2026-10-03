import { integrationFetch } from '@/lib/server/integrations/sync/transport'
import { nextPageUrl } from '@/integrations/github/server/pagination'
/**
 * GitHub webhook registration.
 *
 * Uses GitHub REST API to create/delete webhooks for issue status sync.
 */

const GITHUB_API = 'https://api.github.com'

/**
 * Hook listing is paginated like every GitHub list endpoint, and the only
 * end-of-list signal is the absence of `link` `rel="next"`. Traversal is
 * bounded here: 20 pages is 2000 hooks on a single repository.
 */
const MAX_HOOK_PAGES = 20

interface GitHubWebhookResult {
  webhookId: string
}

const githubHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'quackback',
  'X-GitHub-Api-Version': '2022-11-28',
})

/**
 * Register a webhook with GitHub. `events` is computed from live inbox
 * state, never hardcoded, so reconnect cannot silently drop issue comments.
 */
export async function registerGitHubWebhook(
  accessToken: string,
  ownerRepo: string,
  callbackUrl: string,
  secret: string,
  events: string[] = ['issues']
): Promise<GitHubWebhookResult> {
  const response = await fetch(`${GITHUB_API}/repos/${ownerRepo}/hooks`, {
    method: 'POST',
    headers: githubHeaders(accessToken),
    body: JSON.stringify({
      name: 'web',
      active: true,
      events,
      config: {
        url: callbackUrl,
        content_type: 'json',
        secret,
        insecure_ssl: '0',
      },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API error ${response.status}: ${body}`)
  }

  const hook = (await response.json()) as { id: number }
  return { webhookId: String(hook.id) }
}

/** PATCH an existing hook's events (and optionally its callback config). */
export async function patchGitHubWebhook(
  accessToken: string,
  ownerRepo: string,
  webhookId: string,
  events: string[],
  callbackUrl?: string,
  secret?: string
): Promise<void> {
  const body: Record<string, unknown> = { active: true, events }
  if (callbackUrl) {
    body.config = {
      url: callbackUrl,
      content_type: 'json',
      ...(secret ? { secret } : {}),
      insecure_ssl: '0',
    }
  }
  const response = await fetch(`${GITHUB_API}/repos/${ownerRepo}/hooks/${webhookId}`, {
    method: 'PATCH',
    headers: githubHeaders(accessToken),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GitHub API error ${response.status}: ${text}`)
  }
}

/**
 * Locate an existing hook by callback URL, walking `link` `rel="next"`.
 *
 * A hook past the first page used to read back as "no hook", which is the
 * dangerous direction: the caller then registers a duplicate. Exhausting the
 * page budget throws for the same reason — a `null` there would be a lie.
 */
export async function findGitHubWebhookByUrl(
  accessToken: string,
  ownerRepo: string,
  callbackUrl: string
): Promise<string | null> {
  let nextUrl: string | null = `${GITHUB_API}/repos/${ownerRepo}/hooks?per_page=100`
  let pages = 0

  while (nextUrl) {
    if (pages >= MAX_HOOK_PAGES) {
      throw new Error(
        `GitHub still reported more webhooks on ${ownerRepo} after ${MAX_HOOK_PAGES} pages ` +
          `(${MAX_HOOK_PAGES * 100}+). Reporting "not found" here would register a duplicate ` +
          'hook: remove the unused webhooks on that repository, then retry.'
      )
    }

    const response = await integrationFetch(nextUrl, { headers: githubHeaders(accessToken) })
    if (!response.ok) return null
    const hooks = (await response.json()) as Array<{ id: number; config?: { url?: string } }>
    const match = hooks.find((h) => h.config?.url === callbackUrl)
    if (match) return String(match.id)

    nextUrl = nextPageUrl(response)
    pages++
  }

  return null
}

/**
 * Delete a webhook from GitHub.
 */
export async function deleteGitHubWebhook(
  accessToken: string,
  ownerRepo: string,
  webhookId: string
): Promise<void> {
  await fetch(`${GITHUB_API}/repos/${ownerRepo}/hooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'quackback',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
}
