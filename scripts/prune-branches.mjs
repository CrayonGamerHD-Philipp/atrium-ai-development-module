// Räumt bereits gemergte Branches auf (lokal und auf `origin`). Standard ist ein Probelauf, gelöscht wird nur mit `--apply`.
// Ein Branch gilt als gemergt, wenn er
//   1. Vorfahre von origin/<base> ist (normaler Merge / Fast-Forward),
//   2. beim Mergen in origin/<base> keine Änderung mehr bringt (Squash-Merge, `git merge-tree`),
//   3. nur Commits enthält, die patch-gleich in origin/<base> liegen (Rebase/Cherry-Pick, `git cherry`), oder
//   4. Vorfahre eines Branchs ist, der nach 1–3 gemergt ist (z. B. Teilaufträge eines gemergten Sammel-Branchs).
// Der Basis-Branch, lokal in einem Worktree ausgecheckte Branches und Branches, deren letzter Commit jünger als
// `--min-age` Stunden ist (Standard 1, schützt gerade angelegte Branches laufender Aufträge), bleiben erhalten.
//
//   node scripts/prune-branches.mjs [--base main] [--remote origin] [--min-age 1] [--apply] [--no-local] [--no-remote]
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);
const BASE = opt('--base', 'main');
const REMOTE = opt('--remote', 'origin');
const APPLY = flag('--apply');
const LOCAL = !flag('--no-local');
const REMOTES = !flag('--no-remote');
const MIN_AGE_H = Number(opt('--min-age', '1'));
if (!Number.isFinite(MIN_AGE_H) || MIN_AGE_H < 0) {
	console.error('--min-age erwartet eine Zahl ≥ 0 (Stunden).');
	process.exit(1);
}

const git = (...args) =>
	execFileSync('git', args, {
		cwd: ROOT,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	}).trim();
const tryGit = (...args) => {
	try {
		return { ok: true, out: git(...args) };
	} catch (e) {
		return { ok: false, out: String(e.stdout ?? '').trim() };
	}
};
const lines = (s) => s.split('\n').filter(Boolean);

git('fetch', '--prune', '--quiet', REMOTE);
const baseRef = `refs/remotes/${REMOTE}/${BASE}`;
if (!tryGit('rev-parse', '--verify', '--quiet', baseRef).ok) {
	console.error(`${REMOTE}/${BASE} existiert nicht.`);
	process.exit(1);
}
const baseTree = git('rev-parse', `${baseRef}^{tree}`);
const checkedOut = new Set(
	lines(git('worktree', 'list', '--porcelain'))
		.filter((l) => l.startsWith('branch refs/heads/'))
		.map((l) => l.slice('branch refs/heads/'.length))
);

/** @type {{ ref: string; name: string; kind: 'local' | 'remote' }[]} */
const candidates = [];
if (LOCAL)
	for (const name of lines(git('for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads')))
		if (name !== BASE) candidates.push({ ref: `refs/heads/${name}`, name, kind: 'local' });
if (REMOTES)
	for (const name of lines(
		git('for-each-ref', '--format=%(refname:lstrip=3)', `refs/remotes/${REMOTE}`)
	))
		if (name !== BASE && name !== 'HEAD')
			candidates.push({ ref: `refs/remotes/${REMOTE}/${name}`, name, kind: 'remote' });

const isAncestor = (a, b) => tryGit('merge-base', '--is-ancestor', a, b).ok;
const directlyMerged = (ref) => {
	if (isAncestor(ref, baseRef)) return true;
	// `--write-tree` gibt es ab Git 2.38; bei Konflikten ist der Exit-Code 1 → nicht gemergt
	const mt = tryGit('merge-tree', '--write-tree', baseRef, ref);
	if (mt.ok && lines(mt.out)[0] === baseTree) return true;
	const cherry = tryGit('cherry', baseRef, ref);
	return cherry.ok && !lines(cherry.out).some((l) => l.startsWith('+'));
};

const merged = new Set(candidates.filter((c) => directlyMerged(c.ref)).map((c) => c.ref));
for (const c of candidates)
	if (!merged.has(c.ref) && [...merged].some((m) => isAncestor(c.ref, m))) merged.add(c.ref);

const keep = candidates.filter((c) => !merged.has(c.ref));
const minEpoch = Math.floor(Date.now() / 1000) - MIN_AGE_H * 3600;
const merged0 = candidates.filter((c) => merged.has(c.ref));
const young = merged0.filter((c) => Number(git('log', '-1', '--format=%ct', c.ref)) > minEpoch);
const drop = merged0.filter((c) => !young.includes(c));
const blocked = drop.filter((c) => c.kind === 'local' && checkedOut.has(c.name));
const local = drop.filter((c) => c.kind === 'local' && !checkedOut.has(c.name));
const remote = drop.filter((c) => c.kind === 'remote');

const list = (title, items, fmt) => {
	if (!items.length) return;
	console.log(`\n${title} (${items.length}):`);
	for (const c of items) console.log(`  ${fmt(c)}`);
};
list('Nicht gemergt – bleibt', keep, (c) => (c.kind === 'remote' ? `${REMOTE}/${c.name}` : c.name));
list(`Gemergt, aber jünger als ${MIN_AGE_H} h – bleibt`, young, (c) =>
	c.kind === 'remote' ? `${REMOTE}/${c.name}` : c.name
);
list('Gemergt, aber in einem Worktree ausgecheckt – bleibt', blocked, (c) => c.name);
list('Gemergt – lokal löschen', local, (c) => c.name);
list('Gemergt – auf dem Remote löschen', remote, (c) => `${REMOTE}/${c.name}`);

if (!APPLY) {
	console.log('\nProbelauf – zum Löschen mit --apply erneut aufrufen.');
	process.exit(0);
}
let failed = false;
for (const c of local) {
	const r = tryGit('branch', '-D', c.name);
	if (!r.ok) {
		failed = true;
		console.error(`✗ ${c.name} konnte nicht gelöscht werden`);
	}
}
if (remote.length) {
	try {
		execFileSync('git', ['push', '--delete', REMOTE, ...remote.map((c) => c.name)], {
			cwd: ROOT,
			stdio: 'inherit'
		});
	} catch {
		failed = true;
		console.error(`✗ Löschen auf ${REMOTE} fehlgeschlagen (Zugangsdaten/Rechte?)`);
	}
}
git('worktree', 'prune');
console.log(failed ? '\nAufräumen mit Fehlern beendet.' : '\nAufräumen abgeschlossen.');
process.exit(failed ? 1 : 0);
