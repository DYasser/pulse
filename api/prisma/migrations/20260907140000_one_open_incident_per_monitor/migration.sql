-- At most one open incident per monitor.
--
-- The worker's check-then-insert in recordFailure is not transactional, so two
-- processes probing the same monitor can both see no open incident and both insert
-- one. resolveOpenIncident closes a single row, leaving the other open forever and
-- the monitor reading as permanently down.
--
-- Written by hand because Prisma's schema language cannot express a partial index.
CREATE UNIQUE INDEX "incidents_one_open_per_monitor"
  ON "incidents" ("monitor_id")
  WHERE "resolved_at" IS NULL;
