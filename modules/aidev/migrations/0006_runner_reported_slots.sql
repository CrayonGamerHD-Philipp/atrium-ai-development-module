-- Zuletzt vom Runner gemeldetes MAX_SLOTS: ändert sich der gemeldete Wert (z. B. nach einer
-- Konfigurationsänderung), übernimmt die Anmeldung ihn in `max_slots`. Ein von der Verwaltung
-- gesetzter Wert bleibt erhalten, solange der Runner denselben Wert meldet. NULL = noch nie
-- gemeldet (bestehende Runner übernehmen ihren Wert bei der nächsten Anmeldung).
ALTER TABLE runner ADD COLUMN IF NOT EXISTS reported_max_slots integer NULL;
