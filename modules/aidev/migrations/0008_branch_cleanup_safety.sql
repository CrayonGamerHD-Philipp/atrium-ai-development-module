-- Absicherung des automatischen Branch-Aufräumens:
-- head_sha: letzter Head-Commit des PR (nur dieser Stand wird gelöscht).
-- cross_repository: Head-Branch liegt in einem Fork (true) bzw. im Ziel-Repository (false); NULL = unbekannt
-- (ältere Runner) – nur false wird aufgeräumt.
-- branch_cleanup_after: frühester nächster Aufräumversuch (zurückgehaltene PRs rotieren nach hinten).
ALTER TABLE pull_request ADD COLUMN IF NOT EXISTS head_sha text;
ALTER TABLE pull_request ADD COLUMN IF NOT EXISTS cross_repository boolean;
ALTER TABLE pull_request ADD COLUMN IF NOT EXISTS branch_cleanup_after timestamptz;

-- Branches, die das Aufräumen gerade löscht: Der Scheduler legt für sie keine Läufe an (weder als Branch noch als
-- Basis), bis der Eintrag entfernt wird oder abläuft. Angelegt unter der Sperre der Branch-Vergabe.
CREATE TABLE IF NOT EXISTS branch_cleanup_claim (
	project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	branch text NOT NULL,
	expires_at timestamptz NOT NULL,
	PRIMARY KEY (project_id, branch)
);
