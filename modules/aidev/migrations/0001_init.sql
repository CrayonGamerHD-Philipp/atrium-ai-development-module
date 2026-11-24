-- Modul aidev (KI-Entwicklung): Projekte, Runner, Anbieter-Konten, Aufträge, Läufe, Ereignisse, Verbrauch
-- Läuft mit search_path = mod_aidev; Benutzer-IDs ohne Fremdschlüssel (Core-Schema).

CREATE TABLE IF NOT EXISTS project (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	repo_owner text NOT NULL,
	repo_name text NOT NULL,
	default_branch text NOT NULL DEFAULT 'main',
	commit_policy text NOT NULL DEFAULT 'pr',
	max_parallel integer NOT NULL DEFAULT 2,
	setup_cmd text NOT NULL DEFAULT '',
	test_cmd text NOT NULL DEFAULT '',
	instructions text NOT NULL DEFAULT '',
	preferred_runner_id uuid NULL,
	created_by text NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	archived_at timestamptz NULL,
	CONSTRAINT project_commit_policy_check CHECK (commit_policy IN ('pr', 'pr-automerge', 'direct')),
	CONSTRAINT project_max_parallel_check CHECK (max_parallel BETWEEN 1 AND 20)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_repo_uniq ON project (lower(repo_owner), lower(repo_name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS runner (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	api_key_id text NOT NULL,
	status text NOT NULL DEFAULT 'pending',
	version text NOT NULL DEFAULT '',
	capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
	max_slots integer NOT NULL DEFAULT 2,
	slots_used integer NOT NULL DEFAULT 0,
	online boolean NOT NULL DEFAULT false,
	last_seen_at timestamptz NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT runner_status_check CHECK (status IN ('pending', 'approved', 'disabled')),
	CONSTRAINT runner_max_slots_check CHECK (max_slots BETWEEN 0 AND 64)
);
CREATE UNIQUE INDEX IF NOT EXISTS runner_api_key_uniq ON runner (api_key_id);

CREATE TABLE IF NOT EXISTS provider_account (
	id uuid PRIMARY KEY,
	runner_id uuid NOT NULL REFERENCES runner (id) ON DELETE CASCADE,
	key text NOT NULL,
	provider text NOT NULL,
	label text NOT NULL DEFAULT '',
	logged_in boolean NOT NULL DEFAULT false,
	models jsonb NOT NULL DEFAULT '[]'::jsonb,
	enabled boolean NOT NULL DEFAULT true,
	max_concurrency integer NOT NULL DEFAULT 1,
	budget_5h_units bigint NOT NULL DEFAULT 0,
	budget_week_units bigint NOT NULL DEFAULT 0,
	calibrated_5h_units bigint NULL,
	calibrated_week_units bigint NULL,
	week_anchor timestamptz NULL,
	context_k integer NOT NULL DEFAULT 200,
	default_model text NOT NULL DEFAULT '',
	cooldown_until timestamptz NULL,
	cooldown_reason text NULL,
	cooldown_strikes integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT provider_account_provider_check CHECK (provider IN ('claude', 'codex', 'gemini', 'openai-api', 'fake')),
	CONSTRAINT provider_account_max_concurrency_check CHECK (max_concurrency BETWEEN 0 AND 32)
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_account_runner_key_uniq ON provider_account (runner_id, key);
CREATE INDEX IF NOT EXISTS provider_account_runner_idx ON provider_account (runner_id);

CREATE TABLE IF NOT EXISTS task (
	id uuid PRIMARY KEY,
	project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	parent_id uuid NULL REFERENCES task (id) ON DELETE CASCADE,
	position integer NOT NULL DEFAULT 0,
	title text NOT NULL,
	prompt text NOT NULL,
	role text NOT NULL DEFAULT 'implement',
	status text NOT NULL DEFAULT 'queued',
	priority integer NOT NULL DEFAULT 0,
	max_attempts integer NOT NULL DEFAULT 3,
	attempts integer NOT NULL DEFAULT 0,
	required_context_k integer NOT NULL DEFAULT 0,
	provider_hint text NULL,
	excluded_account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	branch text NULL,
	base_ref text NULL,
	session_id text NULL,
	session_account_id uuid NULL,
	plan jsonb NULL,
	result_summary text NULL,
	error_message text NULL,
	pr_number integer NULL,
	pr_url text NULL,
	created_by text NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	started_at timestamptz NULL,
	finished_at timestamptz NULL,
	CONSTRAINT task_role_check CHECK (role IN ('orchestrate', 'research', 'implement', 'review', 'fix', 'resolve')),
	CONSTRAINT task_status_check CHECK (status IN ('draft', 'queued', 'blocked', 'running', 'review', 'done', 'failed', 'cancelled', 'needs-input')),
	CONSTRAINT task_provider_hint_check CHECK (provider_hint IS NULL OR provider_hint IN ('claude', 'codex', 'gemini', 'openai-api', 'fake')),
	CONSTRAINT task_priority_check CHECK (priority BETWEEN -10 AND 10),
	CONSTRAINT task_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 10)
);
CREATE INDEX IF NOT EXISTS task_project_idx ON task (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_parent_idx ON task (parent_id);
CREATE INDEX IF NOT EXISTS task_status_idx ON task (status);

CREATE TABLE IF NOT EXISTS task_dep (
	task_id uuid NOT NULL REFERENCES task (id) ON DELETE CASCADE,
	depends_on_id uuid NOT NULL REFERENCES task (id) ON DELETE CASCADE,
	PRIMARY KEY (task_id, depends_on_id),
	CONSTRAINT task_dep_self_check CHECK (task_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS task_dep_depends_on_idx ON task_dep (depends_on_id);

CREATE TABLE IF NOT EXISTS run (
	id uuid PRIMARY KEY,
	task_id uuid NOT NULL REFERENCES task (id) ON DELETE CASCADE,
	project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	attempt integer NOT NULL,
	runner_id uuid NULL REFERENCES runner (id) ON DELETE SET NULL,
	account_id uuid NULL REFERENCES provider_account (id) ON DELETE SET NULL,
	provider text NOT NULL,
	model text NOT NULL DEFAULT '',
	status text NOT NULL DEFAULT 'offered',
	lease_expires_at timestamptz NULL,
	session_id text NULL,
	head_sha text NULL,
	branch text NULL,
	error_kind text NULL,
	error_message text NULL,
	summary text NULL,
	event_count integer NOT NULL DEFAULT 0,
	event_bytes bigint NOT NULL DEFAULT 0,
	units bigint NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	started_at timestamptz NULL,
	finished_at timestamptz NULL,
	CONSTRAINT run_status_check CHECK (status IN ('offered', 'running', 'succeeded', 'failed', 'limited', 'cancelled', 'lost')),
	CONSTRAINT run_provider_check CHECK (provider IN ('claude', 'codex', 'gemini', 'openai-api', 'fake'))
);
CREATE INDEX IF NOT EXISTS run_task_idx ON run (task_id, attempt);
CREATE INDEX IF NOT EXISTS run_project_idx ON run (project_id);
CREATE INDEX IF NOT EXISTS run_runner_idx ON run (runner_id);
CREATE INDEX IF NOT EXISTS run_account_idx ON run (account_id);
CREATE INDEX IF NOT EXISTS run_active_idx ON run (status) WHERE status IN ('offered', 'running');

CREATE TABLE IF NOT EXISTS run_event (
	run_id uuid NOT NULL REFERENCES run (id) ON DELETE CASCADE,
	seq integer NOT NULL,
	ts timestamptz NOT NULL DEFAULT now(),
	kind text NOT NULL,
	payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS run_commit (
	run_id uuid NOT NULL REFERENCES run (id) ON DELETE CASCADE,
	sha text NOT NULL,
	message text NOT NULL DEFAULT '',
	additions integer NOT NULL DEFAULT 0,
	deletions integer NOT NULL DEFAULT 0,
	files jsonb NOT NULL DEFAULT '[]'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (run_id, sha)
);

CREATE TABLE IF NOT EXISTS usage_ledger (
	id uuid PRIMARY KEY,
	account_id uuid NOT NULL REFERENCES provider_account (id) ON DELETE CASCADE,
	run_id uuid NULL REFERENCES run (id) ON DELETE SET NULL,
	ts timestamptz NOT NULL DEFAULT now(),
	model text NOT NULL DEFAULT '',
	input_tokens bigint NOT NULL DEFAULT 0,
	output_tokens bigint NOT NULL DEFAULT 0,
	cache_read_tokens bigint NOT NULL DEFAULT 0,
	cache_write_tokens bigint NOT NULL DEFAULT 0,
	cost_microusd bigint NOT NULL DEFAULT 0,
	units bigint NOT NULL DEFAULT 0,
	source text NOT NULL DEFAULT 'reported',
	CONSTRAINT usage_ledger_source_check CHECK (source IN ('reported', 'estimated', 'reserved'))
);
CREATE INDEX IF NOT EXISTS usage_ledger_account_ts_idx ON usage_ledger (account_id, ts);
CREATE INDEX IF NOT EXISTS usage_ledger_run_idx ON usage_ledger (run_id);

CREATE TABLE IF NOT EXISTS limit_event (
	id uuid PRIMARY KEY,
	account_id uuid NOT NULL REFERENCES provider_account (id) ON DELETE CASCADE,
	run_id uuid NULL REFERENCES run (id) ON DELETE SET NULL,
	ts timestamptz NOT NULL DEFAULT now(),
	kind text NOT NULL,
	resets_at timestamptz NULL,
	units_at_hit bigint NULL,
	raw text NOT NULL DEFAULT '',
	CONSTRAINT limit_event_kind_check CHECK (kind IN ('rate', '5h', 'week', 'auth', 'other'))
);
CREATE INDEX IF NOT EXISTS limit_event_account_idx ON limit_event (account_id, ts);
CREATE INDEX IF NOT EXISTS limit_event_run_idx ON limit_event (run_id);

CREATE TABLE IF NOT EXISTS pull_request (
	project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	number integer NOT NULL,
	task_id uuid NULL REFERENCES task (id) ON DELETE SET NULL,
	title text NOT NULL DEFAULT '',
	branch text NOT NULL DEFAULT '',
	state text NOT NULL DEFAULT 'open',
	is_draft boolean NOT NULL DEFAULT false,
	mergeable text NOT NULL DEFAULT 'unknown',
	checks text NOT NULL DEFAULT 'unknown',
	auto_merge boolean NOT NULL DEFAULT false,
	url text NOT NULL DEFAULT '',
	additions integer NOT NULL DEFAULT 0,
	deletions integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	synced_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, number),
	CONSTRAINT pull_request_state_check CHECK (state IN ('open', 'merged', 'closed'))
);
CREATE INDEX IF NOT EXISTS pull_request_task_idx ON pull_request (task_id);

CREATE TABLE IF NOT EXISTS chat_message (
	id uuid PRIMARY KEY,
	project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	task_id uuid NULL REFERENCES task (id) ON DELETE SET NULL,
	author_user_id text NULL,
	kind text NOT NULL,
	body text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT chat_message_kind_check CHECK (kind IN ('user', 'agent', 'system'))
);
CREATE INDEX IF NOT EXISTS chat_message_project_idx ON chat_message (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_message_task_idx ON chat_message (task_id);

CREATE TABLE IF NOT EXISTS workspace_session (
	id uuid PRIMARY KEY,
	runner_id uuid NULL REFERENCES runner (id) ON DELETE SET NULL,
	project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	target text NOT NULL DEFAULT 'main',
	user_id text NULL,
	kind text NOT NULL,
	opened_at timestamptz NOT NULL DEFAULT now(),
	closed_at timestamptz NULL,
	CONSTRAINT workspace_session_kind_check CHECK (kind IN ('terminal', 'files'))
);
CREATE INDEX IF NOT EXISTS workspace_session_project_idx ON workspace_session (project_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS workspace_session_runner_idx ON workspace_session (runner_id);
