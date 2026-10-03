import {
  pgTable,
  text,
  timestamp,
  jsonb,
  varchar,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { typeIdWithDefault, typeIdColumn } from '@quackback/ids/drizzle'
import { integrations } from './integrations'
import { teams } from './teams'

/**
 * A place a tracker integration creates work in: one GitHub repository, one
 * Jira project, one Linear team.
 *
 * Before this table an installation had exactly one, held in `config.channelId`,
 * and everything downstream inherited that limit. The row is additive:
 * `config.channelId` stays written as the compatibility default, so a rollback
 * loses no links.
 *
 * **The destination key is derived, never stored.** `sync_scope` on a link is
 * `installation:syncHash(syncDestination(...))`, and that hash folds in the
 * installation's own scope keys (GitHub's `organizationName`, Jira's `cloudId`)
 * — which live on the integration row, not here. A stored copy would be a
 * second source of truth that goes stale the moment the connection is moved to
 * another org, and re-deriving it in SQL would mean reimplementing the
 * canonical-JSON hash in a second language. So the key is computed from
 * `externalRef` by the same function that always computed it, and stays
 * byte-identical to existing `sync_scope` values by construction rather than by
 * careful replication.
 */
export const integrationDestinations = pgTable(
  'integration_destinations',
  {
    id: typeIdWithDefault('integration_destination')('id').primaryKey(),
    integrationId: typeIdColumn('integration')('integration_id').notNull(),

    /**
     * The provider's own reference, exactly as `config.channelId` held it:
     * `owner/repo` for GitHub, the project id for Jira. This is the value the
     * destination hash is derived from, so it must not be reformatted.
     */
    externalRef: text('external_ref').notNull(),

    /** Human-friendly label for pickers and history; falls back to externalRef. */
    displayLabel: text('display_label'),

    /**
     * Who may target this destination by hand. `workspace` = anyone authorized
     * to push; `teams` = only members of the linked teams. Explicit rather than
     * inferred from the absence of team rows, so "open to everyone" is always a
     * decision someone made (see ADR-0001).
     */
    scope: varchar('scope', { length: 16 }).notNull().default('workspace'),

    /**
     * Webhook identity for this destination, when the provider registers one
     * per destination (GitHub). Jira registers a single webhook per connection
     * covering every project, so its destinations leave this null.
     */
    externalWebhookId: text('external_webhook_id'),

    /**
     * Creation-time settings that are NOT identity — Jira's issue type is the
     * case that forced the distinction: it decides what to create, it changes
     * over an issue's life, and folding it into identity broke status sync
     * silently (SPEC-0001, D-4).
     */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'integration_destinations_integration_fk',
      columns: [table.integrationId],
      foreignColumns: [integrations.id],
    }).onDelete('cascade'),
    // Columns listed alphabetically: drizzle-kit introspects multi-column
    // UNIQUE constraints in alphabetical order and the drift check compares
    // that order (same reason as integrations.ts).
    unique('integration_destinations_ref_unique').on(table.externalRef, table.integrationId),
    check('integration_destinations_scope_known', sql`scope IN ('workspace', 'teams')`),
    index('integration_destinations_integration_idx').on(table.integrationId),
  ]
)

/**
 * Which teams may target a destination, for `scope = 'teams'`.
 *
 * Many-to-many on purpose: a repository shared by two teams would otherwise
 * have to pick one and lock the other out, or go workspace-wide and lock nobody
 * out — and neither is the separation this exists to provide (ADR-0001).
 */
export const integrationDestinationTeams = pgTable(
  'integration_destination_teams',
  {
    id: typeIdWithDefault('integration_destination_team')('id').primaryKey(),
    destinationId: typeIdColumn('integration_destination')('destination_id').notNull(),
    teamId: typeIdColumn('team')('team_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'integration_destination_teams_destination_fk',
      columns: [table.destinationId],
      foreignColumns: [integrationDestinations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'integration_destination_teams_team_fk',
      columns: [table.teamId],
      foreignColumns: [teams.id],
    }).onDelete('cascade'),
    uniqueIndex('integration_destination_teams_unique_idx').on(table.destinationId, table.teamId),
    index('integration_destination_teams_team_idx').on(table.teamId),
  ]
)

export const integrationDestinationsRelations = relations(
  integrationDestinations,
  ({ one, many }) => ({
    integration: one(integrations, {
      fields: [integrationDestinations.integrationId],
      references: [integrations.id],
    }),
    teams: many(integrationDestinationTeams),
  })
)

export const integrationDestinationTeamsRelations = relations(
  integrationDestinationTeams,
  ({ one }) => ({
    destination: one(integrationDestinations, {
      fields: [integrationDestinationTeams.destinationId],
      references: [integrationDestinations.id],
    }),
    team: one(teams, {
      fields: [integrationDestinationTeams.teamId],
      references: [teams.id],
    }),
  })
)
