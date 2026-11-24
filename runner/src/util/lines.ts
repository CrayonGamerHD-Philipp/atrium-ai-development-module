/** Zerlegt einen Byte- bzw. Textstrom in Zeilen (UTF-8 mit `TextDecoder` im Stream-Modus, `\n`/`\r\n`). */
export class LineSplitter {
	private decoder = new TextDecoder('utf-8');
	private buf = '';

	/** Neue Daten; liefert vollständige Zeilen (ohne Zeilenende) */
	push(chunk: Uint8Array | string): string[] {
		this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
		const out: string[] = [];
		let idx: number;
		while ((idx = this.buf.indexOf('\n')) >= 0) {
			let line = this.buf.slice(0, idx);
			if (line.endsWith('\r')) line = line.slice(0, -1);
			out.push(line);
			this.buf = this.buf.slice(idx + 1);
		}
		return out;
	}

	/** Rest am Ende des Stroms */
	end(): string[] {
		this.buf += this.decoder.decode();
		const rest = this.buf.replace(/\r$/, '');
		this.buf = '';
		return rest ? [rest] : [];
	}
}

/** Behält nur die letzten `max` Zeichen (z. B. stderr für Fehlermeldungen) */
export class TailBuffer {
	private text = '';
	constructor(private readonly max = 64_000) {}
	push(s: string): void {
		this.text += s;
		if (this.text.length > this.max * 2) this.text = this.text.slice(-this.max);
	}
	toString(): string {
		return this.text.length > this.max ? this.text.slice(-this.max) : this.text;
	}
}
