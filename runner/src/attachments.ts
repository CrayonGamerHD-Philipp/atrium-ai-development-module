/**
 * Anhänge eines Laufs: Bytes von Atrium laden (`RunnerApi.attachment`, Größe/SHA-256 geprüft) und im Worktree unter
 * `.aidev/attachments/` ablegen. `.aidev/` wird in `info/exclude` des Repositorys eingetragen, damit
 * `git add -A` (`commitAll`) die Dateien in keinem Auslieferungsmodus committet.
 */
import { appendFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './git/workspace.ts';
import type { AttachmentOffer } from './protocol.ts';

/** Ablage relativ zum Worktree (Pfadtrenner `/`, wie im Prompt-Hinweis) */
export const ATTACHMENTS_DIR = '.aidev/attachments';
/** Eintrag in `info/exclude` */
export const AIDEV_EXCLUDE = '/.aidev/';

const MAX_NAME = 120;
const FALLBACK = 'datei';
/** Unter Windows reservierte Gerätenamen (auch mit Endung) */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Dateinamen für die Ablage absichern: nur der letzte Pfadteil, keine Steuer-/Sonderzeichen, kein führender Punkt
 * (kein `..`, keine versteckten Dateien), höchstens 120 Zeichen unter Erhalt der Endung; leer → `datei`.
 */
export function safeAttachmentName(raw: string): string {
	let name = raw.normalize('NFC').split(/[/\\]/).pop() ?? '';
	// eslint-disable-next-line no-control-regex
	name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_');
	name = name.replace(/\s+/g, ' ').trim();
	name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
	if (!name) return FALLBACK;
	if (RESERVED.test(name)) name = `_${name}`;
	return clipName(name, MAX_NAME);
}

/** Auf `max` Zeichen kürzen, Endung (bis 16 Zeichen) möglichst erhalten */
function clipName(name: string, max: number): string {
	const chars = [...name];
	if (chars.length <= max) return name;
	const dot = name.lastIndexOf('.');
	const ext = dot > 0 ? name.slice(dot) : '';
	if (ext && [...ext].length <= 16) {
		const stem = [...name.slice(0, dot)].slice(0, max - [...ext].length).join('');
		return `${stem.replace(/[.\s]+$/, '') || FALLBACK}${ext}`;
	}
	return chars.slice(0, max).join('').replace(/[.\s]+$/, '') || FALLBACK;
}

/** Abgesicherte, eindeutige Namen (Groß-/Kleinschreibung egal): Duplikate werden zu `name (2).ext` usw. */
export function uniqueAttachmentNames(names: readonly string[]): string[] {
	const used = new Set<string>();
	return names.map((raw) => {
		const safe = safeAttachmentName(raw);
		const dot = safe.lastIndexOf('.');
		const stem = dot > 0 ? safe.slice(0, dot) : safe;
		const ext = dot > 0 ? safe.slice(dot) : '';
		let candidate = safe;
		for (let n = 2; used.has(candidate.toLowerCase()); n++) {
			const suffix = ` (${n})`;
			candidate = `${clipName(stem, MAX_NAME - suffix.length - [...ext].length)}${suffix}${ext}`;
		}
		used.add(candidate.toLowerCase());
		return candidate;
	});
}

/**
 * `.aidev/` in `info/exclude` eintragen. Bei Worktrees liegt die Datei im gemeinsamen git-dir (Cache) –
 * `git rev-parse --git-path info/exclude` liefert den Pfad, den git tatsächlich liest.
 */
export async function excludeAidevDir(ws: Workspace, dir: string): Promise<string> {
	const r = await ws.run(dir, ['rev-parse', '--git-path', 'info/exclude']);
	const file = path.resolve(dir, r.stdout.trim());
	await mkdir(path.dirname(file), { recursive: true });
	const current = await readFile(file, 'utf8').catch(() => '');
	const lines = current.split(/\r?\n/).map((l) => l.trim());
	if (!lines.includes(AIDEV_EXCLUDE) && !lines.includes('.aidev/') && !lines.includes('.aidev')) {
		const sep = current && !current.endsWith('\n') ? '\n' : '';
		await appendFile(file, `${sep}# Atrium aidev: Anhänge der Läufe\n${AIDEV_EXCLUDE}\n`, 'utf8');
	}
	return file;
}

export interface StoredAttachment {
	/** Pfad relativ zum Worktree, z. B. `.aidev/attachments/bild.png` */
	path: string;
	name: string;
	mime: string;
	size: number;
}

/** Bricht ab, wenn ein Teil des Ablagepfads ein symbolischer Link ist (z. B. aus dem Repo) */
async function assertNoSymlink(dir: string, rel: string): Promise<void> {
	let cur = dir;
	for (const part of rel.split('/')) {
		cur = path.join(cur, part);
		const st = await lstat(cur).catch(() => null);
		if (st?.isSymbolicLink()) throw new Error(`${rel} ist ein symbolischer Link – Ablage verweigert`);
	}
}

/**
 * Alle Anhänge laden und nach `<dir>/.aidev/attachments/` schreiben (vorhandene Ablage wird ersetzt).
 * `fetch` liefert die geprüften Bytes eines Anhangs; Fehler werden mit dem Dateinamen weitergereicht.
 */
export async function storeAttachments(
	dir: string,
	attachments: readonly AttachmentOffer[],
	fetch: (a: AttachmentOffer) => Promise<Buffer>
): Promise<StoredAttachment[]> {
	await assertNoSymlink(dir, ATTACHMENTS_DIR);
	const target = path.join(dir, ...ATTACHMENTS_DIR.split('/'));
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	const names = uniqueAttachmentNames(attachments.map((a) => a.name));
	const out: StoredAttachment[] = [];
	for (const [i, a] of attachments.entries()) {
		const name = names[i] ?? FALLBACK;
		let bytes: Buffer;
		try {
			bytes = await fetch(a);
		} catch (e) {
			throw new AttachmentError(a.name, e);
		}
		const file = path.join(target, name);
		// Doppelte Absicherung gegen Pfad-Traversal
		if (path.dirname(file) !== target) throw new AttachmentError(a.name, new Error('ungültiger Dateiname'));
		await writeFile(file, bytes, { flag: 'wx' });
		out.push({ path: `${ATTACHMENTS_DIR}/${name}`, name, mime: a.mime, size: a.size });
	}
	return out;
}

/** Fehler beim Laden eines Anhangs (Dateiname + Ursache) */
export class AttachmentError extends Error {
	constructor(
		readonly attachmentName: string,
		cause: unknown
	) {
		const status = cause instanceof Error && 'status' in cause ? ` (HTTP ${String(cause.status)})` : '';
		super(`Anhang „${attachmentName}“${status}: ${cause instanceof Error ? cause.message : String(cause)}`, {
			cause
		});
		this.name = 'AttachmentError';
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/**
 * Hinweis für den Prompt. Enthält der Auftrag schon einen Hinweis des Backends (Pfad `.aidev/attachments/`),
 * wird keiner ergänzt (keine Doppelung).
 */
export function attachmentPromptHint(prompt: string, stored: readonly StoredAttachment[]): string | null {
	if (!stored.length || prompt.includes(`${ATTACHMENTS_DIR}/`)) return null;
	const lines = stored.map((s) => `- \`${s.path}\` (${s.mime}, ${formatSize(s.size)})`);
	return [
		'## Anhänge',
		'',
		'Zum Auftrag gehören diese Dateien (relativ zum Arbeitsverzeichnis). Lies sie bei Bedarf; Bilder kannst du mit',
		'deinem Datei-Werkzeug ansehen. Die Dateien liegen außerhalb der Versionskontrolle – nicht committen, verschieben',
		'oder ins Repository kopieren, außer der Auftrag verlangt das ausdrücklich.',
		'',
		...lines
	].join('\n');
}
