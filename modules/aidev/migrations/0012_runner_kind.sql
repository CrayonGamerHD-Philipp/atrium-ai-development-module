-- Runner auf dem PC des Nutzers (`kind = 'desktop'`, Anmeldung `registerInput.kind`) bekommen Aufträge vor
-- Server-Runnern; `priority` = Vorrang durch die Verwaltung (NULL = automatisch nach Art: desktop 10, server 0).
-- `run.handoff`: Übergabe-Infos eines Laufs, den ein PC-Runner vor Standby/Herunterfahren abgegeben hat
-- (reason, wipPushed, headSha, note, runnerName) – der nächste Lauf setzt auf dem WIP-Commit fort.
ALTER TABLE runner ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'server'
	CHECK (kind IN ('server', 'desktop'));
ALTER TABLE runner ADD COLUMN IF NOT EXISTS priority integer NULL;
ALTER TABLE run ADD COLUMN IF NOT EXISTS handoff jsonb NULL;
