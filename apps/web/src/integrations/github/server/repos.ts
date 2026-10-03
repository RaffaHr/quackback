import { integrationFetch } from '@/lib/server/integrations/sync/transport'
import { nextPageUrl } from '@/integrations/github/server/pagination'
/**
 * GitHub repository listing via REST API.
 */

const GITHUB_API = 'https://api.github.com'

/**
 * GitHub caps a list page at 100 items (a larger `per_page` is silently
 * clamped) and the only end-of-list signal is the absence of `link`
 * `rel="next"` — there is no total-count header. So traversal is bounded here
 * instead: 20 pages is 2000 repositories, well past any real account.
 */
const MAX_REPO_PAGES = 20

/**
 * List GitHub repositories accessible to the authenticated user.
 *
 * Follows `link` `rel="next"` at the URL GitHub hands over — the defaults for
 * `visibility`, `affiliation` and `type` already yield the maximum set, and
 * passing `type` alongside either of the others is a guaranteed 422.
 */
export async function listGitHubRepos(
  accessToken: string
): Promise<Array<{ id: number; fullName: string; private: boolean }>> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'quackback',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  const repos: Array<{ id: number; fullName: string; private: boolean }> = []
  let nextUrl: string | null = `${GITHUB_API}/user/repos?sort=updated&per_page=100`
  let pages = 0

  while (nextUrl) {
    if (pages >= MAX_REPO_PAGES) {
      throw new Error(
        `GitHub still reported more repositories after ${MAX_REPO_PAGES} pages ` +
          `(${MAX_REPO_PAGES * 100}+). Returning the list here would hide the rest, so nothing ` +
          'is returned: connect an account or installation scoped to fewer repositories, or ' +
          'raise the page limit in integrations/github/server/repos.ts.'
      )
    }

    const response = await integrationFetch(nextUrl, { headers })
    if (!response.ok) {
      throw new Error(`Failed to list GitHub repos: HTTP ${response.status}`)
    }

    const data = (await response.json()) as Array<{
      id: number
      full_name: string
      private: boolean
    }>

    for (const repo of data) {
      repos.push({ id: repo.id, fullName: repo.full_name, private: repo.private })
    }

    nextUrl = nextPageUrl(response)
    pages++
  }

  return repos
}
