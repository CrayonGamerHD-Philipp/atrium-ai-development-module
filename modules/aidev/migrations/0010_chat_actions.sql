-- Aktionsvorschläge eines Agents an seiner Chatnachricht (`StoredChatAction[]` aus `actions.ts`):
-- Auftrag anlegen, ändern oder abbrechen – ein Mensch übernimmt oder verwirft sie. `NULL` = keine Vorschläge.
ALTER TABLE chat_message ADD COLUMN IF NOT EXISTS actions jsonb;
