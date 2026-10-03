/**
 * GitHub list pagination.
 *
 * Every GitHub list endpoint is paginated, a `per_page` above 100 is silently
 * clamped, and there is no total-count header — the only end-of-list signal is
 * the absence of `link` `rel="next"`. Reading a single page therefore truncates
 * with no client-visible symptom, so callers walk the header instead.
 */

// `link` is a comma-separated list of `<url>; rel="..."` entries and the one
// tagged `next` is not always the first — on a middle page `prev` precedes it.
// `[^,<>]*` keeps the scan inside a single entry.
const NEXT_LINK_RE = /<([^>]+)>\s*;[^,<>]*\brel\s*=\s*"?next"?/

/** The `rel="next"` URL of a response's `link` header, or null at the last page. */
export function nextPageUrl(response: Response): string | null {
  const link = response.headers.get('link')
  return (link && NEXT_LINK_RE.exec(link)?.[1]) || null
}
