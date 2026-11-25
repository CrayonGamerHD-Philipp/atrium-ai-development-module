-- Hochgeladene Dateien und ihre geordneten Zuordnungen zu Aufträgen und Chatnachrichten.
-- Benutzer-IDs liegen im Core-Schema und erhalten keinen Fremdschlüssel.
CREATE TABLE IF NOT EXISTS attachment (
	id uuid PRIMARY KEY,
	project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	uploaded_by text NULL,
	name text NOT NULL,
	mime text NOT NULL,
	size integer NOT NULL,
	sha256 text NOT NULL,
	bytes bytea NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT attachment_size_check CHECK (size BETWEEN 1 AND 10485760),
	CONSTRAINT attachment_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT attachment_bytes_check CHECK (octet_length(bytes) = size)
);
CREATE INDEX IF NOT EXISTS attachment_project_created_idx ON attachment (project_id, created_at);

CREATE TABLE IF NOT EXISTS task_attachment (
	task_id uuid NOT NULL REFERENCES task (id) ON DELETE CASCADE,
	attachment_id uuid NOT NULL REFERENCES attachment (id) ON DELETE CASCADE,
	position integer NOT NULL,
	PRIMARY KEY (task_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS task_attachment_attachment_idx ON task_attachment (attachment_id);

CREATE TABLE IF NOT EXISTS chat_attachment (
	chat_message_id uuid NOT NULL REFERENCES chat_message (id) ON DELETE CASCADE,
	attachment_id uuid NOT NULL REFERENCES attachment (id) ON DELETE CASCADE,
	position integer NOT NULL,
	PRIMARY KEY (chat_message_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS chat_attachment_attachment_idx ON chat_attachment (attachment_id);
