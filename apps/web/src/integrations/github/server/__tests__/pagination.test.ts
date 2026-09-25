import { describe, expect, it, vi, afterEach } from 'vitest'
import { listGitHubRepos } from '../repos'
import { findGitHubWebhookByUrl } from '../webhook-registration'

/**
 * T-009 seam (R-0002 / P4 / R5).
 *
 * Both GitHub list endpoints used here are paginated and the ONLY end-of-list
 * signal is the absence of `rel="next"` in the `link` header: there is no
 * total-count header, and a `per_page` above 100 is silently clamped to 100.
 * So a single `per_page=100` call truncates with no client-visible symptom.
 *
 * These tests pin the traversal contract, not an implementation:
 *  - the follow-up request uses the URL the `link` header hands over
 *    (no hand-built `page=N`);
 *  - traversal ends when `rel="next"` is gone, even if the header still
 *    carries `prev`/`first`/`last`;
 *  - the pages are concatenated in order.
 *
 * Mock shape: a real `Headers` instance, so `headers.get('link')` is
 * case-insensitive exactly like the runtime response. The assertions read the
 * request URL through `String(...)` and the auth header through a tolerant
 * accessor, so passing a `URL` object or a `Headers` init is just as valid as
 * a plain string / object literal.
 */
function githubPage(body: unknown, link?: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(link ? { link } : {}),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/** Reads Authorization from either a plain object init or a Headers init. */
function authorizationOf(init: unknown): string | undefined {
  const headers = (init as { headers?: unknown } | undefined)?.headers
  if (!headers) return undefined
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get('authorization') ?? undefined
  }
  const record = headers as Record<string, string>
  return record.Authorization ?? record.authorization
}

const requestedUrl = (call: unknown[]) => String(call[0])

// ---------------------------------------------------------------------------
// S-A — listGitHubRepos
// ---------------------------------------------------------------------------

const REPOS_PAGE_2_URL = 'https://api.github.com/user/repos?sort=updated&per_page=100&page=2'

/** First page: `next` first, as GitHub sends it on page 1. */
const REPOS_LINK_PAGE_1 =
  `<${REPOS_PAGE_2_URL}>; rel="next", ` +
  '<https://api.github.com/user/repos?sort=updated&per_page=100&page=5>; rel="last"'

/**
 * Middle page: `prev` comes BEFORE `next`. Catches the classic parse bug of
 * taking the first `<...>` in the header instead of the one tagged `next`.
 */
const REPOS_LINK_PREV_BEFORE_NEXT =
  '<https://api.github.com/user/repos?sort=updated&per_page=100&page=1>; rel="prev", ' +
  `<${REPOS_PAGE_2_URL}>; rel="next", ` +
  '<https://api.github.com/user/repos?sort=updated&per_page=100&page=1>; rel="first"'

/**
 * Last page: a `link` header IS present, but with no `rel="next"`. Treating
 * "header exists" as "there is more" loops forever here.
 */
const REPOS_LINK_NO_NEXT =
  '<https://api.github.com/user/repos?sort=updated&per_page=100&page=1>; rel="prev", ' +
  '<https://api.github.com/user/repos?sort=updated&per_page=100&page=1>; rel="first", ' +
  '<https://api.github.com/user/repos?sort=updated&per_page=100&page=2>; rel="last"'

const REPOS_PAGE_1 = [
  { id: 1, full_name: 'acme/first-page-a', private: false },
  { id: 2, full_name: 'acme/first-page-b', private: true },
]
const REPOS_PAGE_2 = [
  { id: 3, full_name: 'acme/second-page-a', private: false },
  { id: 4, full_name: 'acme/second-page-b', private: true },
]

describe('listGitHubRepos pagination', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns repositories from every page while link rel="next" is present', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(githubPage(REPOS_PAGE_1, REPOS_LINK_PAGE_1))
      .mockResolvedValueOnce(githubPage(REPOS_PAGE_2))
    vi.stubGlobal('fetch', fetchMock)

    const repos = await listGitHubRepos('tok')

    expect(repos.map((repo) => repo.fullName)).toEqual([
      'acme/first-page-a',
      'acme/first-page-b',
      'acme/second-page-a',
      'acme/second-page-b',
    ])
    expect(repos.map((repo) => repo.id)).toEqual([1, 2, 3, 4])
    expect(repos.map((repo) => repo.private)).toEqual([false, true, false, true])
  })

  it('requests the next page at the URL the link header gives, not a hand-built page=N', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(githubPage(REPOS_PAGE_1, REPOS_LINK_PAGE_1))
      .mockResolvedValueOnce(githubPage(REPOS_PAGE_2))
    vi.stubGlobal('fetch', fetchMock)

    await listGitHubRepos('tok')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestedUrl(fetchMock.mock.calls[1])).toBe(REPOS_PAGE_2_URL)
  })

  it('keeps sending credentials on the follow-up page request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(githubPage(REPOS_PAGE_1, REPOS_LINK_PAGE_1))
      .mockResolvedValueOnce(githubPage(REPOS_PAGE_2))
    vi.stubGlobal('fetch', fetchMock)

    await listGitHubRepos('tok')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(authorizationOf(fetchMock.mock.calls[1][1])).toBe('Bearer tok')
  })

  it('picks the rel="next" URL even when another rel comes first in the header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(githubPage(REPOS_PAGE_1, REPOS_LINK_PREV_BEFORE_NEXT))
      .mockResolvedValueOnce(githubPage(REPOS_PAGE_2))
    vi.stubGlobal('fetch', fetchMock)

    const repos = await listGitHubRepos('tok')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestedUrl(fetchMock.mock.calls[1])).toBe(REPOS_PAGE_2_URL)
    expect(repos.map((repo) => repo.fullName)).toContain('acme/second-page-a')
  })

  it('stops when a link header is present but carries no rel="next"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(githubPage(REPOS_PAGE_1, REPOS_LINK_NO_NEXT))
    vi.stubGlobal('fetch', fetchMock)

    const repos = await listGitHubRepos('tok')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(repos.map((repo) => repo.fullName)).toEqual(['acme/first-page-a', 'acme/first-page-b'])
  })

  it('stops after a single request when there is no link header at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(githubPage(REPOS_PAGE_1))
    vi.stubGlobal('fetch', fetchMock)

    const repos = await listGitHubRepos('tok')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(repos.map((repo) => repo.fullName)).toEqual(['acme/first-page-a', 'acme/first-page-b'])
  })
})

// ---------------------------------------------------------------------------
// S-B — findGitHubWebhookByUrl
// ---------------------------------------------------------------------------

const CALLBACK_URL = 'https://app.example/api/integrations/github/webhook'
const HOOKS_PAGE_2_URL = 'https://api.github.com/repos/acme/api/hooks?per_page=100&page=2'
const HOOKS_LINK_PAGE_1 =
  `<${HOOKS_PAGE_2_URL}>; rel="next", ` +
  '<https://api.github.com/repos/acme/api/hooks?per_page=100&page=2>; rel="last"'
const HOOKS_LINK_NO_NEXT =
  '<https://api.github.com/repos/acme/api/hooks?per_page=100&page=1>; rel="prev", ' +
  '<https://api.github.com/repos/acme/api/hooks?per_page=100&page=1>; rel="first"'

const HOOKS_PAGE_1 = [
  { id: 10, config: { url: 'https://app.example/some/other/hook' } },
  { id: 12, config: { url: 'https://elsewhere.example/hook' } },
]
const HOOKS_PAGE_2 = [{ id: 11, config: { url: CALLBACK_URL } }]

describe('findGitHubWebhookByUrl pagination', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('finds a hook that only appears on the second page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(githubPage(HOOKS_PAGE_1, HOOKS_LINK_PAGE_1))
      .mockResolvedValueOnce(githubPage(HOOKS_PAGE_2))
    vi.stubGlobal('fetch', fetchMock)

    const webhookId = await findGitHubWebhookByUrl('tok', 'acme/api', CALLBACK_URL)

    expect(webhookId).toBe('11')
  })

  it('requests the next hooks page at the URL the link header gives, with credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(githubPage(HOOKS_PAGE_1, HOOKS_LINK_PAGE_1))
      .mockResolvedValueOnce(githubPage(HOOKS_PAGE_2))
    vi.stubGlobal('fetch', fetchMock)

    await findGitHubWebhookByUrl('tok', 'acme/api', CALLBACK_URL)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestedUrl(fetchMock.mock.calls[1])).toBe(HOOKS_PAGE_2_URL)
    expect(authorizationOf(fetchMock.mock.calls[1][1])).toBe('Bearer tok')
  })

  it('stops when a link header is present but carries no rel="next"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(githubPage(HOOKS_PAGE_1, HOOKS_LINK_NO_NEXT))
    vi.stubGlobal('fetch', fetchMock)

    const webhookId = await findGitHubWebhookByUrl('tok', 'acme/api', CALLBACK_URL)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(webhookId).toBeNull()
  })
})
