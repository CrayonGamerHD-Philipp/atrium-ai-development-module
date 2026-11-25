/**
 * Reine Such-, Filter- und Sortierlogik für die Projektübersicht: Normalisierung, Suchwörter,
 * Relevanz, Statusfilter, Sortierung, Hervorhebung ohne `{@html}` sowie Favoriten und Ansicht im
 * localStorage.
 *
 * Regel für die Normalisierung: Kleinschreibung, Diakritika werden entfernt (ü → u, é → e) und
 * ß wird zu ss. Umschreibungen wie ue/oe/ae werden NICHT auf Umlaute abgebildet – „gruesse“ findet
 * „Grüße“ also nicht, „grusse“, „GRÜSSE“ und „Grüße“ dagegen schon.
 */
import { POLICY_LABELS, type ProjectDto } from '../../schemas';
import { storage } from '../project/chat/modes';

// ---------------------------------------------------------------- Suche

/** Einzelnes Zeichen normalisieren (ohne Leerraum-Behandlung) */
function normalizeChar(ch: string): string {
	return ch.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss');
}

/** Kleinschreibung, Diakritika entfernen, ß → ss, Leerraum zusammenfassen und trimmen */
export function normalize(s: string): string {
	return normalizeChar(s).replace(/\s+/g, ' ').trim();
}

/** Normalisierter Suchtext eines Projekts (Name, owner/repo, Repo, Branch, Commit-Richtlinie) */
export function searchText(p: ProjectDto): string {
	return normalize(
		[
			p.name,
			`${p.repoOwner}/${p.repoName}`,
			p.repoName,
			p.defaultBranch,
			POLICY_LABELS[p.commitPolicy] ?? ''
		].join(' ')
	);
}

/** Suchwörter: an Leerraum getrennt, normalisiert, leere verworfen */
export function parseQuery(q: string): string[] {
	return normalize(q)
		.split(' ')
		.filter((t) => t.length > 0);
}

/** UND-Verknüpfung: jedes Wort muss als Teilstring im Suchtext vorkommen */
export function matches(p: ProjectDto, tokens: string[]): boolean {
	if (tokens.length === 0) return true;
	const text = searchText(p);
	return tokens.every((t) => text.includes(t));
}

/** Kommt `token` im (normalisierten) `name` an einem Wortanfang vor? */
function atWordStart(name: string, token: string): boolean {
	let i = name.indexOf(token);
	while (i !== -1) {
		if (i === 0 || !/[\p{L}\p{N}]/u.test(name[i - 1]!)) return true;
		i = name.indexOf(token, i + 1);
	}
	return false;
}

/**
 * Relevanz für die Sortierung bei aktiver Suche (höher = besser). Je Wort: Name beginnt damit (50)
 * > Wortanfang im Namen (30) > Treffer im Namen (20) > Treffer nur im Repo/Branch (5). Entspricht
 * der ganze Suchbegriff exakt dem Namen, gibt es einen Bonus, der alles andere übertrifft.
 */
export function score(p: ProjectDto, tokens: string[]): number {
	if (tokens.length === 0) return 0;
	const name = normalize(p.name);
	const text = searchText(p);
	let total = name === tokens.join(' ') ? 1000 : 0;
	for (const t of tokens) {
		if (name.startsWith(t)) total += 50;
		else if (atWordStart(name, t)) total += 30;
		else if (name.includes(t)) total += 20;
		else if (text.includes(t)) total += 5;
	}
	return total;
}

// ---------------------------------------------------------------- Filter und Sortierung

export type ProjectStatusFilter = 'all' | 'needsInput' | 'running' | 'review' | 'favorites';
export type ProjectSort = 'activity' | 'name' | 'updated';

export const STATUS_FILTERS: { value: ProjectStatusFilter; label: string }[] = [
	{ value: 'all', label: 'Alle' },
	{ value: 'needsInput', label: 'Rückfragen' },
	{ value: 'running', label: 'Laufend' },
	{ value: 'review', label: 'PR offen' },
	{ value: 'favorites', label: 'Favoriten' }
];

export const SORT_OPTIONS: { value: ProjectSort; label: string }[] = [
	{ value: 'activity', label: 'Aktivität' },
	{ value: 'name', label: 'Name' },
	{ value: 'updated', label: 'Zuletzt geändert' }
];

/** Guard für Werte aus der URL */
export function isStatusFilter(v: unknown): v is ProjectStatusFilter {
	return STATUS_FILTERS.some((f) => f.value === v);
}

/** Guard für Werte aus der URL */
export function isProjectSort(v: unknown): v is ProjectSort {
	return SORT_OPTIONS.some((s) => s.value === v);
}

export interface ProjectFilterOptions {
	query: string;
	status: ProjectStatusFilter;
	sort: ProjectSort;
	favorites: ReadonlySet<string>;
}

function matchesStatus(
	p: ProjectDto,
	status: ProjectStatusFilter,
	favorites: ReadonlySet<string>
): boolean {
	switch (status) {
		case 'needsInput':
			return p.counts.needsInput > 0;
		case 'running':
			return p.counts.running > 0;
		case 'review':
			return p.counts.review > 0;
		case 'favorites':
			return favorites.has(p.id);
		default:
			return true;
	}
}

const byUpdated = (a: ProjectDto, b: ProjectDto) => b.updatedAt.localeCompare(a.updatedAt);

const COMPARATORS: Record<ProjectSort, (a: ProjectDto, b: ProjectDto) => number> = {
	// Bisheriges Verhalten: laufende + Rückfragen zuerst, dann zuletzt geändert
	activity: (a, b) =>
		b.counts.running + b.counts.needsInput - (a.counts.running + a.counts.needsInput) ||
		byUpdated(a, b),
	name: (a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }) || byUpdated(a, b),
	updated: byUpdated
};

/**
 * Archivierte ausschließen, nach Status und Suche filtern und sortieren. Favoriten stehen immer
 * zuerst, bei aktiver Suche folgt die Relevanz, bei Gleichstand die gewählte Sortierung. Das
 * Eingabe-Array bleibt unverändert.
 */
export function filterProjects(projects: ProjectDto[], opts: ProjectFilterOptions): ProjectDto[] {
	const tokens = parseQuery(opts.query);
	const compare = COMPARATORS[opts.sort] ?? COMPARATORS.activity;
	const scored = projects
		.filter(
			(p) => !p.archivedAt && matchesStatus(p, opts.status, opts.favorites) && matches(p, tokens)
		)
		.map((p) => ({ p, fav: opts.favorites.has(p.id), score: score(p, tokens) }));
	scored.sort((a, b) => Number(b.fav) - Number(a.fav) || b.score - a.score || compare(a.p, b.p));
	return scored.map((s) => s.p);
}

/** Anzahl nicht archivierter Projekte je Statusfilter (für die Zähler an den Filter-Chips) */
export function statusCounts(
	projects: ProjectDto[],
	favorites: ReadonlySet<string>
): Record<ProjectStatusFilter, number> {
	const counts: Record<ProjectStatusFilter, number> = {
		all: 0,
		needsInput: 0,
		running: 0,
		review: 0,
		favorites: 0
	};
	for (const p of projects) {
		if (p.archivedAt) continue;
		for (const f of STATUS_FILTERS) if (matchesStatus(p, f.value, favorites)) counts[f.value]++;
	}
	return counts;
}

// ---------------------------------------------------------------- Hervorhebung

export interface HighlightPart {
	text: string;
	hit: boolean;
}

/**
 * Teilt den ORIGINALtext in Segmente mit Treffermarkierung. Gesucht wird im normalisierten Text;
 * jede normalisierte Stelle verweist auf ihr Ursprungszeichen, sodass z. B. „ß“ oder „ü“ vollständig
 * markiert werden. Überlappende und angrenzende Treffer werden zusammengeführt; die Segmente ergeben
 * zusammengesetzt immer exakt den Originaltext.
 */
export function highlightParts(text: string, tokens: string[]): HighlightPart[] {
	const words = tokens.map(normalize).filter((t) => t.length > 0 && !t.includes(' '));
	if (!text) return [];
	if (words.length === 0) return [{ text, hit: false }];

	// Normalisierter Text Zeichen für Zeichen, mit Rückverweis auf die Ursprungsposition
	let norm = '';
	const origin: number[] = []; // Index im normalisierten Text → Index des Codepoints in `chars`
	const chars: { start: number; end: number; empty: boolean }[] = [];
	let pos = 0;
	for (const ch of text) {
		const n = /\s/.test(ch) ? ' ' : normalizeChar(ch);
		for (let k = 0; k < n.length; k++) origin.push(chars.length);
		norm += n;
		chars.push({ start: pos, end: pos + ch.length, empty: n.length === 0 });
		pos += ch.length;
	}

	// Trefferbereiche im Original (Codepoint-Indizes, Ende exklusiv)
	const ranges: [number, number][] = [];
	for (const w of words) {
		let i = norm.indexOf(w);
		while (i !== -1) {
			let end = origin[i + w.length - 1]! + 1;
			// Nachfolgende Zeichen ohne Normalform (z. B. kombinierende Akzente) mitnehmen
			while (end < chars.length && chars[end]!.empty) end++;
			ranges.push([origin[i]!, end]);
			i = norm.indexOf(w, i + 1);
		}
	}
	if (ranges.length === 0) return [{ text, hit: false }];

	ranges.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else merged.push([r[0], r[1]]);
	}

	const parts: HighlightPart[] = [];
	const slice = (from: number, to: number) => text.slice(chars[from]!.start, chars[to - 1]!.end);
	let cursor = 0;
	for (const [s, e] of merged) {
		if (s > cursor) parts.push({ text: slice(cursor, s), hit: false });
		parts.push({ text: slice(s, e), hit: true });
		cursor = e;
	}
	if (cursor < chars.length) parts.push({ text: slice(cursor, chars.length), hit: false });
	return parts;
}

// ---------------------------------------------------------------- Favoriten und Ansicht

export const FAVORITES_KEY = 'aidev.projects.favorites';

/** Favoriten aus dem localStorage (JSON-Array von IDs); defekte Werte → leeres Set */
export function loadFavorites(): Set<string> {
	const raw = storage.get(FAVORITES_KEY);
	if (!raw) return new Set();
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((v): v is string => typeof v === 'string'));
	} catch {
		return new Set();
	}
}

export function saveFavorites(set: ReadonlySet<string>): void {
	storage.set(FAVORITES_KEY, JSON.stringify([...set]));
}

export type ProjectView = 'grid' | 'list';
export const VIEW_KEY = 'aidev.projects.view';
/** Ab dieser Projektanzahl ist die kompakte Liste die Standardansicht */
export const COMPACT_THRESHOLD = 12;

/** Gespeicherte Ansicht oder `null`, wenn keine (gültige) gespeichert ist */
export function loadView(): ProjectView | null {
	const v = storage.get(VIEW_KEY);
	return v === 'grid' || v === 'list' ? v : null;
}

export function saveView(v: ProjectView): void {
	storage.set(VIEW_KEY, v);
}

/** Standardansicht je nach Projektanzahl */
export function defaultView(count: number): ProjectView {
	return count >= COMPACT_THRESHOLD ? 'list' : 'grid';
}
