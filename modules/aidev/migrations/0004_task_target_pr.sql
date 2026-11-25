ALTER TABLE task ADD COLUMN target_pr integer CHECK (target_pr IS NULL OR target_pr > 0);
