/** Einfacher Parser für Unified Diffs (`git diff`): Dateien → Hunks → Zeilen mit alten/neuen Zeilennummern */

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
	oldNo: number | null;
	newNo: number | null;
}

export interface DiffFile {
	/** Anzeigepfad (neuer Pfad, bei Löschung der alte) */
	path: string;
	oldPath: string | null;
	newPath: string | null;
	status: 'added' | 'deleted' | 'renamed' | 'modified' | 'binary';
	additions: number;
	deletions: number;
	lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(p: string): string | null {
	const s = p.trim();
	if (s === '/dev/null') return null;
	return s.replace(/^"?[ab]\//, '').replace(/"$/, '');
}

export function parseUnifiedDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	let cur: DiffFile | null = null;
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;

	const start = (header: string): DiffFile => {
		const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(header);
		const file: DiffFile = {
			path: m?.[2] ?? m?.[1] ?? header.slice(11),
			oldPath: m?.[1] ?? null,
			newPath: m?.[2] ?? null,
			status: 'modified',
			additions: 0,
			deletions: 0,
			lines: []
		};
		files.push(file);
		inHunk = false;
		return file;
	};

	for (const raw of text.split('\n')) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (line.startsWith('diff --git ')) {
			cur = start(line);
			continue;
		}
		if (!cur) {
			// Diff ohne `diff --git`-Kopf (z. B. reines `---/+++`)
			if (line.startsWith('--- ')) cur = start('diff --git a/? b/?');
			else continue;
		}
		const f: DiffFile = cur;
		const hunk = HUNK.exec(line);
		if (hunk) {
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[2]);
			inHunk = true;
			f.lines.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
			continue;
		}
		if (!inHunk) {
			if (line.startsWith('new file mode')) f.status = 'added';
			else if (line.startsWith('deleted file mode')) f.status = 'deleted';
			else if (line.startsWith('rename from ')) {
				f.status = 'renamed';
				f.oldPath = line.slice(12);
			} else if (line.startsWith('rename to ')) {
				f.newPath = line.slice(10);
				f.path = f.newPath;
			} else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch'))
				f.status = 'binary';
			else if (line.startsWith('--- ')) {
				f.oldPath = stripPrefix(line.slice(4));
			} else if (line.startsWith('+++ ')) {
				f.newPath = stripPrefix(line.slice(4));
				f.path = f.newPath ?? f.oldPath ?? f.path;
				if (!f.oldPath && f.status === 'modified') f.status = 'added';
				if (!f.newPath && f.status === 'modified') f.status = 'deleted';
			}
			continue;
		}
		if (line.startsWith('+')) {
			f.additions++;
			f.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
		} else if (line.startsWith('-')) {
			f.deletions++;
			f.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
		} else if (line.startsWith(' ')) {
			f.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
		} else if (line.startsWith('\\')) {
			f.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
		} else if (line === '') {
			// Leerzeile am Ende oder leere Kontextzeile ohne Leerzeichen
			continue;
		} else {
			inHunk = false;
		}
	}
	return files;
}
