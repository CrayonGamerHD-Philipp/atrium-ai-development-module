-- Schutz gegen einen doppelt verwendeten API-Key (zwei Runner-Installationen unter einem Key).
--
-- runner.instance_id           Kennung der zuletzt angemeldeten Installation (`registerInput.instanceId`, ältere
--                              Runner: NULL, dann keine Prüfung)
-- runner.instance_conflict_at  letzte abgelehnte Anmeldung einer anderen Installation (Hinweis auf der Runner-Seite)
-- runner.instance_conflict_name Name, mit dem sich die abgelehnte Installation gemeldet hat
ALTER TABLE runner ADD COLUMN IF NOT EXISTS instance_id text NULL;
ALTER TABLE runner ADD COLUMN IF NOT EXISTS instance_conflict_at timestamptz NULL;
ALTER TABLE runner ADD COLUMN IF NOT EXISTS instance_conflict_name text NULL;
