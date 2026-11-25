-- Runner wird beendet und lässt laufende Läufe noch fertig werden (Heartbeat `draining`, Runner-Option
-- `DRAIN_SEC`): Der Scheduler bietet ihm keine neuen Läufe an. Die nächste Anmeldung setzt den Wert zurück.
ALTER TABLE runner ADD COLUMN IF NOT EXISTS draining boolean NOT NULL DEFAULT false;
