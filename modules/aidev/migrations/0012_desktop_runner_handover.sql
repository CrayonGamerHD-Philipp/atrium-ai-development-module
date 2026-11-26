-- PC-Runner (Desktop) mit Vorrang, geordneter Übergabe an Server-Runner und Fencing je Lauf.
--
-- runner.kind           vom Runner gemeldete Art (`registerInput.kind`, ältere Runner: server)
-- runner.kind_override  Art laut Verwaltung (NULL = wie gemeldet)
-- runner.priority       Vorrang laut Verwaltung (NULL = automatisch nach Art: desktop 10, server 0)
-- runner.lease_sec      Heartbeat-Zeitlimit laufender Läufe (NULL = Standard nach Art: desktop 60 s, server 90 s)
-- runner.protocol       zuletzt gemeldete Protokollversion (Hinweis „inkompatibel/Update“)
-- runner.handover_*     laufende bzw. letzte Übergabe (Standby, Herunterfahren, manuell); die nächste Anmeldung
--                       bzw. ein Heartbeat ohne `handover` setzt sie zurück und vermerkt `returned_at`
-- task.lease_epoch      Fencing-Token des Auftrags: jedes Angebot erhöht ihn, der Lauf trägt ihn als `run.fence`
-- run.handoff           Übergabe-Infos (reason, wipPushed, runnerName, runnerKind, note)
-- run.wip_ref/wip_sha   Zwischenstand des Laufs (`refs/aidev/wip/<runId>`, Übergabe oder Checkpoint)
-- run.resumed_from      Lauf, dessen Zwischenstand dieser Lauf fortsetzt
ALTER TABLE runner ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'server';
ALTER TABLE runner ADD COLUMN IF NOT EXISTS kind_override text NULL;
ALTER TABLE runner ADD COLUMN IF NOT EXISTS priority integer NULL;
ALTER TABLE runner ADD COLUMN IF NOT EXISTS lease_sec integer NULL;
ALTER TABLE runner ADD COLUMN IF NOT EXISTS protocol integer NULL;
ALTER TABLE runner ADD COLUMN IF NOT EXISTS handover_reason text NULL;
ALTER TABLE runner ADD COLUMN IF NOT EXISTS handover_at timestamptz NULL;
ALTER TABLE runner ADD COLUMN IF NOT EXISTS returned_at timestamptz NULL;
ALTER TABLE runner DROP CONSTRAINT IF EXISTS runner_kind_check;
ALTER TABLE runner ADD CONSTRAINT runner_kind_check CHECK (kind IN ('server', 'desktop'));
ALTER TABLE runner DROP CONSTRAINT IF EXISTS runner_kind_override_check;
ALTER TABLE runner ADD CONSTRAINT runner_kind_override_check
	CHECK (kind_override IS NULL OR kind_override IN ('server', 'desktop'));
ALTER TABLE runner DROP CONSTRAINT IF EXISTS runner_lease_sec_check;
ALTER TABLE runner ADD CONSTRAINT runner_lease_sec_check
	CHECK (lease_sec IS NULL OR lease_sec BETWEEN 30 AND 900);

ALTER TABLE task ADD COLUMN IF NOT EXISTS lease_epoch integer NOT NULL DEFAULT 0;

ALTER TABLE run ADD COLUMN IF NOT EXISTS fence integer NULL;
ALTER TABLE run ADD COLUMN IF NOT EXISTS handoff jsonb NULL;
ALTER TABLE run ADD COLUMN IF NOT EXISTS wip_ref text NULL;
ALTER TABLE run ADD COLUMN IF NOT EXISTS wip_sha text NULL;
ALTER TABLE run ADD COLUMN IF NOT EXISTS resumed_from uuid NULL;
