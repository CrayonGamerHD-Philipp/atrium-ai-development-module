/**
 * Anhänge eines Entwurfs (Chat-Nachricht oder Auftrag): Dateien hinzufügen (Auswahl, Strg+V, Drag & Drop), sofort
 * einzeln hochladen (`POST /projects/:id/attachments`, Multipart-Feld `file`), Fortschritt und Fehler je Datei,
 * Entfernen, Bildvorschau per Objekt-URL. Beim Absenden `ids` mitsenden und danach `clear()` aufrufen.
 */
import { ApiClientError } from '$lib/sdk/client';
import type { AttachmentDto } from '../../schemas';
import {
	attachmentUploadUrl,
	checkFiles,
	isPreviewImage,
	pastedFileName,
	rejectionMessage,
	transferFiles,
	transferHasFiles,
	type TransferLike
} from './attachments';

export type DraftStatus = 'uploading' | 'done' | 'error';

export interface DraftAttachment {
	/** lokale ID (für `{#each}`), nicht die Server-ID */
	key: string;
	name: string;
	size: number;
	mime: string;
	status: DraftStatus;
	/** Upload-Fortschritt 0..1 */
	progress: number;
	error: string;
	/** Objekt-URL der lokalen Vorschau (nur Rasterbilder) */
	preview: string | null;
	/** nach erfolgreichem Upload */
	attachment: AttachmentDto | null;
}

let seq = 0;

/** Fehlertext einer Upload-Antwort (`{ error: { message } }` nach SDK-Konvention) */
function uploadError(status: number, text: string): string {
	let message = '';
	try {
		message = (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? '';
	} catch {
		// keine JSON-Antwort
	}
	if (message) return message;
	if (status === 413) return 'Die Datei ist zu groß.';
	if (status === 403) return 'Keine Berechtigung zum Hochladen.';
	if (status === 0) return 'Keine Verbindung zum Server.';
	return `Hochladen fehlgeschlagen (${status}).`;
}

/** Eine Datei per XHR hochladen (Fortschritt über `upload.onprogress`) */
function upload(
	projectId: string,
	file: File,
	name: string,
	onprogress: (p: number) => void
): { promise: Promise<AttachmentDto>; abort: () => void } {
	const xhr = new XMLHttpRequest();
	const promise = new Promise<AttachmentDto>((resolve, reject) => {
		xhr.open('POST', attachmentUploadUrl(projectId));
		xhr.withCredentials = true;
		xhr.responseType = 'text';
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && e.total > 0) onprogress(e.loaded / e.total);
		};
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				try {
					resolve((JSON.parse(xhr.responseText) as { data: AttachmentDto }).data);
				} catch {
					reject(new ApiClientError(xhr.status, 'invalid_response', 'Ungültige Serverantwort.'));
				}
			} else
				reject(
					new ApiClientError(xhr.status, 'upload_failed', uploadError(xhr.status, xhr.responseText))
				);
		};
		xhr.onerror = () => reject(new ApiClientError(0, 'network', uploadError(0, '')));
		xhr.onabort = () => reject(new ApiClientError(0, 'aborted', 'Abgebrochen.'));
		const form = new FormData();
		form.append('file', file, name);
		xhr.send(form);
	});
	return { promise, abort: () => xhr.abort() };
}

export class AttachmentDraft {
	items = $state<DraftAttachment[]>([]);
	/** Dateien werden gerade über die Fläche gezogen (Drop-Zone hervorheben) */
	dragging = $state(false);
	/** Letzte Meldung (abgelehnte Dateien) – für eine Live-Region bzw. einen Toast */
	notice = $state('');

	/** laufende Uploads → Absenden sperren */
	readonly uploading = $derived(this.items.some((i) => i.status === 'uploading'));
	readonly hasErrors = $derived(this.items.some((i) => i.status === 'error'));
	/** Server-IDs der fertig hochgeladenen Anhänge in Anzeigereihenfolge */
	readonly ids = $derived(
		this.items.flatMap((i) => (i.status === 'done' && i.attachment ? [i.attachment.id] : []))
	);
	readonly count = $derived(this.items.length);

	#aborts = new Map<string, () => void>();
	#depth = 0;

	#projectId: () => string;
	#onreject?: (message: string) => void;

	/** `projectId` als Getter (Projektwechsel), `onreject` meldet abgelehnte Dateien (z. B. per Toast) */
	constructor(projectId: () => string, onreject?: (message: string) => void) {
		this.#projectId = projectId;
		this.#onreject = onreject;
	}

	/** Dateien hinzufügen (Grenzen prüfen, Namen vergeben, Upload starten); `pasted` = aus der Zwischenablage */
	add(files: readonly File[], opts: { pasted?: boolean } = {}) {
		if (!files.length) return;
		// fehlerhafte Einträge zählen nicht gegen die Grenze, sie werden nicht mitgesendet
		const active = this.items.filter((i) => i.status !== 'error').length;
		const { accepted, rejected } = checkFiles(active, files);
		const now = new Date();
		accepted.forEach((file, index) => {
			const name = opts.pasted
				? pastedFileName(file.name, file.type, now, accepted.length > 1 ? index : 0)
				: file.name || pastedFileName('', file.type, now, index);
			this.#start(file, name);
		});
		this.notice = rejected.length ? rejectionMessage(rejected) : '';
		if (rejected.length) this.#onreject?.(this.notice);
	}

	#start(file: File, name: string) {
		const key = `a${++seq}`;
		const mime = file.type || 'application/octet-stream';
		this.items.push({
			key,
			name,
			size: file.size,
			mime,
			status: 'uploading',
			progress: 0,
			error: '',
			preview:
				isPreviewImage(mime) && typeof URL !== 'undefined' ? URL.createObjectURL(file) : null,
			attachment: null
		});
		const { promise, abort } = upload(this.#projectId(), file, name, (p) =>
			this.#update(key, { progress: p })
		);
		this.#aborts.set(key, abort);
		promise.then(
			(attachment) => this.#update(key, { status: 'done', progress: 1, attachment }),
			(err: unknown) => {
				if (err instanceof ApiClientError && err.code === 'aborted') return;
				this.#update(key, {
					status: 'error',
					error: err instanceof Error && err.message ? err.message : 'Hochladen fehlgeschlagen.'
				});
			}
		);
		promise.catch(() => {}).finally(() => this.#aborts.delete(key));
	}

	#update(key: string, patch: Partial<DraftAttachment>) {
		const item = this.items.find((i) => i.key === key);
		if (item) Object.assign(item, patch);
	}

	/** Anhang entfernen (laufenden Upload abbrechen, Vorschau freigeben) */
	remove(key: string) {
		const item = this.items.find((i) => i.key === key);
		if (!item) return;
		this.#aborts.get(key)?.();
		this.#aborts.delete(key);
		if (item.preview) URL.revokeObjectURL(item.preview);
		this.items = this.items.filter((i) => i.key !== key);
	}

	/** Alles zurücksetzen (nach dem Absenden bzw. beim Verlassen) */
	clear() {
		for (const abort of this.#aborts.values()) abort();
		this.#aborts.clear();
		for (const i of this.items) if (i.preview) URL.revokeObjectURL(i.preview);
		this.items = [];
		this.notice = '';
		this.dragging = false;
		this.#depth = 0;
	}

	// --- Ereignisse ---------------------------------------------------------------------------

	/** `paste`: nur Dateien übernehmen; reines Textkleben bleibt unverändert */
	onpaste = (e: ClipboardEvent) => {
		const files = transferFiles(e.clipboardData as TransferLike<File> | null);
		if (!files.length) return;
		e.preventDefault();
		this.add(files, { pasted: true });
	};

	ondragenter = (e: DragEvent) => {
		if (!transferHasFiles(e.dataTransfer)) return;
		e.preventDefault();
		this.#depth++;
		this.dragging = true;
	};

	ondragover = (e: DragEvent) => {
		if (!transferHasFiles(e.dataTransfer)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		this.dragging = true;
	};

	ondragleave = (e: DragEvent) => {
		if (!transferHasFiles(e.dataTransfer)) return;
		this.#depth = Math.max(0, this.#depth - 1);
		if (this.#depth === 0) this.dragging = false;
	};

	ondrop = (e: DragEvent) => {
		const has = transferHasFiles(e.dataTransfer);
		this.#depth = 0;
		this.dragging = false;
		if (!has) return;
		e.preventDefault();
		this.add(transferFiles(e.dataTransfer as TransferLike<File> | null));
	};
}
