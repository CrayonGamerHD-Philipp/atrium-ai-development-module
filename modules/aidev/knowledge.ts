/**
 * Projektwissen (reine Logik, ohne Abhängigkeiten – auch vom Browser-UI importierbar).
 *
 * Damit nicht jeder Lauf das Repository von Null erkundet (Tokens, Zeit), hält Atrium je Projekt ein kurzes,
 * dauerhaftes Wissen fest: Build-/Testbefehle, Architektur, Konventionen, Stolperfallen. Es wird jedem Agent in der
 * Systemanweisung mitgegeben. Agents ergänzen es, indem sie ihre Antwort mit einem Block beenden:
 *
 * ```aidev-notes
 * - Tests: `npm test` braucht vorher `npm run build:types`
 * - API-Routen liegen in `src/routes/api/**`, Validierung immer mit zod
 * ```
 *
 * Atrium entfernt den Block aus dem sichtbaren Ergebnis, prüft die Zeilen (Länge, keine Geheimnisse), entfernt
 * Duplikate und hängt sie an. Ist das Wissen zu lang, fallen die ältesten automatisch ergänzten Zeilen weg. Von
 * Menschen geschriebener Text (alles, was keine `- `-Zeile mit Datum ist) bleibt erhalten.
 */

/** Sprache des Code-Blocks mit Notizen */
export const KNOWLEDGE_LANG = 'aidev-notes';
/** Höchstlänge des gespeicherten Projektwissens (Zeichen) */
export const KNOWLEDGE_MAX = 6000;
/** Höchstzahl neuer Notizen je Lauf */
export const MAX_NOTES_PER_RUN = 12;
/** Höchstlänge einer Notiz */
export const NOTE_MAX = 300;

/** Automatisch ergänzte Zeile: `- [JJJJ-MM-TT] Text` */
const AUTO_LINE = /^- \[\d{4}-\d{2}-\d{2}\] /;

/** Offensichtliche Geheimnisse (Tokens, Schlüssel, Passwörter) – solche Notizen werden verworfen */
const SECRET =
	/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|(?:password|passwort|secret|token|api[_-]?key)\s*[:=]\s*\S{6,})/i;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function isClosingFence(line: string, fence: string): boolean {
	const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	const close = m?.[1] ?? '';
	return close !== '' && close[0] === fence[0] && close.length >= fence.length;
}

/** Vergleichsschlüssel einer Notiz (ohne Datum, Groß-/Kleinschreibung, Satzzeichen am Ende, Leerraum) */
export function noteKey(line: string): string {
	return line
		.replace(AUTO_LINE, '')
		.replace(/^[-*]\s+/, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/[.;:,!]+$/, '')
		.trim();
}

/** Eine Notiz säubern; `null` = verwerfen (leer, zu kurz, Geheimnis) */
export function cleanNote(raw: string): string | null {
	const t = raw
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (t.length < 8 || SECRET.test(t)) return null;
	return t.length <= NOTE_MAX ? t : `${t.slice(0, NOTE_MAX - 1).trimEnd()}…`;
}

/**
 * Alle `aidev-notes`-Blöcke aus `text` entfernen und ihre Zeilen als Notizen liefern (bereinigt, ohne Duplikate,
 * höchstens `MAX_NOTES_PER_RUN`). Andere Code-Blöcke bleiben unverändert. Wirft nie.
 */
export function extractNotes(text: string | null | undefined): { body: string; notes: string[] } {
	const source = typeof text === 'string' ? text : '';
	if (!source.includes(KNOWLEDGE_LANG)) return { body: source, notes: [] };
	const lines = source.split('\n');
	const kept: string[] = [];
	const notes: string[] = [];
	const seen = new Set<string>();
	const at = (n: number) => (lines[n] ?? '').replace(/\r$/, '');
	for (let i = 0; i < lines.length; i++) {
		const open = FENCE_OPEN.exec(at(i));
		const fence = open?.[1] ?? '';
		const info = open?.[2] ?? '';
		if (!fence || (fence.startsWith('`') && info.includes('`'))) {
			kept.push(lines[i] ?? '');
			continue;
		}
		let end = i + 1;
		while (end < lines.length && !isClosingFence(at(end), fence)) end++;
		if ((info.trim().split(/\s+/)[0] ?? '') !== KNOWLEDGE_LANG) {
			kept.push(...lines.slice(i, Math.min(end + 1, lines.length)));
			i = end;
			continue;
		}
		for (let j = i + 1; j < end; j++) {
			const note = cleanNote(at(j));
			if (!note) continue;
			const key = noteKey(note);
			if (seen.has(key) || notes.length >= MAX_NOTES_PER_RUN) continue;
			seen.add(key);
			notes.push(note);
		}
		i = end;
	}
	return {
		body: kept
			.join('\n')
			.replace(/\n{3,}$/, '\n')
			.trimEnd(),
		notes
	};
}

/**
 * Neue Notizen an das Projektwissen anhängen (`- [Datum] Text`), Duplikate (auch gegenüber vorhandenen Zeilen)
 * überspringen und auf `max` Zeichen begrenzen – dabei fallen zuerst die ältesten automatisch ergänzten Zeilen weg.
 */
export function mergeKnowledge(
	current: string,
	notes: readonly string[],
	now: Date,
	max = KNOWLEDGE_MAX
): string {
	const lines = (current ?? '').replace(/\r\n/g, '\n').trimEnd().split('\n');
	if (lines.length === 1 && lines[0] === '') lines.length = 0;
	const keys = new Set(lines.map(noteKey).filter(Boolean));
	const day = now.toISOString().slice(0, 10);
	for (const n of notes) {
		const note = cleanNote(n);
		if (!note) continue;
		const key = noteKey(note);
		if (keys.has(key)) continue;
		keys.add(key);
		lines.push(`- [${day}] ${note}`);
	}
	const size = () => lines.join('\n').length;
	while (size() > max) {
		const idx = lines.findIndex((l) => AUTO_LINE.test(l));
		if (idx < 0) break;
		lines.splice(idx, 1);
	}
	const out = lines.join('\n');
	return out.length <= max ? out : out.slice(0, max);
}

/** Abschnitte der Systemanweisung: vorhandenes Wissen und Aufforderung, neues festzuhalten */
export function knowledgeSection(knowledge: string, o: { question?: boolean } = {}): string[] {
	const k = (knowledge ?? '').trim();
	const lines: string[] = [];
	if (k) {
		lines.push(
			'',
			'## Project knowledge (notes from earlier runs)',
			'Use these notes to avoid re-exploring the repository. They may be outdated – verify a detail in the code before relying on it for something critical.',
			'',
			k
		);
	}
	lines.push(
		'',
		'## Remember what you learned (optional)',
		`If you learned durable, non-obvious facts about this repository that would save the next agent time (build/test commands and their pitfalls, where things live, conventions, gotchas), end your answer with ONE fenced \`\`\`${KNOWLEDGE_LANG} block of short bullet points (max ${MAX_NOTES_PER_RUN}, one fact per line).`,
		'- Only facts that stay true beyond this task; nothing task-specific, no progress reports, no secrets.' +
			(k ? ' Do not repeat notes that are already listed above.' : ''),
		o.question
			? '- The block is removed from the visible answer.'
			: '- The block is removed from your visible summary; leave it out if there is nothing new.'
	);
	return lines;
}
