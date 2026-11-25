/**
 * Repo-Eingabe im Dialog „Projekt anlegen“ zerlegen (reine Logik, auch im Browser nutzbar).
 * Spiegelt `parseRepo` aus `../../projects.service.ts` (Server-Datei), versteht zusätzlich
 * GitHub-Links mit Unterpfad (`/tree/<branch>`, `/pulls` …), Query und Anker.
 */

export interface RepoRef {
	owner: string;
	name: string;
	/** Rest nach `/tree/` (Branch, evtl. mit Unterpfad), sonst `null` */
	ref: string | null;
}

/** Wie `repoSlug` in `../../schemas.ts` */
const SLUG_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PREFIX_RE =
	/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i;

const validSlug = (s: string) => SLUG_RE.test(s) && s !== '.' && s !== '..';

function decode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/**
 * `owner/repo`, `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git`,
 * `https://github.com/owner/repo/tree/<branch>?…#…` → Teile, sonst `null`
 */
export function parseRepoInput(input: string): RepoRef | null {
	const raw = input.trim();
	if (!raw || /\s/.test(raw)) return null;
	const prefix = PREFIX_RE.exec(raw);
	// Query/Anker nur bei Links abschneiden; „owner/repo?x“ ist kein gültiger Bezeichner
	const rest = prefix ? raw.slice(prefix[0].length).replace(/[?#].*$/, '') : raw;
	const parts = rest.split('/');
	while (parts.length && parts[parts.length - 1] === '') parts.pop();
	if (parts.length < 2) return null;
	// Ohne Link-Präfix nur genau „owner/repo“
	if (!prefix && parts.length > 2) return null;
	const owner = parts[0] ?? '';
	const name = (parts[1] ?? '').replace(/\.git$/i, '');
	if (!validSlug(owner) || !validSlug(name)) return null;
	let ref: string | null = null;
	if (parts[2] === 'tree' && parts.length > 3) ref = decode(parts.slice(3).join('/')) || null;
	return { owner, name, ref };
}

/** Normalisierte Form `owner/repo` für Server-Aufrufe */
export const repoKey = (r: Pick<RepoRef, 'owner' | 'name'>) => `${r.owner}/${r.name}`;

/**
 * Branch aus einem `/tree/…`-Rest bestimmen: längster Präfix (ganze Pfadsegmente),
 * der in `branches` vorkommt (`feature/x/src/lib` → `feature/x`), sonst `null`.
 */
export function branchFromRef(ref: string | null, branches: readonly string[]): string | null {
	if (!ref) return null;
	const known = new Set(branches);
	const segs = ref.split('/');
	for (let n = segs.length; n > 0; n--) {
		const candidate = segs.slice(0, n).join('/');
		if (known.has(candidate)) return candidate;
	}
	return null;
}
