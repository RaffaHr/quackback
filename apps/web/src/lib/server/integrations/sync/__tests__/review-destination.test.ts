/**
 * `reviewDestination` answers "which destination does this link belong to?"
 * before a refresh, archive or status push is queued against it. The answer
 * becomes the operation's destination, and its hash the operation's key.
 *
 * It used to compare the link against the ONE destination `config.channelId`
 * named, so a link created in any other destination read back as unverified —
 * and was then inspected with the wrong repository's credentials, or not at
 * all. With several destinations that is the common case, not an edge (T-003).
 *
 * It stays a pure function: the caller hands it the installation's
 * destinations, already keyed, so this suite needs no database.
 */
import { describe, expect, it } from 'vitest'
import { installationIdentity, reviewDestination, syncDestination, syncHash } from '../identity'

// Only the scope keys matter to the key; a stub keeps this free of the registry.
const definition = { destination: { scopeKeys: ['organizationName'] as const } }

const integration = {
  id: 'integration_01jxreviewdestination00000000',
  connectedAt: new Date('2026-01-15T12:00:00.000Z'),
  config: { channelId: 'acme/api', organizationName: 'acme' },
  integrationType: 'github',
}

function destinationFor(externalRef: string) {
  const destination = syncDestination(
    { channelId: externalRef },
    integration.config as Record<string, unknown>,
    definition
  )
  return { destination, destinationKey: syncHash(destination) }
}

const api = destinationFor('acme/api')
const web = destinationFor('acme/web')
const scopeOf = (d: { destinationKey: string }) =>
  `${installationIdentity(integration)}:${d.destinationKey}`

describe('reviewDestination', () => {
  it('resolves a link that belongs to a destination other than config.channelId', () => {
    // The property this ticket exists for. config.channelId names acme/api; the
    // link was created in acme/web. It must resolve to acme/web, not read back
    // as unverified because it is not the legacy default.
    const link = { id: 'post_external_link_web', syncScope: scopeOf(web) }

    const result = reviewDestination(link, integration, [api, web])

    expect(result).toEqual(web.destination)
  })

  it('still resolves a link in the legacy default destination', () => {
    const link = { id: 'post_external_link_api', syncScope: scopeOf(api) }

    expect(reviewDestination(link, integration, [api, web])).toEqual(api.destination)
  })

  it('degrades to an unverified envelope when the destination no longer exists', () => {
    // Removed, or the connection moved org. Degrading is allowed; guessing the
    // nearest destination is not — that is how a link gets inspected with
    // another repository's credentials.
    const removed = destinationFor('acme/removed')
    const link = { id: 'post_external_link_gone', syncScope: scopeOf(removed) }

    expect(reviewDestination(link, integration, [api, web])).toEqual({
      unverifiedLink: syncHash(link.id),
      previousScope: syncHash(link.syncScope),
    })
  })

  it('does not accept a matching key from a previous connection of the installation', () => {
    // Same destination key, different installation identity (a reconnect moves
    // connectedAt). A key alone must not verify a link across connections.
    const earlier = { ...integration, connectedAt: new Date('2025-06-01T00:00:00.000Z') }
    const link = {
      id: 'post_external_link_old',
      syncScope: `${installationIdentity(earlier)}:${web.destinationKey}`,
    }

    expect(reviewDestination(link, integration, [api, web])).toEqual({
      unverifiedLink: syncHash(link.id),
      previousScope: syncHash(link.syncScope),
    })
  })
})
