-- Projektwissen (`knowledge.ts`): kurze, dauerhafte Notizen über das Repository (Befehle, Architektur,
-- Konventionen, Stolperfallen). Agents ergänzen es über einen `aidev-notes`-Block, Menschen bearbeiten es in den
-- Projekteinstellungen; jeder Lauf bekommt es in der Systemanweisung (spart erneutes Erkunden).
ALTER TABLE project ADD COLUMN IF NOT EXISTS knowledge text NOT NULL DEFAULT '';
ALTER TABLE project ADD COLUMN IF NOT EXISTS knowledge_updated_at timestamptz NULL;
