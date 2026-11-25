/**
 * Kleiner, sicherer Markdown-Parser (rein, ohne Svelte) für Chat-Nachrichten, Aufträge und Agent-Ausgaben.
 *
 * Erzeugt einen Baum aus Blöcken und Inline-Knoten, den `components/Markdown.svelte` mit normalen Svelte-Elementen
 * rendert – bewusst kein HTML-String und kein `{@html}` (Inhalte stammen von Nutzern und Agents). Rohes HTML im Text
 * bleibt Text; Links nur mit http(s)/mailto oder relativ, Bilder werden als Link dargestellt (nichts von außen laden).
 *
 * Unterstützt (GitHub-nah): Absätze (Zeilenumbruch = Umbruch), Überschriften (ATX/Setext), ```/~~~-Codeblöcke,
 * Zitate, (verschachtelte) Listen inkl. Aufgabenlisten, Tabellen, Trennlinien, **fett**, *kursiv*, ~~durch~~,
 * `Code`, [Links](url), <https://autolinks> und nackte URLs.
 */

export type Inline =
	| { t: 'text'; v: string }
	| { t: 'code'; v: string }
	| { t: 'strong' | 'em' | 'del'; c: Inline[] }
	| { t: 'link'; href: string; c: Inline[] }
	| { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
	/** Aufgabenliste: `[x]` → true, `[ ]` → false, sonst null */
	checked: boolean | null;
	c: Block[];
}

export type Block =
	| { t: 'p'; c: Inline[] }
	| { t: 'h'; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
	| { t: 'code'; lang: string; v: string }
	| { t: 'quote'; c: Block[] }
	| { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
	| { t: 'hr' }
	| { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

/** Schutz gegen pathologisch tiefe Verschachtelung (Zitate/Listen/Hervorhebungen) */
const MAX_DEPTH = 12;

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^( {0,12})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
const BLANK = /^\s*$/;

/** Markdown-Text → Blöcke */
export function parseMarkdown(text: string): Block[] {
	const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
	return parseBlocks(lines, 0);
}

function parseBlocks(lines: string[], depth: number): Block[] {
	const out: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (BLANK.test(line)) {
			i++;
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence) {
			const indent = fence[1]!.length;
			const marker = fence[2]!;
			const body: string[] = [];
			i++;
			while (i < lines.length) {
				const l = lines[i]!;
				const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
				if (close.test(l)) {
					i++;
					break;
				}
				body.push(stripIndent(l, indent));
				i++;
			}
			out.push({ t: 'code', lang: fence[3] ?? '', v: body.join('\n') });
			continue;
		}

		const atx = ATX.exec(line);
		if (atx) {
			const level = atx[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
			out.push({ t: 'h', level, c: parseInline(atx[2] ?? '', depth) });
			i++;
			continue;
		}

		if (HR.test(line)) {
			out.push({ t: 'hr' });
			i++;
			continue;
		}

		if (QUOTE.test(line)) {
			const inner: string[] = [];
			while (i < lines.length) {
				const q = QUOTE.exec(lines[i]!);
				if (q) inner.push(q[1]!);
				// „faule“ Fortsetzung: Absatzzeile ohne `>` direkt danach gehört noch zum Zitat
				else if (
					!BLANK.test(lines[i]!) &&
					inner.length &&
					!BLANK.test(inner.at(-1)!) &&
					!startsBlock(lines, i)
				)
					inner.push(lines[i]!);
				else break;
				i++;
			}
			out.push(
				depth >= MAX_DEPTH
					? { t: 'p', c: [{ t: 'text', v: inner.join('\n') }] }
					: { t: 'quote', c: parseBlocks(inner, depth + 1) }
			);
			continue;
		}

		const list = LIST.exec(line);
		if (list && isListStart(list)) {
			const res = parseList(lines, i, depth);
			out.push(res.block);
			i = res.next;
			continue;
		}

		if (isTableStart(lines, i)) {
			const res = parseTable(lines, i, depth);
			out.push(res.block);
			i = res.next;
			continue;
		}

		// Absatz bis Leerzeile oder Beginn eines anderen Blocks
		const para: string[] = [line.trim()];
		i++;
		let heading: 1 | 2 | null = null;
		while (i < lines.length) {
			const l = lines[i]!;
			if (BLANK.test(l)) break;
			const setext = SETEXT.exec(l);
			if (setext) {
				heading = setext[1]![0] === '=' ? 1 : 2;
				i++;
				break;
			}
			if (startsBlock(lines, i)) break;
			para.push(l.trim());
			i++;
		}
		const c = parseInline(para.join('\n'), depth);
		out.push(heading ? { t: 'h', level: heading, c } : { t: 'p', c });
	}
	return out;
}

/** Beginnt in Zeile i ein Block, der einen Absatz unterbricht? */
function startsBlock(lines: string[], i: number): boolean {
	const l = lines[i]!;
	if (FENCE.test(l) || ATX.test(l) || HR.test(l) || QUOTE.test(l)) return true;
	const m = LIST.exec(l);
	// Nummerierte Liste unterbricht einen Absatz nur ab 1 (wie CommonMark) – „2024. war gut“ bleibt Text
	if (m && isListStart(m) && (!/^\d/.test(m[2]!) || parseInt(m[2]!, 10) === 1)) return true;
	return isTableStart(lines, i);
}

function isListStart(m: RegExpExecArray): boolean {
	// `-` ohne Inhalt zählt nur mit Leerzeichen danach nicht als Liste („-“ allein ist Text)
	return m[3] !== undefined && (m[4] ?? '').trim() !== '';
}

function stripIndent(line: string, n: number): string {
	let k = 0;
	while (k < n && line[k] === ' ') k++;
	return line.slice(k);
}

const indentOf = (l: string) => l.length - l.trimStart().length;

function parseList(lines: string[], start: number, depth: number): { block: Block; next: number } {
	const first = LIST.exec(lines[start]!)!;
	const baseIndent = first[1]!.length;
	const ordered = /^\d/.test(first[2]!);
	const bullet = ordered ? first[2]!.slice(-1) : first[2]!;
	const startNum = ordered ? parseInt(first[2]!, 10) : 1;
	const items: ListItem[] = [];
	let i = start;

	while (i < lines.length) {
		const m = LIST.exec(lines[i]!);
		if (!m || !isListStart(m) || m[1]!.length !== baseIndent) break;
		const isOrdered = /^\d/.test(m[2]!);
		if (isOrdered !== ordered || (isOrdered ? m[2]!.slice(-1) : m[2]!) !== bullet) break;

		const contentIndent = baseIndent + m[2]!.length + Math.min(m[3]!.length, 4);
		const body: string[] = [m[4]!];
		i++;
		while (i < lines.length) {
			const l = lines[i]!;
			if (BLANK.test(l)) {
				// Leerzeile: Eintrag geht weiter, wenn danach eingerückter Inhalt folgt
				let j = i + 1;
				while (j < lines.length && BLANK.test(lines[j]!)) j++;
				if (j < lines.length && indentOf(lines[j]!) >= contentIndent) {
					for (; i < j; i++) body.push('');
					continue;
				}
				break;
			}
			if (indentOf(l) >= contentIndent) {
				body.push(stripIndent(l, contentIndent));
				i++;
				continue;
			}
			const sub = LIST.exec(l);
			if (sub && isListStart(sub)) {
				// eingerückte Unterliste mit weniger Einrückung als der Inhalt (z. B. 2 statt 3 Leerzeichen)
				if (sub[1]!.length > baseIndent) {
					body.push(stripIndent(l, baseIndent + 2));
					i++;
					continue;
				}
				break;
			}
			// faule Fortsetzung der Absatzzeile
			if (!startsBlock(lines, i) && !BLANK.test(body.at(-1) ?? '')) {
				body.push(l.trim());
				i++;
				continue;
			}
			break;
		}

		let checked: boolean | null = null;
		const task = /^\[([ xX])\][ \t]+/.exec(body[0]!);
		if (task) {
			checked = task[1] !== ' ';
			body[0] = body[0]!.slice(task[0].length);
		}
		items.push({
			checked,
			c:
				depth >= MAX_DEPTH
					? [{ t: 'p', c: [{ t: 'text', v: body.join('\n') }] }]
					: parseBlocks(body, depth + 1)
		});

		// Leerzeilen zwischen Einträgen derselben Liste überspringen
		let j = i;
		while (j < lines.length && BLANK.test(lines[j]!)) j++;
		if (j > i && j < lines.length) {
			const n = LIST.exec(lines[j]!);
			if (n && isListStart(n) && n[1]!.length === baseIndent) i = j;
		}
	}
	return { block: { t: 'list', ordered, start: startNum, items }, next: i };
}

function isTableStart(lines: string[], i: number): boolean {
	const head = lines[i]!;
	const delim = lines[i + 1];
	if (delim === undefined || !head.includes('|') || !TABLE_DELIM.test(delim)) return false;
	if (!delim.includes('|') && !head.trim().startsWith('|')) {
		// „a | b“ über „---“ ist eher Setext-Überschrift als Tabelle
		return false;
	}
	return splitRow(head).length === splitRow(delim).length;
}

/** Tabellenzeile an `|` trennen (nicht an `\|` und nicht innerhalb von `Code`) */
function splitRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith('|')) s = s.slice(1);
	if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = '';
	let inCode = false;
	for (let k = 0; k < s.length; k++) {
		const ch = s[k]!;
		if (ch === '\\' && s[k + 1] === '|') {
			cur += '|';
			k++;
		} else if (ch === '`') {
			inCode = !inCode;
			cur += ch;
		} else if (ch === '|' && !inCode) {
			cells.push(cur.trim());
			cur = '';
		} else cur += ch;
	}
	cells.push(cur.trim());
	return cells;
}

function parseTable(lines: string[], start: number, depth: number): { block: Block; next: number } {
	const head = splitRow(lines[start]!);
	const align: Align[] = splitRow(lines[start + 1]!).map((d) => {
		const l = d.startsWith(':');
		const r = d.endsWith(':');
		return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
	});
	const rows: Inline[][][] = [];
	let i = start + 2;
	while (i < lines.length) {
		const l = lines[i]!;
		if (BLANK.test(l) || !l.includes('|') || (startsBlock(lines, i) && !isTableStart(lines, i)))
			break;
		const cells = splitRow(l);
		rows.push(head.map((_, k) => parseInline(cells[k] ?? '', depth)));
		i++;
	}
	return {
		block: { t: 'table', align, head: head.map((h) => parseInline(h, depth)), rows },
		next: i
	};
}

// ---------------------------------------------------------------- Inline

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<>]+/i;

/** Nur ungefährliche Ziele: http(s), mailto, relativ/Anker. Sonst null (→ wird als Text gezeigt). */
export function safeHref(raw: string): string | null {
	const href = raw.trim();
	if (!href) return null;
	// Steuerzeichen/Leerraum aus dem Schema entfernen, sonst „java\nscript:“
	// eslint-disable-next-line no-control-regex
	const probe = href.replace(/[\u0000- ]/g, '').toLowerCase();
	const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe);
	if (!scheme) return href.startsWith('//') ? null : href;
	return ['http', 'https', 'mailto'].includes(scheme[1]!) ? href : null;
}

/** Inline-Markdown → Knoten */
export function parseInline(src: string, depth = 0): Inline[] {
	const out: Inline[] = [];
	let text = '';
	const pushText = (v: string) => {
		text += v;
	};
	const flush = () => {
		if (text) out.push({ t: 'text', v: text });
		text = '';
	};
	const push = (n: Inline) => {
		flush();
		out.push(n);
	};
	const nested = (s: string) =>
		depth >= MAX_DEPTH ? [{ t: 'text', v: s } as Inline] : parseInline(s, depth + 1);

	// Gegen quadratische Laufzeit (z. B. 100 000 × „*a “): Bereich, in dem die Suche nach einem Schließer
	// bereits erfolglos war, merken – eine spätere Suche aus diesem Bereich scheitert genauso.
	const noClose = new Map<string, [number, number]>();
	const close = (from: number, delim: string): number => {
		const known = noClose.get(delim);
		if (known && from >= known[0] && from <= known[1]) return -1;
		const fail = { at: src.length };
		const end = findClose(src, from, delim, fail, close);
		if (end === -1) noClose.set(delim, [from, fail.at]);
		return end;
	};
	// passende `]` zu jedem `[` einmalig in O(n) bestimmen statt ab jedem `[` bis zum Ende zu suchen
	let brackets: Map<number, number> | null = null;
	const linkAt = (at: number) => parseLink(src, at, (brackets ??= matchBrackets(src)).get(at));

	let i = 0;
	while (i < src.length) {
		const ch = src[i]!;

		if (ch === '\\') {
			const next = src[i + 1];
			if (next === '\n') {
				push({ t: 'br' });
				i += 2;
				continue;
			}
			if (next !== undefined && ESCAPABLE.test(next)) {
				pushText(next);
				i += 2;
				continue;
			}
		}

		if (ch === '\n') {
			// Zeilenumbruch im Absatz bleibt sichtbar (wie in GitHub-Kommentaren); Leerzeichen davor entfallen
			text = text.replace(/ +$/, '');
			push({ t: 'br' });
			i++;
			continue;
		}

		if (ch === '`') {
			let n = 1;
			while (src[i + n] === '`') n++;
			const ticks = '`'.repeat(n);
			let j = src.indexOf(ticks, i + n);
			while (j !== -1 && src[j + n] === '`') {
				// längere Folge ist kein passendes Ende
				let k = j;
				while (src[k] === '`') k++;
				j = src.indexOf(ticks, k);
			}
			if (j !== -1) {
				let code = src.slice(i + n, j).replace(/\n/g, ' ');
				if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim())
					code = code.slice(1, -1);
				push({ t: 'code', v: code });
				i = j + n;
				continue;
			}
			pushText(ticks);
			i += n;
			continue;
		}

		// Bild → als Link (keine externen Ressourcen laden)
		if (ch === '!' && src[i + 1] === '[') {
			const link = linkAt(i + 1);
			if (link) {
				const label = link.label || link.href;
				const href = safeHref(link.href);
				if (href) push({ t: 'link', href, c: [{ t: 'text', v: `🖼 ${label}` }] });
				else pushText(src.slice(i, link.end));
				i = link.end;
				continue;
			}
		}

		if (ch === '[') {
			const link = linkAt(i);
			if (link) {
				const href = safeHref(link.href);
				if (href)
					push({
						t: 'link',
						href,
						c: link.label ? unlink(nested(link.label)) : [{ t: 'text', v: link.href }]
					});
				else pushText(src.slice(i, link.end));
				i = link.end;
				continue;
			}
		}

		if (ch === '<') {
			const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i));
			if (auto) {
				push({
					t: 'link',
					href: auto[1]!,
					c: [{ t: 'text', v: auto[1]!.replace(/^mailto:/i, '') }]
				});
				i += auto[0].length;
				continue;
			}
		}

		if (
			(ch === 'h' || ch === 'H' || ch === 'w' || ch === 'W') &&
			!/[\p{L}\p{N}]/u.test(src[i - 1] ?? '')
		) {
			const m = BARE_URL.exec(src.slice(i));
			if (m) {
				let url = m[0];
				// Satzzeichen am Ende und unpaarige schließende Klammern gehören nicht zur URL
				while (/[.,:;!?'"*_~]$/.test(url)) url = url.slice(0, -1);
				while (url.endsWith(')') && count(url, '(') < count(url, ')')) url = url.slice(0, -1);
				if (url.length > (url.toLowerCase().startsWith('www.') ? 4 : 8)) {
					const href = url.toLowerCase().startsWith('www.') ? `https://${url}` : url;
					push({ t: 'link', href, c: [{ t: 'text', v: url }] });
					i += url.length;
					continue;
				}
			}
		}

		if (ch === '~' && src[i + 1] === '~') {
			const end = close(i + 2, '~~');
			if (end !== -1) {
				push({ t: 'del', c: nested(src.slice(i + 2, end)) });
				i = end + 2;
				continue;
			}
		}

		if (ch === '*' || ch === '_') {
			const double = src[i + 1] === ch;
			const delim = double ? ch + ch : ch;
			const after = src[i + delim.length];
			const before = src[i - 1] ?? ' ';
			// `_` nicht mitten im Wort (snake_case), Öffner nie vor Leerraum
			const canOpen =
				after !== undefined && !/\s/.test(after) && !(ch === '_' && /[\p{L}\p{N}]/u.test(before));
			if (canOpen) {
				// `***x***` → fett + kursiv
				if (double && src[i + 2] === ch) {
					const end = close(i + 3, ch.repeat(3));
					if (end !== -1) {
						push({ t: 'strong', c: [{ t: 'em', c: nested(src.slice(i + 3, end)) }] });
						i = end + 3;
						continue;
					}
				}
				const end = close(i + delim.length, delim);
				if (end !== -1) {
					push({ t: double ? 'strong' : 'em', c: nested(src.slice(i + delim.length, end)) });
					i = end + delim.length;
					continue;
				}
			}
			// nicht passende Folge als Ganzes übernehmen, damit `**` nicht als zwei `*` neu startet
			let n = 1;
			while (src[i + n] === ch) n++;
			pushText(ch.repeat(n));
			i += n;
			continue;
		}

		pushText(ch);
		i++;
	}
	flush();
	return out;
}

const count = (s: string, c: string) => s.split(c).length - 1;

/** Links im Linktext (z. B. nackte URL im Label) durch ihren Inhalt ersetzen – kein `<a>` in `<a>` */
function unlink(nodes: Inline[]): Inline[] {
	return nodes.flatMap((n): Inline[] =>
		n.t === 'link' ? unlink(n.c) : 'c' in n ? [{ ...n, c: unlink(n.c) }] : [n]
	);
}

/** Zu jedem `[` die passende `]` (Escapes und `Code` übersprungen, wie bisher ab jedem `[` gesucht) */
function matchBrackets(src: string): Map<number, number> {
	const pairs = new Map<number, number>();
	const open: number[] = [];
	for (let k = 0; k < src.length; k++) {
		const c = src[k];
		if (c === '\\') {
			k++;
			continue;
		}
		if (c === '`') {
			const close = src.indexOf('`', k + 1);
			if (close === -1) continue;
			k = close;
			continue;
		}
		if (c === '[') open.push(k);
		else if (c === ']' && open.length) pairs.set(open.pop()!, k);
	}
	return pairs;
}

/** `[label](href "title")` ab `[` (mit passender `]` an `k`) → Teile, oder null */
function parseLink(
	src: string,
	at: number,
	k: number | undefined
): { label: string; href: string; end: number } | null {
	if (k === undefined || src[k + 1] !== '(') return null;
	const label = src.slice(at + 1, k);
	let p = k + 2;
	let parens = 1;
	let dest = '';
	if (src[p] === '<') {
		// `<…>`-Ziel ohne Zeilenumbruch und ohne weiteres `<` (begrenzt die Suche)
		const angle = /<([^<>\n]*)>/y;
		angle.lastIndex = p;
		const m = angle.exec(src);
		if (!m) return null;
		dest = m[1]!;
		p += m[0].length;
		const rest = /^\s*(?:"[^"]*"|'[^']*')?\s*\)/.exec(src.slice(p));
		if (!rest) return null;
		return { label, href: dest, end: p + rest[0].length };
	}
	for (; p < src.length; p++) {
		const c = src[p]!;
		if (c === '\\' && src[p + 1] !== undefined) {
			dest += src[p + 1];
			p++;
			continue;
		}
		// höchstens 32 offene Klammern im Ziel (wie cmark) – begrenzt die Suche bei „[a](b[a](b…“
		if (c === '(' && ++parens > 32) return null;
		else if (c === ')' && --parens === 0) break;
		// Leerraum/Steuerzeichen beenden das Ziel
		if (c <= ' ') break;
		dest += c;
	}
	const rest = /^\s*(?:"[^"]*"|'[^']*')?\s*\)/.exec(src.slice(p));
	if (src[p] === ')') return { label, href: dest, end: p + 1 };
	if (!rest) return null;
	return { label, href: dest, end: p + rest[0].length };
}

/**
 * Passendes Ende einer Hervorhebung ab `from` suchen: überspringt Escapes und Code-Spans, verlangt kein
 * Leerzeichen vor dem Schließer und (bei `_`) kein Wortzeichen danach. Für `*` werden innere `**…**` übersprungen.
 */
function findClose(
	src: string,
	from: number,
	delim: string,
	fail: { at: number },
	inner: (from: number, delim: string) => number
): number {
	const ch = delim[0]!;
	for (let j = from; j < src.length; j++) {
		const c = src[j];
		if (c === '\\') {
			j++;
			continue;
		}
		if (c === '`') {
			let n = 1;
			while (src[j + n] === '`') n++;
			const close = src.indexOf('`'.repeat(n), j + n);
			if (close !== -1) j = close + n - 1;
			continue;
		}
		if (c === '\n' && src[j + 1] === '\n') {
			fail.at = j;
			return -1;
		}
		if (!src.startsWith(delim, j)) continue;
		let run = 0;
		while (src[j + run] === ch) run++;
		if (delim.length === 1 && ch !== '~' && run >= 2) {
			// innere starke Hervorhebung überspringen; `***` am Ende schließt em + strong gemeinsam
			if (run === 3 && j > from && !/\s/.test(src[j - 1]!)) return j + 2;
			const end = inner(j + 2, ch + ch);
			if (end === -1) {
				fail.at = j;
				return -1;
			}
			// `*a **b***`: endet die innere in `***`, schließt das letzte Zeichen die äußere
			let s = end;
			while (src[s - 1] === ch) s--;
			if (src.startsWith(ch.repeat(3), s) && src[s + 3] !== ch) return s + 2;
			j = end + 1;
			continue;
		}
		if (j === from || /\s/.test(src[j - 1]!)) {
			j += run - 1;
			continue;
		}
		const after = src[j + delim.length];
		if (ch === '_' && after !== undefined && /[\p{L}\p{N}]/u.test(after)) continue;
		// `**` gefolgt von weiterem `*` (z. B. `**a***`): letztes passendes Ende nehmen
		if (run > delim.length && delim.length === 2) return j + run - delim.length;
		return j;
	}
	return -1;
}
