-- Initialize extensions
-- This runs after the database is created

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS vector;

-- Grant usage to the bootstrap role, whatever it is called.
--
-- CURRENT_USER and not a literal `postgres`: the entrypoint runs this script as
-- POSTGRES_USER, which the prod compose takes from the environment. Naming the
-- role here works only while that value happens to be `postgres` (as in the dev
-- compose) and fails with `role "postgres" does not exist` for every other
-- value — and because the entrypoint runs init scripts with ON_ERROR_STOP=1,
-- that error aborts initialization and restarts the container mid-bootstrap.
GRANT USAGE ON SCHEMA cron TO CURRENT_USER;
