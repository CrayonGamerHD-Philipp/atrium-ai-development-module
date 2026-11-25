/**
 * Dateianhänge (Migration 0011): Upload als `bytea`, Verknüpfung mit Auftrag bzw. Chatnachricht, geerbte Anhänge
 * und Aufräumen unverknüpfter Uploads.
 *
 * - Ein Upload ist zunächst unverknüpft. Beim Anlegen eines Auftrags bzw. einer Nachricht werden die IDs in derselben
 *   Transaktion geprüft (gleiches Projekt, eigener Upload, noch unverknüpft) und geordnet verknüpft.
 * - Teilaufträge (und Konfliktlösungen) sehen die Anhänge ihrer Elternkette (Abfrage über `parent_id`, keine Kopie).
 * - „Umsetzen“ (`replyTo`) und übernommene Vorschläge „Auftrag anlegen“ verknüpfen die Anhänge des
 *   Ursprungsauftrags zusätzlich mit dem neuen Auftrag (nur Zuordnungszeilen, die Bytes bleiben einmalig), weil es
 *   dafür keine Kette in der Datenbank gibt.
 * - Unverknüpfte Uploads löscht der Job `attachment-cleanup` nach 24 Stunden; Projekt löschen → CASCADE.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
	detectContentType,
	errors,
	inList,
	num,
	rowsOf,
	safeFileName,
	str,
	type Row
} from '$lib/sdk/server';
import { oneOf, type Tx } from './db';
import { attachmentDto } from './mappers';
import {
	ATTACHMENT_NAME_MAX,
	safeAttachmentName,
	uniqueAttachmentNames as uniqueFileNames
} from './protocol';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, type AttachmentDto } from './schemas';

/** Höchstlänge eines gespeicherten Dateinamens (gemeinsam mit dem Runner) */
export { ATTACHMENT_NAME_MAX };
/** Unverknüpfte Uploads werden nach dieser Zeit gelöscht */
export const ATTACHMENT_ORPHAN_HOURS = 24;
/** Höchstzahl unverknüpfter Uploads je Person und Projekt (Schutz vor vollgelaufener Datenbank) */
export const ATTACHMENT_MAX_PENDING = 50;

/** Rasterbilder mit Signaturprüfung; nur sie dürfen inline (Vorschau) ausgeliefert werden */
export const RASTER_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const OCTET = 'application/octet-stream';

/**
 * Sicherer Dateiname (auch Name der Datei beim Runner): nur der letzte Pfadteil, Steuerzeichen entfernt, über
 * `safeFileName` auf `A–Z a–z 0–9 . _ -` reduziert (Umlaute ausgeschrieben), höchstens 120 Zeichen unter Erhalt der
 * Endung; leere oder problematische Namen (`.`, `..`) → `datei`.
 * Danach gilt `safeAttachmentName` (`protocol.ts`), z. B. `con.txt` → `_con.txt`.
 */
export function sanitizeAttachmentName(raw: string): string {
	const base = String(raw ?? '')
		.replace(/\p{Cc}/gu, '')
		.split(/[/\\]/)
		.pop()!;
	// zusätzlich die gemeinsame Regel (z. B. reservierte Gerätenamen), damit der Runner den Namen unverändert übernimmt
	return safeAttachmentName(
		safeFileName(base, { maxLength: ATTACHMENT_NAME_MAX, german: true, fallback: 'datei' })
	);
}

/**
 * Wirksamer MIME-Typ: Rasterbilder müssen zur Signatur passen (sonst 422); fehlende oder ungültige Angaben werden
 * aus dem Inhalt erkannt bzw. als `application/octet-stream` behandelt.
 */
export function attachmentMime(declared: string | null | undefined, bytes: Uint8Array): string {
	const type = (declared ?? '').split(';')[0]!.trim().toLowerCase();
	const detected = detectContentType(bytes);
	if ((RASTER_IMAGE_TYPES as readonly string[]).includes(type)) {
		if (detected !== type) {
			throw errors.validation([{ path: ['file'], message: 'Der Inhalt passt nicht zum Bildtyp' }]);
		}
		return type;
	}
	if (!type || type === OCTET || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type)) {
		return detected ?? OCTET;
	}
	return type.slice(0, 100);
}

/** SHA-256 als Hex (Web Crypto) */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Spalten ohne Bytes */
const META = sql`a.id, a.project_id, a.uploaded_by, a.name, a.mime, a.size, a.sha256, a.created_at`;

/** Bytes aus der Datenbank (Treiber liefern `Buffer`/`Uint8Array`, ältere Pfade evtl. Hex-Text) */
export function bytesOf(v: unknown): Uint8Array {
	if (v instanceof Uint8Array) return v;
	if (typeof v === 'string' && v.startsWith('\\x')) {
		return Uint8Array.from(v.slice(2).match(/../g) ?? [], (h) => parseInt(h, 16));
	}
	throw new Error('Unerwartetes Format der Anhangsdaten');
}

// ---------------------------------------------------------------- Upload

/** Zuschlag für Multipart-Grenzen und Kopfzeilen beim Einlesen eines Uploads */
export const ATTACHMENT_BODY_OVERHEAD = 1024 * 1024;

/**
 * Request-Body gestreamt mit Byte-Zähler einlesen und bei mehr als `maxBytes` sofort mit 413 abbrechen – auch ohne
 * bzw. mit falschem `content-length` (z. B. `Transfer-Encoding: chunked`). Liefert einen gleichwertigen Request mit
 * gepuffertem Body für `readUpload`; im Speicher landet so höchstens `maxBytes` (+ ein Chunk).
 */
export async function limitedUploadRequest(
	request: Request,
	maxBytes = ATTACHMENT_MAX_BYTES + ATTACHMENT_BODY_OVERHEAD
): Promise<Request> {
	const tooLarge = () => errors.tooLarge('Die Datei ist zu groß (höchstens 10 MB).');
	const declared = Number(request.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
	const chunks: Uint8Array[] = [];
	let total = 0;
	if (request.body) {
		const reader = request.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				// Rest nicht mehr lesen; Fehler beim Abbrechen sind bedeutungslos
				await reader.cancel().catch(() => undefined);
				throw tooLarge();
			}
			chunks.push(value);
		}
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		body.set(c, offset);
		offset += c.byteLength;
	}
	const headers = new Headers(request.headers);
	headers.set('content-length', String(total));
	return new Request(request.url, { method: request.method, headers, body });
}

export interface NewAttachment {
	projectId: string;
	userId: string | null;
	name: string;
	mime: string;
	bytes: Uint8Array;
}

/** Upload speichern (unverknüpft). Prüft Größe und die Zahl offener Uploads der Person im Projekt. */
export async function insertAttachment(tx: Tx, input: NewAttachment): Promise<Row> {
	const size = input.bytes.byteLength;
	if (size < 1) throw errors.validation([{ path: ['file'], message: 'Die Datei ist leer' }]);
	if (size > ATTACHMENT_MAX_BYTES)
		throw errors.tooLarge('Die Datei ist zu groß (höchstens 10 MB).');
	const pending = await oneOf(
		tx,
		sql`SELECT count(*) AS n FROM attachment a
			WHERE a.project_id = ${input.projectId} AND a.uploaded_by IS NOT DISTINCT FROM ${input.userId}
				AND ${unlinked(sql`a`)}`
	);
	if (num(pending?.n) >= ATTACHMENT_MAX_PENDING) {
		throw errors.conflict(
			'Zu viele noch nicht verwendete Anhänge – bitte zuerst senden oder entfernen'
		);
	}
	const id = crypto.randomUUID();
	const sha = await sha256Hex(input.bytes);
	await tx.execute(
		sql`INSERT INTO attachment (id, project_id, uploaded_by, name, mime, size, sha256, bytes)
			VALUES (${id}, ${input.projectId}, ${input.userId}, ${sanitizeAttachmentName(input.name)},
				${input.mime}, ${size}, ${sha}, ${Buffer.from(input.bytes.buffer, input.bytes.byteOffset, size)})`
	);
	return (await oneOf(tx, sql`SELECT ${META} FROM attachment a WHERE a.id = ${id}`))!;
}

/** Bedingung „nirgends verknüpft“ für den Alias `a` */
function unlinked(alias: SQL) {
	return sql`NOT EXISTS (SELECT 1 FROM task_attachment ta WHERE ta.attachment_id = ${alias}.id)
		AND NOT EXISTS (SELECT 1 FROM chat_attachment ca WHERE ca.attachment_id = ${alias}.id)`;
}

/** Anhang mit Metadaten (ohne Bytes) oder `null` */
export async function getAttachment(tx: Tx, id: string): Promise<Row | null> {
	return oneOf(
		tx,
		sql`SELECT ${META}, ${unlinked(sql`a`)} AS unlinked FROM attachment a WHERE a.id = ${id}`
	);
}

/** Bytes eines Anhangs */
export async function attachmentBytes(tx: Tx, id: string): Promise<Uint8Array> {
	const row = await oneOf(tx, sql`SELECT bytes FROM attachment WHERE id = ${id}`);
	if (!row) throw errors.notFound('Anhang nicht gefunden');
	return bytesOf(row.bytes);
}

/** Eigener, noch unverknüpfter Upload löschen (sonst 404 bzw. 409) */
export async function deleteOwnAttachment(tx: Tx, id: string, userId: string | null): Promise<Row> {
	const row = await oneOf(
		tx,
		sql`SELECT ${META}, ${unlinked(sql`a`)} AS unlinked FROM attachment a WHERE a.id = ${id} FOR UPDATE`
	);
	if (!row || str(row.uploaded_by) !== userId || userId === null) {
		throw errors.notFound('Anhang nicht gefunden');
	}
	if (row.unlinked !== true) throw errors.conflict('Der Anhang wird bereits verwendet');
	await tx.execute(sql`DELETE FROM attachment WHERE id = ${id}`);
	return row;
}

// ---------------------------------------------------------------- Verknüpfen

export interface LinkTarget {
	projectId: string;
	userId: string | null;
	taskId?: string | null;
	chatMessageId?: string | null;
}

/** Fehler zu `attachmentIds` (422) */
const linkError = (message: string) => errors.validation([{ path: ['attachmentIds'], message }]);

/**
 * Uploads prüfen und mit Auftrag und/oder Chatnachricht verknüpfen (Reihenfolge = Reihenfolge der IDs). Nur
 * Uploads desselben Projekts, derselben Person und noch unverknüpft; sonst 422 ohne Verknüpfung.
 */
export async function linkAttachments(tx: Tx, ids: string[], target: LinkTarget): Promise<void> {
	const list = [...new Set(ids)];
	if (!list.length) return;
	if (list.length > ATTACHMENT_MAX_FILES) {
		throw linkError(`Höchstens ${ATTACHMENT_MAX_FILES} Anhänge`);
	}
	const rows = await rowsOf(
		tx,
		sql`SELECT a.id, a.project_id, a.uploaded_by, ${unlinked(sql`a`)} AS unlinked
			FROM attachment a WHERE a.id IN (${inList(list)}) FOR UPDATE`
	);
	const usable = rows.filter(
		(r) =>
			String(r.project_id) === target.projectId &&
			target.userId !== null &&
			str(r.uploaded_by) === target.userId &&
			r.unlinked === true
	);
	if (usable.length !== list.length) {
		throw linkError(
			'Unbekannter oder bereits verwendeter Anhang (nur eigene Uploads dieses Projekts)'
		);
	}
	for (const [position, id] of list.entries()) {
		if (target.taskId) {
			await tx.execute(
				sql`INSERT INTO task_attachment (task_id, attachment_id, position)
					VALUES (${target.taskId}, ${id}, ${position})`
			);
		}
		if (target.chatMessageId) {
			await tx.execute(
				sql`INSERT INTO chat_attachment (chat_message_id, attachment_id, position)
					VALUES (${target.chatMessageId}, ${id}, ${position})`
			);
		}
	}
}

/**
 * Anhänge eines Ursprungsauftrags (samt Elternkette) zusätzlich mit einem neuen Auftrag verknüpfen (hinter dessen
 * eigenen Anhängen). Mehr als `ATTACHMENT_MAX_FILES` zusammen → 422.
 */
export async function shareTaskAttachments(tx: Tx, fromTaskId: string, toTaskId: string) {
	const inherited = (await effectiveAttachmentRows(tx, [fromTaskId])).get(fromTaskId) ?? [];
	if (!inherited.length) return;
	const own = await rowsOf(
		tx,
		sql`SELECT attachment_id, position FROM task_attachment WHERE task_id = ${toTaskId}`
	);
	const known = new Set(own.map((r) => String(r.attachment_id)));
	const add = inherited.filter((r) => !known.has(String(r.id)));
	if (own.length + add.length > ATTACHMENT_MAX_FILES) {
		throw linkError(
			`Zusammen mit den Anhängen des Ursprungsauftrags höchstens ${ATTACHMENT_MAX_FILES} Anhänge`
		);
	}
	let position = own.reduce((max, r) => Math.max(max, num(r.position) + 1), 0);
	for (const r of add) {
		await tx.execute(
			sql`INSERT INTO task_attachment (task_id, attachment_id, position)
				VALUES (${toTaskId}, ${r.id}, ${position++})`
		);
	}
}

// ---------------------------------------------------------------- Lesen

/**
 * Wirksame Anhänge je Auftrag (ohne Bytes): eigene zuerst, dann die der Elternkette (nächster Vorfahre zuerst),
 * ohne Doppelte, höchstens `ATTACHMENT_MAX_FILES`.
 */
export async function effectiveAttachmentRows(
	tx: Tx,
	taskIds: string[]
): Promise<Map<string, Row[]>> {
	const map = new Map<string, Row[]>();
	if (!taskIds.length) return map;
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE chain (task_id, anc_id, depth) AS (
				SELECT id, id, 0 FROM task WHERE id IN (${inList(taskIds)})
				UNION ALL
				SELECT c.task_id, t.parent_id, c.depth + 1 FROM chain c
				JOIN task t ON t.id = c.anc_id
				WHERE t.parent_id IS NOT NULL AND c.depth < 20
			)
			SELECT c.task_id, ${META} FROM chain c
			JOIN task_attachment ta ON ta.task_id = c.anc_id
			JOIN attachment a ON a.id = ta.attachment_id
			ORDER BY c.task_id, c.depth, ta.position, a.created_at, a.id`
	);
	for (const r of rows) {
		const key = String(r.task_id);
		const list = map.get(key) ?? [];
		if (list.length < ATTACHMENT_MAX_FILES && !list.some((x) => String(x.id) === String(r.id))) {
			list.push(r);
		}
		map.set(key, list);
	}
	return map;
}

/** Wirksame Anhänge je Auftrag als DTOs */
export async function taskAttachmentsOf(
	tx: Tx,
	taskIds: string[]
): Promise<Map<string, AttachmentDto[]>> {
	const rows = await effectiveAttachmentRows(tx, taskIds);
	return new Map([...rows].map(([id, list]) => [id, list.map(attachmentDto)]));
}

/** Anhänge je Chatnachricht als DTOs */
export async function chatAttachmentsOf(
	tx: Tx,
	messageIds: string[]
): Promise<Map<string, AttachmentDto[]>> {
	const map = new Map<string, AttachmentDto[]>();
	if (!messageIds.length) return map;
	const rows = await rowsOf(
		tx,
		sql`SELECT ca.chat_message_id, ${META} FROM chat_attachment ca
			JOIN attachment a ON a.id = ca.attachment_id
			WHERE ca.chat_message_id IN (${inList(messageIds)})
			ORDER BY ca.chat_message_id, ca.position, a.created_at, a.id`
	);
	for (const r of rows) {
		const key = String(r.chat_message_id);
		map.set(key, [...(map.get(key) ?? []), attachmentDto(r)]);
	}
	return map;
}

/** Gehört der Anhang zum Auftrag oder seiner Elternkette? */
export async function taskHasAttachment(tx: Tx, taskId: string, attachmentId: string) {
	const list = (await effectiveAttachmentRows(tx, [taskId])).get(taskId) ?? [];
	return list.some((r) => String(r.id) === attachmentId);
}

// ---------------------------------------------------------------- Aufräumen

/** Unverknüpfte Uploads älter als `ATTACHMENT_ORPHAN_HOURS` löschen; liefert die Anzahl */
export async function deleteOrphanAttachments(tx: Tx): Promise<number> {
	const rows = await rowsOf(
		tx,
		sql`DELETE FROM attachment a
			WHERE a.created_at < now() - ${ATTACHMENT_ORPHAN_HOURS}::int * interval '1 hour'
				AND ${unlinked(sql`a`)}
			RETURNING a.id`
	);
	return rows.length;
}

/**
 * Eindeutige Dateinamen je Lauf (gleiche Namen, z. B. mehrere eingefügte `image.png`, → `image-2.png`) nach der
 * gemeinsamen Regel aus `protocol.ts`: Der Runner bildet aus den angebotenen Namen dieselben Namen für die Ablage in
 * `.aidev/attachments/`, Angebot und Prompt nutzen sie unverändert.
 */
export function uniqueAttachmentNames(rows: Row[]): Row[] {
	const names = uniqueFileNames(rows.map((r) => String(r.name)));
	return rows.map((r, i) => ({ ...r, name: names[i] }));
}
