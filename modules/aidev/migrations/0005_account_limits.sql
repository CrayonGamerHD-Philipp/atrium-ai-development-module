ALTER TABLE provider_account ADD COLUMN IF NOT EXISTS limit_snapshot jsonb NULL;
ALTER TABLE provider_account ADD COLUMN IF NOT EXISTS limit_snapshot_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS account_limit_sample (
	id uuid PRIMARY KEY,
	account_id uuid NOT NULL REFERENCES provider_account (id) ON DELETE CASCADE,
	ts timestamptz NOT NULL DEFAULT now(),
	time_window text NOT NULL,
	used_percent double precision NULL,
	resets_at timestamptz NULL,
	units_in_window bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS account_limit_sample_account_window_ts_idx
	ON account_limit_sample (account_id, time_window, ts);
