# Migrations — read before changing a SHARED table

**A schema change to a table the API also maps will freeze synthwatch-api merges — deliberately.**
synthwatch-api's required **schema-parity** CI gate (its `schema-parity` workflow, required since
synthwatch-api #167) checks out THIS repo at `@main` and diffs the runner schema against the API's
test fixture. So when a migration here changes a shared table, the api's gate goes red and holds
every api merge until `tests/**/fixtures/schema.sql` over there is patched to match — expect to
ship that fixture patch in the same or an immediately-following synthwatch-api PR. Which tables are
shared: the ones the api maps — its `DbContext` (or, equivalently, its `fixtures/schema.sql`) is
the authoritative list. This is drift-forcing by design, not a bug: it exists to catch the
incident-2 class where runner-schema/api-fixture drift shipped a prod 500. If api merges are
frozen and you recently merged a migration here, the diagnosis is "I touched a shared table," and
the fix is the api fixture patch — not reverting the migration.
