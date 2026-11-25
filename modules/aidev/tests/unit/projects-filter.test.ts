import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDto } from '../../schemas';
import {
	COMPACT_THRESHOLD,
	defaultView,
	FAVORITES_KEY,
	filterProjects,
	highlightParts,
	isProjectSort,
	isStatusFilter,
	loadFavorites,
	loadView,
	matches,
	normalize,
	parseQuery,
	saveFavorites,
	saveView,
	score,
	SORT_OPTIONS,
	STATUS_FILTERS,
	searchText,
	statusCounts,
	VIEW_KEY,
	type ProjectFilterOptions
} from '../../pages/projects/filter';

let seq = 0;
function project(over: Partial<ProjectDto> = {}): ProjectDto {
	seq++;
	return {
		id: `p${seq}`,
		name: `Projekt ${seq}`,
		repoOwner: 'kalypzo',
		repoName: `repo-${seq}`,
		repoUrl: `https://github.com/kalypzo/repo-${seq}`,
		defaultBranch: 'main',
		commitPolicy: 'pr',
		maxParallel: 1,
		setupCmd: '',
		testCmd: '',
		instructions: '',
		preferredRunnerId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		archivedAt: null,
		counts: { queued: 0, running: 0, review: 0, needsInput: 0, done: 0 },
		...over
	};
}

const counts = (over: Partial<ProjectDto['counts']> = {}): ProjectDto['counts'] => ({
	queued: 0,
	running: 0,
	review: 0,
	needsInput: 0,
	done: 0,
	...over
});

const opts = (over: Partial<ProjectFilterOptions> = {}): ProjectFilterOptions => ({
	query: '',
	status: 'all',
	sort: 'activity',
	favorites: new Set(),
	...over
});

const names = (list: ProjectDto[]) => list.map((p) => p.name);
const joined = (parts: { text: string }[]) => parts.map((p) => p.text).join('');
const hits = (parts: { text: string; hit: boolean }[]) =>
	parts.filter((p) => p.hit).map((p) => p.text);

describe('normalize / parseQuery', () => {
	it('Kleinschreibung, Diakritika, ß und Leerraum', () => {
		expect(normalize('  Grüße   aus  Köln ')).toBe('grusse aus koln');
		expect(normalize('Café\tÉCOLE')).toBe('cafe ecole');
		expect(normalize('STRASSE')).toBe(normalize('Straße'));
	});

	it('Suchwörter ohne leere Einträge', () => {
		expect(parseQuery('  Foo   BÄR ')).toEqual(['foo', 'bar']);
		expect(parseQuery('   ')).toEqual([]);
		expect(parseQuery('')).toEqual([]);
	});
});

describe('searchText / matches', () => {
	const p = project({
		name: 'Grüße App',
		repoOwner: 'Kalypzo',
		repoName: 'Atrium-Core',
		defaultBranch: 'develop',
		commitPolicy: 'direct'
	});

	it('enthält Name, owner/repo, Branch und Richtlinie', () => {
		const t = searchText(p);
		expect(t).toContain('grusse app');
		expect(t).toContain('kalypzo/atrium-core');
		expect(t).toContain('develop');
		expect(t).toContain('direkt auf den haupt-branch');
	});

	it('ignoriert Groß-/Kleinschreibung', () => {
		expect(matches(p, parseQuery('GRÜSSE'))).toBe(true);
		expect(matches(p, parseQuery('app'))).toBe(true);
	});

	it('Umlaute/ß: „grusse“ und „Grüße“ finden, „gruesse“ nicht', () => {
		expect(matches(p, parseQuery('grusse'))).toBe(true);
		expect(matches(p, parseQuery('Grüße'))).toBe(true);
		expect(matches(p, parseQuery('gruesse'))).toBe(false);
	});

	it('mehrere Wörter sind UND-verknüpft', () => {
		expect(matches(p, parseQuery('grüße develop'))).toBe(true);
		expect(matches(p, parseQuery('grüße master'))).toBe(false);
	});

	it('sucht über owner/repo und Branch', () => {
		expect(matches(p, parseQuery('kalypzo/atrium'))).toBe(true);
		expect(matches(p, parseQuery('atrium-core'))).toBe(true);
		expect(matches(p, parseQuery('devel'))).toBe(true);
	});

	it('leere Suche passt immer', () => {
		expect(matches(p, [])).toBe(true);
	});
});

describe('score', () => {
	it('exakt > Anfang > Wortanfang > im Namen > nur Repo/Branch', () => {
		const tokens = parseQuery('atrium');
		const exact = score(project({ name: 'Atrium' }), tokens);
		const prefix = score(project({ name: 'Atrium Core' }), tokens);
		const word = score(project({ name: 'Kalypzo Atrium' }), tokens);
		const inside = score(project({ name: 'Neoatrium' }), tokens);
		const repo = score(project({ name: 'Anderes', repoName: 'atrium' }), tokens);
		expect(exact).toBeGreaterThan(prefix);
		expect(prefix).toBeGreaterThan(word);
		expect(word).toBeGreaterThan(inside);
		expect(inside).toBeGreaterThan(repo);
		expect(repo).toBeGreaterThan(0);
	});

	it('ohne Suchwörter 0', () => {
		expect(score(project(), [])).toBe(0);
	});
});

describe('filterProjects', () => {
	it('schließt archivierte aus', () => {
		const list = [
			project({ name: 'A' }),
			project({ name: 'B', archivedAt: '2026-02-01T00:00:00Z' })
		];
		expect(names(filterProjects(list, opts()))).toEqual(['A']);
	});

	it('verändert das Eingabe-Array nicht', () => {
		const list = [project({ name: 'B' }), project({ name: 'A' })];
		const copy = [...list];
		filterProjects(list, opts({ sort: 'name' }));
		expect(list).toEqual(copy);
	});

	it('Statusfilter', () => {
		const a = project({ name: 'Frage', counts: counts({ needsInput: 1 }) });
		const b = project({ name: 'Läuft', counts: counts({ running: 2 }) });
		const c = project({ name: 'PR', counts: counts({ review: 1 }) });
		const d = project({ name: 'Ruhig' });
		const list = [a, b, c, d];
		const favorites = new Set([d.id]);
		expect(names(filterProjects(list, opts({ status: 'needsInput' })))).toEqual(['Frage']);
		expect(names(filterProjects(list, opts({ status: 'running' })))).toEqual(['Läuft']);
		expect(names(filterProjects(list, opts({ status: 'review' })))).toEqual(['PR']);
		expect(names(filterProjects(list, opts({ status: 'favorites', favorites })))).toEqual([
			'Ruhig'
		]);
		expect(filterProjects(list, opts({ status: 'all' }))).toHaveLength(4);
	});

	it('Sortierung „activity“: laufend + Rückfragen, dann zuletzt geändert', () => {
		const list = [
			project({ name: 'alt', updatedAt: '2026-01-01T00:00:00Z' }),
			project({ name: 'neu', updatedAt: '2026-03-01T00:00:00Z' }),
			project({ name: 'aktiv', counts: counts({ running: 1, needsInput: 1 }) }),
			project({ name: 'halb', counts: counts({ running: 1 }) })
		];
		expect(names(filterProjects(list, opts({ sort: 'activity' })))).toEqual([
			'aktiv',
			'halb',
			'neu',
			'alt'
		]);
	});

	it('Sortierung „name“ (deutsch, ohne Groß-/Kleinschreibung)', () => {
		const list = [project({ name: 'zeta' }), project({ name: 'Äpfel' }), project({ name: 'beta' })];
		expect(names(filterProjects(list, opts({ sort: 'name' })))).toEqual(['Äpfel', 'beta', 'zeta']);
	});

	it('Sortierung „updated“', () => {
		const list = [
			project({ name: 'mitte', updatedAt: '2026-02-01T00:00:00Z' }),
			project({ name: 'alt', updatedAt: '2026-01-01T00:00:00Z' }),
			project({ name: 'neu', updatedAt: '2026-03-01T00:00:00Z', counts: counts() })
		];
		expect(names(filterProjects(list, opts({ sort: 'updated' })))).toEqual(['neu', 'mitte', 'alt']);
	});

	it('Favoriten immer zuerst', () => {
		const a = project({ name: 'A', counts: counts({ running: 3 }) });
		const z = project({ name: 'Z' });
		const favorites = new Set([z.id]);
		expect(names(filterProjects([a, z], opts({ favorites })))).toEqual(['Z', 'A']);
		expect(names(filterProjects([a, z], opts({ favorites, sort: 'name' })))).toEqual(['Z', 'A']);
	});

	it('Relevanz bei aktiver Suche, Gleichstand → gewählte Sortierung', () => {
		const list = [
			project({ name: 'Anderes', repoName: 'atrium-x', updatedAt: '2026-05-01T00:00:00Z' }),
			project({ name: 'Neoatrium' }),
			project({ name: 'Atrium' }),
			project({ name: 'Atrium Core B', updatedAt: '2026-01-01T00:00:00Z' }),
			project({ name: 'Atrium Core A', updatedAt: '2026-02-01T00:00:00Z' }),
			project({ name: 'Ohne Treffer' })
		];
		expect(names(filterProjects(list, opts({ query: 'atrium', sort: 'updated' })))).toEqual([
			'Atrium',
			'Atrium Core A',
			'Atrium Core B',
			'Neoatrium',
			'Anderes'
		]);
		expect(
			names(filterProjects(list, opts({ query: 'atrium', sort: 'name' }))).slice(1, 3)
		).toEqual(['Atrium Core A', 'Atrium Core B']);
	});

	it('Favoriten vor Relevanz', () => {
		const fav = project({ name: 'Zubehör', repoName: 'atrium' });
		const list = [project({ name: 'Atrium' }), fav];
		expect(
			names(filterProjects(list, opts({ query: 'atrium', favorites: new Set([fav.id]) })))
		).toEqual(['Zubehör', 'Atrium']);
	});
});

describe('statusCounts', () => {
	it('zählt nur nicht archivierte', () => {
		const a = project({ counts: counts({ needsInput: 2, running: 1 }) });
		const b = project({ counts: counts({ review: 1 }) });
		const c = project({ counts: counts({ running: 1 }), archivedAt: '2026-01-02T00:00:00Z' });
		expect(statusCounts([a, b, c], new Set([b.id, c.id]))).toEqual({
			all: 2,
			needsInput: 1,
			running: 1,
			review: 1,
			favorites: 1
		});
	});
});

describe('highlightParts', () => {
	it('Rekonstruktion ergibt den Originaltext', () => {
		for (const [text, q] of [
			['Atrium AI Development', 'ai dev'],
			['Grüße aus Köln', 'grusse koln'],
			['  Leer  raum ', 'raum'],
			['Emoji 🚀 Rakete', 'rakete'],
			['Café', 'e'],
			['ohne', 'xyz']
		] as const) {
			expect(joined(highlightParts(text, parseQuery(q)))).toBe(text);
		}
	});

	it('markiert einfachen Treffer', () => {
		expect(highlightParts('Atrium Core', ['core'])).toEqual([
			{ text: 'Atrium ', hit: false },
			{ text: 'Core', hit: true }
		]);
	});

	it('Umlaute und ß werden im Original markiert', () => {
		expect(hits(highlightParts('Grüße', parseQuery('grusse')))).toEqual(['Grüße']);
		expect(hits(highlightParts('Straßenbau', parseQuery('strass')))).toEqual(['Straß']);
		expect(hits(highlightParts('Köln', parseQuery('KÖ')))).toEqual(['Kö']);
	});

	it('zerlegte Diakritika (NFD) werden mitmarkiert', () => {
		const text = 'Café Bar';
		const parts = highlightParts(text, ['cafe']);
		expect(hits(parts)).toEqual(['Café']);
		expect(joined(parts)).toBe(text);
	});

	it('Mehrfachtreffer', () => {
		expect(hits(highlightParts('ab ab ab', ['ab']))).toEqual(['ab', 'ab', 'ab']);
	});

	it('überlappende Treffer werden zusammengeführt', () => {
		expect(highlightParts('abcdef', ['abc', 'bcd'])).toEqual([
			{ text: 'abcd', hit: true },
			{ text: 'ef', hit: false }
		]);
		expect(highlightParts('aaaa', ['aa'])).toEqual([{ text: 'aaaa', hit: true }]);
	});

	it('leere Tokens oder leerer Text', () => {
		expect(highlightParts('Atrium', [])).toEqual([{ text: 'Atrium', hit: false }]);
		expect(highlightParts('Atrium', ['', '  '])).toEqual([{ text: 'Atrium', hit: false }]);
		expect(highlightParts('', ['a'])).toEqual([]);
	});
});

describe('Guards und Beschriftungen', () => {
	it('isStatusFilter', () => {
		for (const f of STATUS_FILTERS) expect(isStatusFilter(f.value)).toBe(true);
		expect(isStatusFilter('done')).toBe(false);
		expect(isStatusFilter(null)).toBe(false);
	});

	it('isProjectSort', () => {
		for (const s of SORT_OPTIONS) expect(isProjectSort(s.value)).toBe(true);
		expect(isProjectSort('created')).toBe(false);
		expect(isProjectSort(undefined)).toBe(false);
	});

	it('deutsche Labels', () => {
		expect(STATUS_FILTERS.map((f) => f.label)).toEqual([
			'Alle',
			'Rückfragen',
			'Laufend',
			'PR offen',
			'Favoriten'
		]);
		expect(SORT_OPTIONS.map((s) => s.label)).toEqual(['Aktivität', 'Name', 'Zuletzt geändert']);
	});

	it('defaultView', () => {
		expect(defaultView(COMPACT_THRESHOLD - 1)).toBe('grid');
		expect(defaultView(COMPACT_THRESHOLD)).toBe('list');
		expect(COMPACT_THRESHOLD).toBe(12);
	});
});

describe('Favoriten und Ansicht im localStorage', () => {
	afterEach(() => vi.unstubAllGlobals());

	function memoryStorage() {
		const data = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
			removeItem: (k: string) => void data.delete(k)
		});
		return data;
	}

	it('speichert und lädt Favoriten', () => {
		const data = memoryStorage();
		expect(loadFavorites()).toEqual(new Set());
		saveFavorites(new Set(['a', 'b']));
		expect(JSON.parse(data.get(FAVORITES_KEY)!)).toEqual(['a', 'b']);
		expect(loadFavorites()).toEqual(new Set(['a', 'b']));
	});

	it('defekte Favoriten → leeres Set bzw. nur Strings', () => {
		const data = memoryStorage();
		for (const raw of ['{kaputt', '"text"', '{"a":1}', 'null']) {
			data.set(FAVORITES_KEY, raw);
			expect(loadFavorites()).toEqual(new Set());
		}
		data.set(FAVORITES_KEY, JSON.stringify(['a', 1, null, 'b']));
		expect(loadFavorites()).toEqual(new Set(['a', 'b']));
	});

	it('speichert und lädt die Ansicht', () => {
		const data = memoryStorage();
		expect(loadView()).toBeNull();
		saveView('list');
		expect(data.get(VIEW_KEY)).toBe('list');
		expect(loadView()).toBe('list');
		data.set(VIEW_KEY, 'kacheln');
		expect(loadView()).toBeNull();
	});

	it('wirft nicht, wenn localStorage gesperrt oder voll ist', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('gesperrt');
			},
			setItem: () => {
				throw new Error('voll');
			},
			removeItem: () => {
				throw new Error('gesperrt');
			}
		});
		expect(loadFavorites()).toEqual(new Set());
		expect(loadView()).toBeNull();
		expect(() => saveFavorites(new Set(['a']))).not.toThrow();
		expect(() => saveView('grid')).not.toThrow();
	});

	it('wirft nicht, wenn localStorage fehlt', () => {
		vi.stubGlobal('localStorage', undefined);
		expect(loadFavorites()).toEqual(new Set());
		expect(loadView()).toBeNull();
	});
});
