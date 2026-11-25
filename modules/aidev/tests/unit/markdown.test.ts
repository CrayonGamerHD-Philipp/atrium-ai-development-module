import { describe, it, expect } from 'vitest';
import {
	parseInline,
	parseMarkdown,
	safeHref,
	type Block,
	type Inline
} from '../../pages/markdown';

const text = (v: string): Inline => ({ t: 'text', v });
const p = (...c: Inline[]): Block => ({ t: 'p', c });

/** Sichtbarer Text eines Inline-Baums (zum groben Vergleichen) */
function plain(nodes: Inline[]): string {
	return nodes
		.map((n) => {
			if (n.t === 'text' || n.t === 'code') return n.v;
			if (n.t === 'br') return '\n';
			return plain(n.c);
		})
		.join('');
}

/** Alle Knoten eines Inline-Baums (flach) */
function flat(nodes: Inline[]): Inline[] {
	return nodes.flatMap((n) => ('c' in n ? [n, ...flat(n.c)] : [n]));
}

describe('Absätze und Überschriften', () => {
	it('trennt Absätze an Leerzeilen und macht Zeilenumbrüche zu br', () => {
		expect(parseMarkdown('a\nb  \nc\n\nd')).toEqual([
			p(text('a'), { t: 'br' }, text('b'), { t: 'br' }, text('c')),
			p(text('d'))
		]);
	});

	it('liefert für leeren Text keine Blöcke', () => {
		expect(parseMarkdown('')).toEqual([]);
		expect(parseMarkdown('\n  \n')).toEqual([]);
	});

	it('erkennt ATX-Überschriften inkl. schließender Rauten', () => {
		expect(parseMarkdown('# Eins\n### Drei ###\n###### Sechs')).toEqual([
			{ t: 'h', level: 1, c: [text('Eins')] },
			{ t: 'h', level: 3, c: [text('Drei')] },
			{ t: 'h', level: 6, c: [text('Sechs')] }
		]);
	});

	it('macht aus #ohne Leerzeichen und ####### keine Überschrift', () => {
		expect(parseMarkdown('#hashtag')).toEqual([p(text('#hashtag'))]);
		expect(parseMarkdown('####### sieben')[0]!.t).toBe('p');
	});

	it('erkennt Setext-Überschriften', () => {
		expect(parseMarkdown('Titel\n=====\n\nUnter\n---')).toEqual([
			{ t: 'h', level: 1, c: [text('Titel')] },
			{ t: 'h', level: 2, c: [text('Unter')] }
		]);
	});
});

describe('Codeblöcke', () => {
	it('liest ```-Blöcke mit Sprache wörtlich', () => {
		expect(parseMarkdown('```ts\nconst a = *b*;\n<b>x</b>\n```\nnach')).toEqual([
			{ t: 'code', lang: 'ts', v: 'const a = *b*;\n<b>x</b>' },
			p(text('nach'))
		]);
	});

	it('liest ~~~-Blöcke und verlangt einen passenden Schließer', () => {
		expect(parseMarkdown('~~~\na\n```\nb\n~~~')).toEqual([{ t: 'code', lang: '', v: 'a\n```\nb' }]);
	});

	it('nimmt bei offenem Block den Rest des Textes', () => {
		expect(parseMarkdown('```py\nprint(1)\n\nprint(2)')).toEqual([
			{ t: 'code', lang: 'py', v: 'print(1)\n\nprint(2)' }
		]);
	});

	it('entfernt die Einrückung des öffnenden Zauns', () => {
		expect(parseMarkdown('  ```\n  a\n    b\n  ```')).toEqual([
			{ t: 'code', lang: '', v: 'a\n  b' }
		]);
	});
});

describe('Inline-Formatierung', () => {
	it('erkennt Code-Spans inkl. doppelter Backticks', () => {
		expect(parseInline('a `b` c')).toEqual([text('a '), { t: 'code', v: 'b' }, text(' c')]);
		expect(parseInline('``a ` b``')).toEqual([{ t: 'code', v: 'a ` b' }]);
		expect(parseInline('`` `x` ``')).toEqual([{ t: 'code', v: '`x`' }]);
		expect(parseInline('`*nicht kursiv*`')).toEqual([{ t: 'code', v: '*nicht kursiv*' }]);
	});

	it('lässt unpaarige Backticks als Text', () => {
		expect(parseInline('a ` b')).toEqual([text('a ` b')]);
	});

	it('erkennt fett, kursiv, durchgestrichen und beides', () => {
		expect(parseInline('**f** *k* _u_ __g__ ~~d~~')).toEqual([
			{ t: 'strong', c: [text('f')] },
			text(' '),
			{ t: 'em', c: [text('k')] },
			text(' '),
			{ t: 'em', c: [text('u')] },
			text(' '),
			{ t: 'strong', c: [text('g')] },
			text(' '),
			{ t: 'del', c: [text('d')] }
		]);
		expect(parseInline('***beides***')).toEqual([
			{ t: 'strong', c: [{ t: 'em', c: [text('beides')] }] }
		]);
	});

	it('verschachtelt Hervorhebungen', () => {
		expect(parseInline('**fett *und kursiv***')).toEqual([
			{ t: 'strong', c: [text('fett '), { t: 'em', c: [text('und kursiv')] }] }
		]);
		expect(parseInline('*kursiv **und fett***')).toEqual([
			{ t: 'em', c: [text('kursiv '), { t: 'strong', c: [text('und fett')] }] }
		]);
	});

	it('macht snake_case nicht kursiv', () => {
		expect(parseInline('foo_bar_baz')).toEqual([text('foo_bar_baz')]);
		expect(parseInline('my_var und other_var')).toEqual([text('my_var und other_var')]);
	});

	it('macht 2 * 3 * 4 nicht kursiv', () => {
		expect(parseInline('2 * 3 * 4')).toEqual([text('2 * 3 * 4')]);
		expect(parseInline('a ** b ** c')).toEqual([text('a ** b ** c')]);
	});

	it('lässt unpaarige Marker als Text', () => {
		expect(parseInline('**offen')).toEqual([text('**offen')]);
		expect(parseInline('~einzeln~')).toEqual([text('~einzeln~')]);
	});

	it('beachtet Escapes', () => {
		expect(parseInline('\\*kein\\* \\_x\\_ \\`y\\` \\[z\\](u) \\\\')).toEqual([
			text('*kein* _x_ `y` [z](u) \\')
		]);
		// nicht escapebare Zeichen behalten den Backslash
		expect(parseInline('C:\\Pfad\\datei')).toEqual([text('C:\\Pfad\\datei')]);
		// Backslash am Zeilenende = harter Umbruch
		expect(parseInline('a\\\nb')).toEqual([text('a'), { t: 'br' }, text('b')]);
	});

	it('lässt rohes HTML als Text', () => {
		const src = '<script>alert(1)</script> <img src=x onerror=alert(1)>';
		expect(parseInline(src)).toEqual([text(src)]);
		expect(parseMarkdown('<div>\n<b>x</b>\n</div>')).toEqual([
			p(text('<div>'), { t: 'br' }, text('<b>x</b>'), { t: 'br' }, text('</div>'))
		]);
	});
});

describe('Links', () => {
	it('erkennt [Text](url) mit Titel und Klammern', () => {
		expect(parseInline('[Doku](https://x.de/a "Titel")')).toEqual([
			{ t: 'link', href: 'https://x.de/a', c: [text('Doku')] }
		]);
		expect(parseInline('[W](https://de.wikipedia.org/wiki/A_(B))')).toEqual([
			{ t: 'link', href: 'https://de.wikipedia.org/wiki/A_(B)', c: [text('W')] }
		]);
		expect(parseInline('[**fett**](/pfad)')).toEqual([
			{ t: 'link', href: '/pfad', c: [{ t: 'strong', c: [text('fett')] }] }
		]);
		expect(parseInline('[spitz](<https://x.de/a b>)')).toEqual([
			{ t: 'link', href: 'https://x.de/a b', c: [text('spitz')] }
		]);
	});

	it('nimmt die URL als Text, wenn das Label leer ist', () => {
		expect(parseInline('[](https://x.de)')).toEqual([
			{ t: 'link', href: 'https://x.de', c: [text('https://x.de')] }
		]);
	});

	it('verschachtelt keine Links im Linktext', () => {
		const [link, ...rest] = parseInline('[siehe https://a.de und [b](/b)](https://x.de)');
		expect(rest).toEqual([]);
		expect(link).toMatchObject({ t: 'link', href: 'https://x.de' });
		const inner = link!.t === 'link' ? link!.c : [];
		expect(flat(inner).some((n) => n.t === 'link')).toBe(false);
		expect(plain(inner)).toBe('siehe https://a.de und b');
	});

	it('lässt [x] ohne Ziel als Text', () => {
		expect(parseInline('[x] und [y]')).toEqual([text('[x] und [y]')]);
	});

	it('erkennt Autolinks', () => {
		expect(parseInline('<https://x.de/a?b=1>')).toEqual([
			{ t: 'link', href: 'https://x.de/a?b=1', c: [text('https://x.de/a?b=1')] }
		]);
		expect(parseInline('<mailto:a@b.de>')).toEqual([
			{ t: 'link', href: 'mailto:a@b.de', c: [text('a@b.de')] }
		]);
	});

	it('erkennt nackte URLs ohne Satzzeichen und unpaarige Klammern am Ende', () => {
		expect(parseInline('Siehe https://x.de/a.')).toEqual([
			text('Siehe '),
			{ t: 'link', href: 'https://x.de/a', c: [text('https://x.de/a')] },
			text('.')
		]);
		expect(parseInline('(siehe https://x.de/a), ok')).toEqual([
			text('(siehe '),
			{ t: 'link', href: 'https://x.de/a', c: [text('https://x.de/a')] },
			text('), ok')
		]);
		expect(parseInline('https://de.wikipedia.org/wiki/A_(B)!')).toEqual([
			{
				t: 'link',
				href: 'https://de.wikipedia.org/wiki/A_(B)',
				c: [text('https://de.wikipedia.org/wiki/A_(B)')]
			},
			text('!')
		]);
	});

	it('ergänzt bei www. das https-Schema', () => {
		expect(parseInline('auf www.example.org!')).toEqual([
			text('auf '),
			{ t: 'link', href: 'https://www.example.org', c: [text('www.example.org')] },
			text('!')
		]);
	});

	it('erkennt keine URL mitten im Wort oder ohne Inhalt', () => {
		expect(flat(parseInline('xhttps://x.de')).some((n) => n.t === 'link')).toBe(false);
		expect(parseInline('https:// und www.')).toEqual([text('https:// und www.')]);
	});

	it('zeigt Bilder als Link statt sie zu laden', () => {
		expect(parseInline('![Logo](https://x.de/l.png)')).toEqual([
			{ t: 'link', href: 'https://x.de/l.png', c: [text('🖼 Logo')] }
		]);
		expect(parseInline('![](https://x.de/l.png)')).toEqual([
			{ t: 'link', href: 'https://x.de/l.png', c: [text('🖼 https://x.de/l.png')] }
		]);
	});

	it('zeigt gefährliche Ziele als Text', () => {
		for (const src of [
			'[x](javascript:alert(1))',
			'[x](JaVa\nScript:alert(1))',
			'[x](data:text/html;base64,PHNjcmlwdD4=)',
			'[x](//evil.example)',
			'![x](javascript:alert(1))',
			'<javascript:alert(1)>'
		]) {
			const nodes = parseInline(src);
			expect(flat(nodes).some((n) => n.t === 'link')).toBe(false);
			expect(plain(nodes).replace(/\n/g, '')).toBe(src.replace(/\n/g, ''));
		}
	});
});

describe('safeHref', () => {
	it('erlaubt http(s), mailto und relative Ziele', () => {
		expect(safeHref('https://x.de')).toBe('https://x.de');
		expect(safeHref(' HTTP://x.de ')).toBe('HTTP://x.de');
		expect(safeHref('mailto:a@b.de')).toBe('mailto:a@b.de');
		expect(safeHref('/pfad?a=1')).toBe('/pfad?a=1');
		expect(safeHref('#anker')).toBe('#anker');
		expect(safeHref('datei.md')).toBe('datei.md');
	});

	it('lehnt andere Schemata, protokollrelative und leere Ziele ab', () => {
		for (const raw of [
			'javascript:alert(1)',
			'JaVaScRiPt:alert(1)',
			'java\nscript:alert(1)',
			'java\tscript:alert(1)',
			' \u0001javascript:alert(1)',
			'data:text/html,x',
			'vbscript:x',
			'file:///etc/passwd',
			'//evil.example',
			'',
			'   '
		])
			expect(safeHref(raw), raw).toBeNull();
	});
});

describe('Zitate', () => {
	it('erkennt Zitate inkl. Verschachtelung', () => {
		expect(parseMarkdown('> a\n> > b\n> c')).toEqual([
			{
				t: 'quote',
				c: [p(text('a')), { t: 'quote', c: [p(text('b'), { t: 'br' }, text('c'))] }]
			}
		]);
	});

	it('nimmt faule Fortsetzungszeilen ins Zitat auf', () => {
		expect(parseMarkdown('> a\nb\n\nc')).toEqual([
			{ t: 'quote', c: [p(text('a'), { t: 'br' }, text('b'))] },
			p(text('c'))
		]);
	});

	it('beendet das Zitat vor einem neuen Block', () => {
		expect(parseMarkdown('> a\n# H')).toEqual([
			{ t: 'quote', c: [p(text('a'))] },
			{ t: 'h', level: 1, c: [text('H')] }
		]);
	});
});

describe('Listen', () => {
	it('erkennt ungeordnete Listen', () => {
		expect(parseMarkdown('- a\n- b\n\n* c')).toEqual([
			{
				t: 'list',
				ordered: false,
				start: 1,
				items: [
					{ checked: null, c: [p(text('a'))] },
					{ checked: null, c: [p(text('b'))] }
				]
			},
			{ t: 'list', ordered: false, start: 1, items: [{ checked: null, c: [p(text('c'))] }] }
		]);
	});

	it('erkennt geordnete Listen mit Startnummer', () => {
		const [list] = parseMarkdown('3. drei\n4. vier\n10. zehn');
		expect(list).toEqual({
			t: 'list',
			ordered: true,
			start: 3,
			items: [
				{ checked: null, c: [p(text('drei'))] },
				{ checked: null, c: [p(text('vier'))] },
				{ checked: null, c: [p(text('zehn'))] }
			]
		});
		expect(parseMarkdown('1) a\n2) b')[0]).toMatchObject({ t: 'list', ordered: true, start: 1 });
	});

	it('verschachtelt Listen mit 2 und 4 Leerzeichen Einrückung', () => {
		const nested: Block = {
			t: 'list',
			ordered: false,
			start: 1,
			items: [
				{
					checked: null,
					c: [
						p(text('a')),
						{
							t: 'list',
							ordered: false,
							start: 1,
							items: [
								{
									checked: null,
									c: [
										p(text('b')),
										{
											t: 'list',
											ordered: false,
											start: 1,
											items: [{ checked: null, c: [p(text('c'))] }]
										}
									]
								}
							]
						}
					]
				},
				{ checked: null, c: [p(text('d'))] }
			]
		};
		expect(parseMarkdown('- a\n  - b\n    - c\n- d')).toEqual([nested]);
		expect(parseMarkdown('- a\n    - b\n        - c\n- d')).toEqual([nested]);
	});

	it('verschachtelt geordnete und ungeordnete Listen', () => {
		const [list] = parseMarkdown('1. a\n   - x\n2. b');
		expect(list).toMatchObject({
			t: 'list',
			ordered: true,
			items: [{ c: [p(text('a')), { t: 'list', ordered: false }] }, { c: [p(text('b'))] }]
		});
	});

	it('erkennt Aufgabenlisten', () => {
		const [list] = parseMarkdown('- [x] erledigt\n- [ ] offen\n- [X] auch\n- normal');
		expect(list).toMatchObject({
			t: 'list',
			items: [
				{ checked: true, c: [p(text('erledigt'))] },
				{ checked: false, c: [p(text('offen'))] },
				{ checked: true, c: [p(text('auch'))] },
				{ checked: null, c: [p(text('normal'))] }
			]
		});
	});

	it('hält Einträge mit Leerzeilen dazwischen in einer Liste', () => {
		const blocks = parseMarkdown('- a\n\n- b\n\n\n- c');
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ t: 'list', items: [{}, {}, {}] });
	});

	it('nimmt eingerückte Absätze nach Leerzeile in den Eintrag auf', () => {
		expect(parseMarkdown('1. a\n\n   weiter\n2. b')).toEqual([
			{
				t: 'list',
				ordered: true,
				start: 1,
				items: [
					{ checked: null, c: [p(text('a')), p(text('weiter'))] },
					{ checked: null, c: [p(text('b'))] }
				]
			}
		]);
	});

	it('erlaubt Codeblöcke in Einträgen', () => {
		expect(parseMarkdown('- Beispiel:\n  ```sh\n  npm test\n  ```\n- weiter')).toEqual([
			{
				t: 'list',
				ordered: false,
				start: 1,
				items: [
					{ checked: null, c: [p(text('Beispiel:')), { t: 'code', lang: 'sh', v: 'npm test' }] },
					{ checked: null, c: [p(text('weiter'))] }
				]
			}
		]);
	});

	it('nimmt faule Fortsetzungszeilen in den Eintrag auf', () => {
		expect(parseMarkdown('- a\nb')).toEqual([
			{
				t: 'list',
				ordered: false,
				start: 1,
				items: [{ checked: null, c: [p(text('a'), { t: 'br' }, text('b'))] }]
			}
		]);
	});

	it('macht aus „2024. war gut“ mitten im Absatz keine Liste', () => {
		expect(parseMarkdown('Das Jahr\n2024. war gut')).toEqual([
			p(text('Das Jahr'), { t: 'br' }, text('2024. war gut'))
		]);
		// mit 1. beginnend unterbricht sie den Absatz dagegen
		expect(parseMarkdown('Schritte:\n1. a')[1]).toMatchObject({ t: 'list', ordered: true });
	});

	it('macht aus einem einzelnen „-“ keine Liste', () => {
		expect(parseMarkdown('-')).toEqual([p(text('-'))]);
	});

	it('beendet die Liste bei anderem Aufzählungszeichen', () => {
		const blocks = parseMarkdown('- a\n+ b');
		expect(blocks.map((b) => b.t)).toEqual(['list', 'list']);
	});
});

describe('Trennlinien', () => {
	it('erkennt ---, *** und ___', () => {
		expect(parseMarkdown('a\n\n---\n\n* * *\n\n___')).toEqual([
			p(text('a')),
			{ t: 'hr' },
			{ t: 'hr' },
			{ t: 'hr' }
		]);
	});
});

describe('Tabellen', () => {
	it('liest Kopf, Ausrichtung und Zeilen', () => {
		expect(parseMarkdown('| a | b | c | d |\n|---|:--|:-:|--:|\n| 1 | **2** | 3 | 4 |')).toEqual([
			{
				t: 'table',
				align: [null, 'left', 'center', 'right'],
				head: [[text('a')], [text('b')], [text('c')], [text('d')]],
				rows: [[[text('1')], [{ t: 'strong', c: [text('2')] }], [text('3')], [text('4')]]]
			}
		]);
	});

	it('erkennt Tabellen ohne äußere Pipes', () => {
		expect(parseMarkdown('a | b\n--|--\n1 | 2')[0]).toMatchObject({
			t: 'table',
			head: [[text('a')], [text('b')]],
			rows: [[[text('1')], [text('2')]]]
		});
	});

	it('trennt nicht an \\| und nicht in Code', () => {
		const [table] = parseMarkdown('| a | b |\n|---|---|\n| x \\| y | `p | q` |');
		expect(table).toMatchObject({
			t: 'table',
			rows: [[[text('x | y')], [{ t: 'code', v: 'p | q' }]]]
		});
	});

	it('füllt fehlende Zellen auf und verwirft überzählige', () => {
		const [table] = parseMarkdown('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |');
		expect(table).toMatchObject({
			t: 'table',
			rows: [
				[[text('1')], []],
				[[text('1')], [text('2')]]
			]
		});
	});

	it('beendet die Tabelle an Leerzeile oder Zeile ohne Pipe', () => {
		expect(parseMarkdown('| a |\n|---|\n| 1 |\nText').map((b) => b.t)).toEqual(['table', 'p']);
	});

	it('verlangt gleich viele Spalten in Kopf und Trennzeile', () => {
		expect(parseMarkdown('| a | b |\n|---|')[0]!.t).not.toBe('table');
	});
});

describe('Robustheit', () => {
	it('übersteht 1000 verschachtelte Zitate', () => {
		const blocks = parseMarkdown('>'.repeat(1000) + ' tief');
		expect(blocks).toHaveLength(1);
		let depth = 0;
		let b: Block = blocks[0]!;
		while (b.t === 'quote') {
			depth++;
			b = b.c[0]!;
		}
		expect(depth).toBeLessThan(50);
		expect(b.t).toBe('p');
	});

	it('übersteht 5000 Sternchen und tief verschachtelte Hervorhebungen', () => {
		expect(plain(parseInline('*'.repeat(5000)))).toBe('*'.repeat(5000));
		const deep = '*a '.repeat(2000) + 'x' + ' b*'.repeat(2000);
		expect(plain(parseInline(deep)).length).toBeGreaterThan(0);
		const brackets = '['.repeat(3000) + 'x' + ']'.repeat(3000);
		expect(plain(parseInline(brackets))).toBe(brackets);
	});

	it('übersteht tief verschachtelte Listen', () => {
		const src = Array.from({ length: 500 }, (_, k) => ' '.repeat(Math.min(k * 2, 12)) + '- x').join(
			'\n'
		);
		expect(() => parseMarkdown(src)).not.toThrow();
	});

	it('parst 200 KB gemischtes Markdown in unter einer Sekunde', () => {
		const chunk = [
			'# Überschrift',
			'Text mit **fett**, *kursiv*, `code`, [Link](https://x.de) und https://y.de/z.',
			'- [x] Punkt eins',
			'  - Unterpunkt mit foo_bar_baz',
			'> Zitat',
			'| a | b |',
			'|---|---|',
			'| 1 | 2 |',
			'```js',
			'const x = 1;',
			'```',
			'',
			''
		].join('\n');
		const src = chunk.repeat(Math.ceil(200_000 / chunk.length));
		const t0 = performance.now();
		const blocks = parseMarkdown(src);
		expect(performance.now() - t0).toBeLessThan(1000);
		expect(blocks.length).toBeGreaterThan(1000);
	});

	it('parst 200 KB pathologische Marker in unter einer Sekunde', () => {
		for (const unit of ['*a', '**a', '_a ', '`', '[a', '~~a', '![', 'www.', '\\', '<https://']) {
			const src = unit.repeat(Math.ceil(200_000 / unit.length));
			const t0 = performance.now();
			parseMarkdown(src);
			expect(performance.now() - t0, unit).toBeLessThan(1000);
		}
	});
});
