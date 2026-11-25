-- Zeitpunkt, zu dem die Branches eines gemergten PR (inkl. Teilauftrags-Branches) auf dem Remote gelöscht
-- wurden. NULL = noch nicht aufgeräumt (der PR-Abgleich versucht es erneut).
ALTER TABLE pull_request ADD COLUMN IF NOT EXISTS branch_deleted_at timestamptz;
