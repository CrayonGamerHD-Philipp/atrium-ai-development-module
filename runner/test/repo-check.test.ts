import { describe, expect, it } from 'vitest';
import { MAX_REPO_BRANCHES, repoCheckResult } from '../src/protocol.ts';
import { parseLsRemoteHeads } from '../src/rpc.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const heads = (...names: string[]) => names.map((b, i) => `${sha(i + 1)}\trefs/heads/${b}`).join('\n') + '\n';

describe('parseLsRemoteHeads', () => {
	it('liest Branch-Namen aus normaler Ausgabe (alphabetisch)', () => {
		expect(parseLsRemoteHeads(heads('main', 'develop', 'aidev/x'), null)).toEqual(['aidev/x', 'develop', 'main']);
	});

	it('liefert bei leerer Ausgabe eine leere Liste', () => {
		expect(parseLsRemoteHeads('', 'main')).toEqual([]);
		expect(parseLsRemoteHeads('\n\n', null)).toEqual([]);
	});

	it('stellt den Default-Branch an den Anfang', () => {
		expect(parseLsRemoteHeads(heads('alpha', 'main', 'beta'), 'main')).toEqual(['main', 'alpha', 'beta']);
	});

	it('ignoriert einen unbekannten Default-Branch, der im Remote fehlt', () => {
		expect(parseLsRemoteHeads(heads('b', 'a'), 'main')).toEqual(['a', 'b']);
		expect(parseLsRemoteHeads(heads('b', 'a'), '')).toEqual(['a', 'b']);
	});

	it('behält verschachtelte Namen, entfernt Duplikate und überspringt fremde Zeilen', () => {
		const out = [
			`${sha(1)}\trefs/heads/feature/x`,
			`${sha(2)}\trefs/heads/feature/x`,
			`${sha(3)}\trefs/tags/v1.0`,
			`${sha(4)}\tHEAD`,
			'warning: irgendwas',
			`${sha(5)}\trefs/heads/release/2026.11/rc-1\r`,
			`${sha(6)}    refs/heads/main`
		].join('\n');
		expect(parseLsRemoteHeads(out, 'main')).toEqual(['main', 'feature/x', 'release/2026.11/rc-1']);
	});

	it('verwirft Namen über 255 Zeichen', () => {
		expect(parseLsRemoteHeads(heads('a'.repeat(256), 'ok'), null)).toEqual(['ok']);
	});

	it(`begrenzt auf MAX_REPO_BRANCHES (${MAX_REPO_BRANCHES}) und behält den Default-Branch`, () => {
		const names = Array.from({ length: MAX_REPO_BRANCHES + 50 }, (_, i) => `b-${String(i).padStart(4, '0')}`);
		const list = parseLsRemoteHeads(heads(...names, 'zzz-main'), 'zzz-main');
		expect(list).toHaveLength(MAX_REPO_BRANCHES);
		expect(list[0]).toBe('zzz-main');
		expect(list[1]).toBe('b-0000');
		expect(repoCheckResult.safeParse({ ok: true, defaultBranch: 'zzz-main', canPush: true, message: '', branches: list }).success).toBe(
			true
		);
	});
});

describe('repoCheckResult', () => {
	it('akzeptiert Antworten älterer Runner ohne `branches`', () => {
		expect(repoCheckResult.safeParse({ ok: true, defaultBranch: 'main', canPush: true, message: 'ok' }).success).toBe(true);
	});

	it('lehnt zu viele Branches ab', () => {
		const branches = Array.from({ length: MAX_REPO_BRANCHES + 1 }, (_, i) => `b${i}`);
		expect(repoCheckResult.safeParse({ ok: true, defaultBranch: null, canPush: false, message: '', branches }).success).toBe(false);
	});
});
