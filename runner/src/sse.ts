/**
 * Parser für Server-Sent Events (WHATWG-Format): Felder `data`, `event`, `id`, `retry`, Kommentarzeilen (`: ping`),
 * Zeilenenden `\n`, `\r\n` und `\r`, auch über Chunk-Grenzen hinweg.
 */

export interface SseMessage {
	event: string;
	data: string;
	id: string | null;
}

export class SseParser {
	private decoder = new TextDecoder('utf-8');
	private buf = '';
	/** Letztes Zeichen war `\r` (ein folgendes `\n` gehört noch zum selben Zeilenende) */
	private pendingCR = false;
	private dataLines: string[] = [];
	private eventName = '';
	private lastId: string | null = null;
	/** Vom Server gewünschte Wartezeit vor dem Neuverbinden (`retry:`) */
	retryMs: number | null = null;
	/** Anzahl empfangener Kommentarzeilen (z. B. `: ping`) */
	comments = 0;

	/** Rohdaten verarbeiten; liefert alle vollständigen Nachrichten */
	push(chunk: Uint8Array | string): SseMessage[] {
		let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
		if (text === '') return [];
		if (this.pendingCR && text.startsWith('\n')) text = text.slice(1);
		this.pendingCR = false;
		this.buf += text;
		const out: SseMessage[] = [];
		for (;;) {
			const m = /\r\n|\r|\n/.exec(this.buf);
			if (!m) break;
			// `\r` am Ende des Puffers: evtl. folgt `\n` im nächsten Chunk
			if (m[0] === '\r' && m.index === this.buf.length - 1) {
				this.pendingCR = true;
			}
			const line = this.buf.slice(0, m.index);
			this.buf = this.buf.slice(m.index + m[0].length);
			const msg = this.line(line);
			if (msg) out.push(msg);
		}
		return out;
	}

	private line(line: string): SseMessage | null {
		if (line === '') {
			if (this.dataLines.length === 0) {
				this.eventName = '';
				return null;
			}
			const msg: SseMessage = {
				event: this.eventName || 'message',
				data: this.dataLines.join('\n'),
				id: this.lastId
			};
			this.dataLines = [];
			this.eventName = '';
			return msg;
		}
		if (line.startsWith(':')) {
			this.comments++;
			return null;
		}
		const idx = line.indexOf(':');
		const field = idx >= 0 ? line.slice(0, idx) : line;
		let value = idx >= 0 ? line.slice(idx + 1) : '';
		if (value.startsWith(' ')) value = value.slice(1);
		switch (field) {
			case 'data':
				this.dataLines.push(value);
				break;
			case 'event':
				this.eventName = value;
				break;
			case 'id':
				if (!value.includes('\0')) this.lastId = value;
				break;
			case 'retry':
				if (/^\d+$/.test(value)) this.retryMs = Number(value);
				break;
			default:
				// Unbekannte Felder werden ignoriert
				break;
		}
		return null;
	}
}
