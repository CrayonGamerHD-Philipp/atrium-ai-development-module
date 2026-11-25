ALTER TABLE task ADD COLUMN delivery text NOT NULL DEFAULT 'project'
	CHECK (delivery IN ('project', 'branch'));
ALTER TABLE task ADD COLUMN branch_pushed boolean NOT NULL DEFAULT false;
