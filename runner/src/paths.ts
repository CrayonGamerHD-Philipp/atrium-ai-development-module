/**
 * Pfad-Jail für Editor-RPCs: Jeder Pfad wird relativ zum Wurzelverzeichnis (Worktree bzw. Arbeitskopie) aufgelöst
 * und per `realpath` geprüft. Absolute Pfade, `..`, Symlinks nach außen und Schreibzugriffe auf `.git` sind verboten.
 */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export class PathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PathError';
	}
}

export interface JailedPath {
	/** Absoluter Pfad im Dateisystem */
	abs: string;
	/** Normalisierter relativer Pfad mit `/` (leer = Wurzel) */
	rel: string;
}

function isInside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Prüft Syntax des relativen Pfads und liefert die Segmente */
export function splitRelative(input: string): string[] {
	if (typeof input !== 'string') throw new PathError('Pfad fehlt');
	if (input.includes('\0')) throw new PathError('Ungültiges Zeichen im Pfad');
	if (input.length > 4096) throw new PathError('Pfad zu lang');
	const p = input.replace(/\\/g, '/');
	if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || path.isAbsolute(input))
		throw new PathError('Absolute Pfade sind nicht erlaubt');
	const segs = p.split('/').filter((s) => s !== '' && s !== '.');
	if (segs.some((s) => s === '..')) throw new PathError('„..“ ist im Pfad nicht erlaubt');
	return segs;
}

/** Löst `rel` innerhalb von `root` auf. `write`: Ziel darf nicht in `.git` liegen. */
export async function resolveInJail(
	root: string,
	rel: string,
	opts: { write?: boolean } = {}
): Promise<JailedPath> {
	const segs = splitRelative(rel ?? '');
	if (opts.write && segs.some((s) => s.toLowerCase() === '.git'))
		throw new PathError('Schreibzugriff auf .git ist nicht erlaubt');
	let rootReal: string;
	try {
		rootReal = await realpath(root);
	} catch {
		throw new PathError('Arbeitsverzeichnis nicht gefunden');
	}
	const abs = path.join(rootReal, ...segs);
	if (!isInside(rootReal, abs)) throw new PathError('Pfad liegt außerhalb des Arbeitsverzeichnisses');

	// Tiefsten existierenden Vorfahren (bzw. das Ziel selbst) auflösen und prüfen
	let probe = abs;
	for (;;) {
		try {
			await lstat(probe);
			break;
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) break;
			probe = parent;
		}
	}
	let probeReal: string;
	try {
		probeReal = await realpath(probe);
	} catch {
		// z. B. Symlink, dessen Ziel nicht existiert
		throw new PathError('Pfad zeigt auf ein nicht vorhandenes oder ungültiges Ziel');
	}
	if (!isInside(rootReal, probeReal))
		throw new PathError('Pfad zeigt (über einen Symlink) außerhalb des Arbeitsverzeichnisses');
	if (opts.write) {
		const relReal = path.relative(rootReal, probeReal).split(path.sep);
		if (relReal.some((s) => s.toLowerCase() === '.git'))
			throw new PathError('Schreibzugriff auf .git ist nicht erlaubt');
	}
	return { abs, rel: segs.join('/') };
}
