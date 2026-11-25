ALTER TABLE task ADD COLUMN chat_question boolean NOT NULL DEFAULT false;
ALTER TABLE task ADD COLUMN chat_context text NOT NULL DEFAULT '';
