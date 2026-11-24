/**
 * CodeMirror 6 für den Workspace: eine `EditorView`, je offener Datei ein eigener `EditorState` (Verlauf bleibt je
 * Datei erhalten). Pakete werden erst im Browser geladen (`init` in `onMount`), damit SSR nicht bricht.
 * Sprache nach Dateiname über `@codemirror/language-data`, Dunkelmodus über `oneDark`.
 */
import type { Compartment, EditorState, Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

type Modules = {
	EditorView: typeof import('@codemirror/view').EditorView;
	keymap: typeof import('@codemirror/view').keymap;
	EditorState: typeof import('@codemirror/state').EditorState;
	Compartment: typeof import('@codemirror/state').Compartment;
	Prec: typeof import('@codemirror/state').Prec;
	basicSetup: Extension;
	oneDark: Extension;
	languages: (typeof import('@codemirror/language-data'))['languages'];
};

type LanguageDescription = Modules['languages'][number];

/** Wie `LanguageDescription.matchFilename`: zuerst Dateinamen-Muster, dann Endung */
function matchLanguage(languages: readonly LanguageDescription[], filename: string) {
	for (const l of languages) if (l.filename && l.filename.test(filename)) return l;
	const dot = filename.lastIndexOf('.');
	if (dot < 0) return null;
	const ext = filename.slice(dot + 1).toLowerCase();
	for (const l of languages) if (l.extensions.includes(ext)) return l;
	return null;
}

export interface EditorHostOptions {
	/** Inhalt einer Datei wurde geändert */
	onChange: (key: string) => void;
	/** Strg+S im Editor */
	onSave: () => void;
}

export class EditorHost {
	private m: Modules | null = null;
	private view: EditorView | null = null;
	private states = new Map<string, EditorState>();
	private theme: Compartment | null = null;
	private language: Compartment | null = null;
	private dark = false;
	active: string | null = null;

	constructor(private readonly opts: EditorHostOptions) {}

	async init(parent: HTMLElement, dark: boolean): Promise<void> {
		const [cm, view, state, langData, themeMod] = await Promise.all([
			import('codemirror'),
			import('@codemirror/view'),
			import('@codemirror/state'),
			import('@codemirror/language-data'),
			import('@codemirror/theme-one-dark')
		]);
		this.m = {
			EditorView: view.EditorView,
			keymap: view.keymap,
			EditorState: state.EditorState,
			Compartment: state.Compartment,
			Prec: state.Prec,
			basicSetup: cm.basicSetup,
			oneDark: themeMod.oneDark,
			languages: langData.languages
		};
		this.dark = dark;
		this.theme = new state.Compartment();
		this.language = new state.Compartment();
		this.view = new view.EditorView({ parent, state: this.createState('', '', true) });
	}

	get ready(): boolean {
		return !!this.view;
	}

	private baseTheme(): Extension {
		const m = this.m!;
		return m.EditorView.theme({
			'&': { height: '100%', fontSize: '13px' },
			'.cm-scroller': {
				fontFamily:
					'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
				lineHeight: '1.55'
			},
			'&.cm-focused': { outline: 'none' }
		});
	}

	private createState(key: string, content: string, readOnly: boolean): EditorState {
		const m = this.m!;
		return m.EditorState.create({
			doc: content,
			extensions: [
				m.basicSetup,
				m.Prec.highest(
					m.keymap.of([
						{
							key: 'Mod-s',
							preventDefault: true,
							run: () => {
								this.opts.onSave();
								return true;
							}
						}
					])
				),
				this.baseTheme(),
				this.theme!.of(this.dark ? m.oneDark : []),
				this.language!.of([]),
				m.EditorState.readOnly.of(readOnly),
				m.EditorView.updateListener.of((u) => {
					if (u.docChanged && key) this.opts.onChange(key);
				})
			]
		});
	}

	/** Datei öffnen (oder nur anzeigen, wenn schon offen) */
	open(key: string, filename: string, content: string, readOnly = false): void {
		if (!this.m || !this.view) return;
		if (!this.states.has(key)) {
			this.states.set(key, this.createState(key, content, readOnly));
			void this.loadLanguage(key, filename);
		}
		this.show(key);
	}

	private async loadLanguage(key: string, filename: string) {
		const m = this.m;
		if (!m) return;
		const desc = matchLanguage(m.languages, filename.split('/').pop() ?? filename);
		if (!desc) return;
		try {
			const support = await desc.load();
			const effects = this.language!.reconfigure(support);
			if (this.active === key && this.view) this.view.dispatch({ effects });
			else {
				const st = this.states.get(key);
				if (st) this.states.set(key, st.update({ effects }).state);
			}
		} catch {
			// ohne Hervorhebung weiterarbeiten
		}
	}

	show(key: string): void {
		if (!this.view) return;
		if (this.active === key) return;
		if (this.active && this.states.has(this.active)) this.states.set(this.active, this.view.state);
		const st = this.states.get(key);
		if (!st) return;
		this.view.setState(st);
		this.active = key;
		this.applyTheme();
		this.view.focus();
	}

	/** Editor leeren (kein Tab aktiv) */
	clear(): void {
		if (!this.view || !this.m) return;
		if (this.active && this.states.has(this.active)) this.states.set(this.active, this.view.state);
		this.active = null;
		this.view.setState(this.createState('', '', true));
		this.applyTheme();
	}

	close(key: string): void {
		this.states.delete(key);
		if (this.active === key) {
			this.active = null;
			this.clear();
		}
	}

	content(key: string): string | null {
		if (this.active === key && this.view) return this.view.state.doc.toString();
		return this.states.get(key)?.doc.toString() ?? null;
	}

	setDark(dark: boolean): void {
		this.dark = dark;
		this.applyTheme();
	}

	private applyTheme() {
		if (!this.view || !this.m || !this.theme) return;
		this.view.dispatch({ effects: this.theme.reconfigure(this.dark ? this.m.oneDark : []) });
	}

	focus(): void {
		this.view?.focus();
	}

	destroy(): void {
		this.view?.destroy();
		this.view = null;
		this.states.clear();
	}
}
