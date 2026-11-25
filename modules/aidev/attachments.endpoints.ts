/**
 * Dateianhänge für Nutzer: Upload je Projekt (Multipart, ein Feld `file`), Download mit gehärteter Antwort und
 * Löschen noch unverknüpfter eigener Uploads. Verknüpft werden Uploads beim Anlegen von Auftrag bzw. Nachricht
 * (`attachmentIds`, siehe `attachments.service.ts`); den Runner bedient `GET /runner/runs/:id/attachments/:aid`.
 */
import { z } from 'zod';
import {
	type AnyApiEndpoint,
	defineEndpoint,
	errors,
	readUpload,
	secureFileResponse
} from '$lib/sdk/server';
import {
	attachmentBytes,
	attachmentMime,
	deleteOwnAttachment,
	getAttachment,
	insertAttachment,
	limitedUploadRequest,
	RASTER_IMAGE_TYPES
} from './attachments.service';
import { mdb } from './db';
import { attachmentDto } from './mappers';
import { requireProject } from './projects.service';
import { ATTACHMENT_MAX_BYTES, idParams, PERM, type AttachmentDto } from './schemas';

const tags = ['Modul: aidev – Anhänge'];

const downloadQuery = z.object({
	/** `true` → immer als Download (`attachment`), auch bei Bildern */
	download: z
		.enum(['true', 'false', '1', '0'])
		.optional()
		.transform((v) => v === 'true' || v === '1')
});

export const attachmentEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'POST',
		path: '/projects/:id/attachments',
		summary: 'Datei für einen Auftrag oder eine Nachricht hochladen',
		description:
			'`multipart/form-data` mit genau einem Feld `file` (höchstens 10 MB). Der Upload ist zunächst unverknüpft und wird über `attachmentIds` beim Anlegen eines Auftrags bzw. einer Chatnachricht verwendet; unverknüpfte Uploads werden nach 24 Stunden gelöscht. Größe und SHA-256 bestimmt der Server; der Dateiname wird bereinigt. Fehler: 400 ungültige Formulardaten, 413 zu groß, 422 leer bzw. Inhalt passt nicht zum Bildtyp, 409 Projekt archiviert oder zu viele offene Uploads.',
		tags,
		permission: PERM.taskCreate,
		rateLimit: { limit: 60, windowSec: 60 },
		params: idParams,
		handler: async ({ ctx, params, request }): Promise<AttachmentDto> => {
			// Projekt vor dem Einlesen prüfen (unbekannt → 404 ohne den Body zu lesen)
			const project = await mdb().transaction((tx) => requireProject(tx, params.id));
			if (project.archived_at) throw errors.conflict('Das Projekt ist archiviert');
			// Body gestreamt begrenzen – `readUpload` prüft nur einen angegebenen `content-length`
			const limited = await limitedUploadRequest(request);
			const file = await readUpload(limited, { maxBytes: ATTACHMENT_MAX_BYTES, sniff: false });
			const mime = attachmentMime(file.contentType, file.bytes);
			const row = await mdb().transaction(async (tx) => {
				const current = await requireProject(tx, params.id, true);
				if (current.archived_at) throw errors.conflict('Das Projekt ist archiviert');
				return insertAttachment(tx, {
					projectId: params.id,
					userId: ctx.userId,
					name: file.name,
					mime,
					bytes: file.bytes
				});
			});
			return attachmentDto(row);
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/attachments/:id',
		summary: 'Anhang herunterladen',
		description:
			'Binäre Antwort mit `content-disposition: attachment`; nur Rasterbilder (PNG, JPEG, GIF, WebP) werden `inline` ausgeliefert (außer mit `?download=true`). Aktive Inhalte wie SVG oder HTML kommen als `application/octet-stream`; immer `x-content-type-options: nosniff` und eine restriktive CSP. Unverknüpfte Uploads sieht nur die hochladende Person.',
		tags,
		permission: PERM.projectView,
		rateLimit: { limit: 600, windowSec: 60 },
		params: idParams,
		query: downloadQuery,
		handler: async ({ ctx, params, query }) => {
			const { row, bytes } = await mdb().transaction(async (tx) => {
				const row = await getAttachment(tx, params.id);
				// unverknüpfte Uploads anderer Personen gelten als unbekannt
				if (!row || (row.unlinked === true && String(row.uploaded_by ?? '') !== ctx.userId)) {
					throw errors.notFound('Anhang nicht gefunden');
				}
				await requireProject(tx, String(row.project_id));
				return { row, bytes: await attachmentBytes(tx, params.id) };
			});
			const mime = String(row.mime);
			const image = (RASTER_IMAGE_TYPES as readonly string[]).includes(mime);
			return secureFileResponse(bytes, {
				contentType: mime,
				size: bytes.byteLength,
				name: String(row.name),
				download: query.download || !image
			});
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/attachments/:id',
		summary: 'Eigenen, noch nicht verwendeten Upload löschen',
		description: 'Verknüpfte Anhänge → 409; fremde oder unbekannte → 404.',
		tags,
		permission: PERM.taskCreate,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction((tx) => deleteOwnAttachment(tx, params.id, ctx.userId));
			return { ok: true };
		}
	})
];
