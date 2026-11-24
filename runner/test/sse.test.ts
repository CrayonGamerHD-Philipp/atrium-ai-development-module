import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/sse.ts';

describe('SseParser', () => {
	it('liest einfache Nachrichten und ignoriert Kommentare', () => {
		const p = new SseParser();
		const msgs = p.push(': ping\n\ndata: {"type":"hello"}\n\n: ping\n\n');
		expect(msgs).toEqual([{ event: 'message', data: '{"type":"hello"}', id: null }]);
		expect(p.comments).toBe(2);
	});

	it('fügt mehrzeilige data-Felder mit \\n zusammen', () => {
		const p = new SseParser();
		const msgs = p.push('data: zeile1\ndata: zeile2\ndata:zeile3\n\n');
		expect(msgs[0]?.data).toBe('zeile1\nzeile2\nzeile3');
	});

	it('übernimmt retry, id und event', () => {
		const p = new SseParser();
		const msgs = p.push('retry: 5000\nid: 42\nevent: command\ndata: x\n\n');
		expect(p.retryMs).toBe(5000);
		expect(msgs[0]).toEqual({ event: 'command', data: 'x', id: '42' });
		p.push('retry: abc\n\n');
		expect(p.retryMs).toBe(5000);
	});

	it('verarbeitet abgerissene Chunks (auch mitten in UTF-8 und CRLF)', () => {
		const p = new SseParser();
		const bytes = new TextEncoder().encode('data: {"t":"Grüße"}\r\n\r\ndata: zwei\r\n\r\n');
		const out = [];
		// Byte für Byte einspeisen
		for (const b of bytes) out.push(...p.push(new Uint8Array([b])));
		expect(out.map((m) => m.data)).toEqual(['{"t":"Grüße"}', 'zwei']);
	});

	it('behandelt CR-Zeilenenden und CR am Chunk-Ende', () => {
		const p = new SseParser();
		expect(p.push('data: a\r')).toEqual([]);
		const m1 = p.push('\n\r\n');
		expect(m1.map((m) => m.data)).toEqual(['a']);
		const m2 = p.push('data: b\r\rdata: c\r\r');
		expect(m2.map((m) => m.data)).toEqual(['b', 'c']);
	});

	it('verwirft Nachrichten ohne data und unbekannte Felder', () => {
		const p = new SseParser();
		expect(p.push('event: x\n\nfoo: bar\n\n')).toEqual([]);
		expect(p.push('data\n\n')).toEqual([{ event: 'message', data: '', id: null }]);
	});
});
