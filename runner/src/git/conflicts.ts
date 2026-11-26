/**
 * Merge-Konflikte im Worktree eines Laufs eigenständig lösen lassen: Ziel-Branch hineinmergen (Konfliktmarker
 * bleiben stehen), den Agent die Dateien bereinigen lassen, prüfen und den Merge abschließen.
 *
 * Bewusst Merge statt Rebase: Ein Merge löst alle Konflikte in einem Durchgang; ein Rebase müsste dieselben
 * Stellen Commit für Commit erneut auflösen. Danach ist der Ziel-Stand Vorfahre von HEAD, die Auslieferung
 * (Push, `--no-ff`-Merge, Fast-Forward auf den Haupt-Branch) läuft ohne erneuten Konflikt.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { conflictFiles } from './delivery.ts';
import type { Workspace } from './workspace.ts';

export interface MergeStart {
	/** Merge lief ohne Konflikt durch (bereits committet) bzw. Ziel war schon enthalten */
	clean: boolean;
	/** Dateien mit Konflikten (nur bei `clean: false`) */
	files: string[];
}

/** Ist `ancestor` Vorfahre von (oder gleich) `HEAD`? */
export async function isAncestor(ws: Workspace, dir: string, ancestor: string): Promise<boolean> {
	const r = await ws.run(dir, ['merge-base', '--is-ancestor', ancestor, 'HEAD'], { allowFail: true });
	return r.code === 0;
}

/** Läuft im Worktree gerade ein Merge (MERGE_HEAD vorhanden)? */
export async function mergeInProgress(ws: Workspace, dir: string): Promise<boolean> {
	const r = await ws.run(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { allowFail: true });
	return r.code === 0;
}

/**
 * `target` (SHA oder Ref) in HEAD mergen. Ohne Konflikt wird sofort committet; mit Konflikt bleibt der Merge offen
 * (Marker in den Dateien) und die Dateiliste wird geliefert. Andere Fehler werfen.
 */
export async function startMerge(ws: Workspace, dir: string, target: string, message: string): Promise<MergeStart> {
	if (await isAncestor(ws, dir, target)) return { clean: true, files: [] };
	const r = await ws.run(dir, ['merge', '--no-ff', '--no-edit', '-m', message, target], {
		allowFail: true,
		config: ws.noHooks
	});
	if (r.code === 0) return { clean: true, files: [] };
	const files = await conflictFiles(ws, dir);
	if (!files.length) {
		await ws.run(dir, ['merge', '--abort'], { allowFail: true });
		throw new Error(`Merge von ${target.slice(0, 40)} fehlgeschlagen: ${(r.stderr || r.stdout).trim().slice(-1500)}`);
	}
	return { clean: false, files };
}

const MARKER = /^(<{7}|>{7})(?: |$)|^={7}$/m;

/**
 * Nach der Bearbeitung durch den Agent: Liefert die Dateien, die noch ungelöst sind (Status „unmerged“ oder noch
 * Konfliktmarker in einer der ursprünglich betroffenen Dateien).
 */
export async function unresolvedFiles(ws: Workspace, dir: string, files: readonly string[]): Promise<string[]> {
	const out = new Set(await conflictFiles(ws, dir));
	for (const f of files) {
		const text = await readFile(path.join(dir, f), 'utf8').catch(() => null);
		if (text !== null && MARKER.test(text)) out.add(f);
	}
	return [...out];
}

/**
 * Merge abschließen: alle Änderungen vormerken (ohne `exclude`) und committen – auch wenn der Agent den Merge
 * schon selbst committet hat (dann nichts zu tun). Liefert true, wenn ein Commit entstand.
 */
export async function concludeMerge(
	ws: Workspace,
	dir: string,
	message: string,
	exclude: readonly string[] = []
): Promise<boolean> {
	const inProgress = await mergeInProgress(ws, dir);
	await ws.run(dir, ['add', '-A']);
	if (exclude.length) await ws.run(dir, ['reset', '--quiet', '--', ...exclude], { allowFail: true });
	if (!inProgress) {
		const staged = await ws.run(dir, ['diff', '--cached', '--quiet'], { allowFail: true });
		if (staged.code === 0) return false;
	}
	await ws.run(dir, ['commit', '--quiet', '--no-verify', '-F', '-'], { input: `${message}\n`, config: ws.noHooks });
	return true;
}

/** Offenen Merge verwerfen (best effort) */
export async function abortMerge(ws: Workspace, dir: string): Promise<void> {
	if (await mergeInProgress(ws, dir)) await ws.run(dir, ['merge', '--abort'], { allowFail: true });
}
