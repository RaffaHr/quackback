CREATE TABLE IF NOT EXISTS "integration_destinations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "integration_id" uuid NOT NULL CONSTRAINT "integration_destinations_integration_fk" REFERENCES "integrations"("id") ON DELETE CASCADE,
  "external_ref" text NOT NULL,
  "display_label" text,
  "scope" varchar(16) DEFAULT 'workspace' NOT NULL,
  "external_webhook_id" text,
  "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "integration_destinations_ref_unique" UNIQUE("external_ref","integration_id"),
  CONSTRAINT "integration_destinations_scope_known" CHECK (scope IN ('workspace', 'teams'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_destinations_integration_idx" ON "integration_destinations" ("integration_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_destination_teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "destination_id" uuid NOT NULL CONSTRAINT "integration_destination_teams_destination_fk" REFERENCES "integration_destinations"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL CONSTRAINT "integration_destination_teams_team_fk" REFERENCES "teams"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_destination_teams_unique_idx" ON "integration_destination_teams" ("destination_id","team_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_destination_teams_team_idx" ON "integration_destination_teams" ("team_id");
--> statement-breakpoint
-- @replay: guarded by ON CONFLICT on the (external_ref, integration_id) unique
-- constraint; re-running adds nothing. Only providers that pin a destination in
-- config.channelId are seeded, and only while they still hold one.
--
-- external_ref mirrors config.channelId EXACTLY, for every provider. That is
-- what keeps this migration free of observable behavior: the destination key is
-- derived from external_ref by the same function that derived it from
-- config.channelId, so every existing sync_scope keeps matching byte for byte.
--
-- Jira's "projectId:issueTypeId" is deliberately NOT split here. Splitting it
-- changes Jira's destination key (so existing links stop matching until their
-- sync_scope is rewritten) and removes the issue type the Jira hook reads out of
-- that same string (so issue creation would lose it). Both halves of that change
-- have to land together, with the sync_scope backfill, and they do in T-006.
--
-- No destination hash is computed here on purpose: sync_scope folds in the
-- installation's own scope keys and is produced by a canonical-JSON SHA-256 in
-- application code. The key stays derived.
INSERT INTO "integration_destinations" ("integration_id", "external_ref", "display_label")
SELECT
  i."id",
  i."config"->>'channelId',
  CASE WHEN i."integration_type" = 'github' THEN i."config"->>'channelId' ELSE NULL END
FROM "integrations" i
WHERE i."integration_type" IN ('github', 'jira')
  AND i."config"->>'channelId' IS NOT NULL
  AND i."config"->>'channelId' <> ''
ON CONFLICT ON CONSTRAINT "integration_destinations_ref_unique" DO NOTHING;
--> statement-breakpoint
-- @replay: idempotent copy of the single webhook id each seeded install already
-- holds. GitHub registers one hook per repository, so the id belongs to the
-- destination. Jira registers ONE webhook per connection covering every project
-- (5-webhook OAuth cap, R-0002/P2), so its id stays on the integration row and
-- is deliberately not copied here.
UPDATE "integration_destinations" d
   SET "external_webhook_id" = i."config"->>'externalWebhookId'
  FROM "integrations" i
 WHERE i."id" = d."integration_id"
   AND i."integration_type" = 'github'
   AND i."config"->>'externalWebhookId' IS NOT NULL
   AND d."external_webhook_id" IS NULL;
