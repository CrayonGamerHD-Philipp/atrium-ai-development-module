/// <reference lib="dom" />
/**
 * Seite der PC-Oberfläche (eine Datei, ohne Build-Schritt): `clientMain` wird als Text eingebettet
 * (`Function.prototype.toString`) und läuft im Browser-Fenster. Sie darf deshalb nichts außerhalb ihres eigenen
 * Körpers verwenden. Alle Werte aus dem Runner werden als Text gesetzt (`textContent`), nie als HTML.
 */

const CSS = String.raw`
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#1b1f24; --muted:#5f6b7a; --line:#e3e6ea;
	--accent:#2f6feb; --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; --chip:#eef1f4; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --fg:#e6e9ee; --muted:#9aa4b2;
	--line:#2a2f39; --accent:#5b8dff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --chip:#222733; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--fg); }
header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; z-index:2; }
header h1 { font-size:16px; margin:0; font-weight:600; }
header .sub { color:var(--muted); font-size:12px; }
nav { display:flex; gap:4px; margin-left:auto; }
nav button { background:none; border:0; padding:6px 12px; border-radius:6px; color:var(--muted); cursor:pointer; font:inherit; }
nav button.active { background:var(--chip); color:var(--fg); font-weight:600; }
main { max-width:1000px; margin:0 auto; padding:18px 20px 40px; }
section, #banners { display:grid; gap:14px; }
#banners:empty { display:none; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; }
.card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 10px; font-weight:600; }
.status { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
.dot { width:12px; height:12px; border-radius:50%; background:var(--muted); flex:none; }
.dot.ok { background:var(--ok); } .dot.warn { background:var(--warn); } .dot.bad { background:var(--bad); }
.state { font-size:18px; font-weight:600; }
.hint { color:var(--muted); }
.grid { display:grid; grid-template-columns: max-content 1fr; gap:4px 16px; margin-top:12px; }
.grid dt { color:var(--muted); } .grid dd { margin:0; overflow-wrap:anywhere; }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
button.btn { font:inherit; padding:7px 14px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
button.btn:hover:not(:disabled) { border-color:var(--accent); }
button.btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.btn.danger { color:var(--bad); }
button.btn:disabled { opacity:.5; cursor:default; }
.run { border:1px solid var(--line); border-radius:8px; padding:10px 12px; display:grid; gap:4px; }
.run + .run { margin-top:8px; }
.run .title { font-weight:600; }
.run .meta { color:var(--muted); font-size:12px; display:flex; gap:10px; flex-wrap:wrap; }
.run .activity { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; background:var(--chip); border-radius:6px; padding:6px 8px; overflow-wrap:anywhere; }
.chip { display:inline-block; padding:1px 8px; border-radius:999px; background:var(--chip); font-size:12px; }
.chip.ok { color:var(--ok); } .chip.bad { color:var(--bad); } .chip.warn { color:var(--warn); }
table { width:100%; border-collapse:collapse; }
td, th { text-align:left; padding:6px 8px; border-top:1px solid var(--line); vertical-align:middle; }
th { color:var(--muted); font-weight:500; font-size:12px; border-top:0; }
.empty { color:var(--muted); padding:8px 0; }
.banner { border-radius:8px; padding:10px 12px; border:1px solid var(--line); }
.banner.warn { border-color:var(--warn); } .banner.bad { border-color:var(--bad); } .banner.ok { border-color:var(--ok); }
.banner ul { margin:6px 0 0 18px; padding:0; }
textarea { width:100%; min-height:420px; font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; padding:10px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); resize:vertical; }
pre.log { margin:0; max-height:560px; overflow:auto; font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--bg); border-radius:8px; padding:10px; border:1px solid var(--line); }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.spacer { flex:1; }
.toast { position:fixed; right:16px; bottom:16px; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 14px; box-shadow:0 6px 24px rgba(0,0,0,.18); }
.toast.bad { border-color:var(--bad); } .toast.ok { border-color:var(--ok); }
.hidden { display:none !important; }
label.switch { display:inline-flex; align-items:center; gap:8px; cursor:pointer; }
`;

const BODY = String.raw`
<header>
	<div>
		<h1>Atrium Runner</h1>
		<div class="sub" id="sub">wird geladen …</div>
	</div>
	<nav>
		<button data-tab="overview" class="active">Übersicht</button>
		<button data-tab="config">Konfiguration</button>
		<button data-tab="logs">Protokoll</button>
	</nav>
</header>
<main>
	<section data-view="overview">
		<div class="card">
			<div class="status"><span class="dot" id="dot"></span><span class="state" id="state">…</span><span class="hint" id="stateHint"></span></div>
			<dl class="grid" id="facts"></dl>
			<div class="actions" id="actions"></div>
		</div>
		<div id="banners"></div>
		<div class="card">
			<h2 id="runsTitle">Läufe</h2>
			<div id="runs"></div>
		</div>
		<div class="card">
			<h2>Konten</h2>
			<div id="accounts"></div>
		</div>
		<div class="card">
			<h2>Prüfung</h2>
			<p class="hint">Prüft Konfiguration, git, gh, die Agent-CLIs und die Anmeldungen.</p>
			<div class="row"><button class="btn" id="probeBtn">Jetzt prüfen</button></div>
			<pre class="log hidden" id="probeOut"></pre>
		</div>
	</section>
	<section data-view="config" class="hidden">
		<div class="card">
			<h2>Konfiguration</h2>
			<p class="hint" id="cfgPath"></p>
			<p class="hint">Der API-Key wird als <code>********</code> angezeigt und bleibt beim Speichern erhalten, solange du ihn nicht ersetzt. Änderungen gelten nach einem Neustart des Runners.</p>
			<textarea id="cfgText" spellcheck="false"></textarea>
			<div class="row" style="margin-top:10px">
				<button class="btn primary" id="cfgSave">Speichern</button>
				<button class="btn" id="cfgSaveRestart">Speichern und neu starten</button>
				<button class="btn" id="cfgReload">Neu laden</button>
				<span class="spacer"></span>
				<button class="btn" data-open="config">Ordner öffnen</button>
			</div>
		</div>
		<div class="card">
			<h2>Autostart und Ordner</h2>
			<div class="row">
				<label class="switch"><input type="checkbox" id="autostart"> Beim Anmelden automatisch starten</label>
				<span class="hint" id="autostartDetail"></span>
			</div>
			<dl class="grid" id="paths"></dl>
			<div class="row" style="margin-top:10px">
				<button class="btn" data-open="work">Arbeitsverzeichnis öffnen</button>
				<button class="btn" data-open="logs">Log-Ordner öffnen</button>
				<span class="spacer"></span>
				<button class="btn" id="quitBtn" title="Schließt nur diese Oberfläche und das Tray-Symbol – der Runner läuft weiter">Oberfläche beenden</button>
			</div>
		</div>
	</section>
	<section data-view="logs" class="hidden">
		<div class="card">
			<div class="row" style="margin-bottom:8px">
				<h2 style="margin:0">Protokoll</h2>
				<span class="spacer"></span>
				<label class="switch"><input type="checkbox" id="follow" checked> Mitlaufen</label>
				<button class="btn" data-open="logs">Ordner öffnen</button>
			</div>
			<pre class="log" id="log"></pre>
		</div>
	</section>
</main>
<div class="toast hidden" id="toast"></div>
`;

/* eslint-disable @typescript-eslint/no-explicit-any -- läuft im Browser, Daten aus der eigenen API */
async function clientMain(): Promise<void> {
	const $ = (id: string) => document.getElementById(id) as HTMLElement;
	const h = (tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string | null)[]) => {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (k === 'text') el.textContent = v;
			else el.setAttribute(k, v);
		}
		for (const k of kids) if (k !== null) el.append(k);
		return el;
	};
	const toast = (text: string, tone: 'ok' | 'bad' = 'ok') => {
		const t = $('toast');
		t.textContent = text;
		t.className = `toast ${tone}`;
		clearTimeout((toast as any).timer);
		(toast as any).timer = setTimeout(() => t.classList.add('hidden'), tone === 'bad' ? 9000 : 4500);
	};
	const ago = (iso: string | null | undefined) => {
		if (!iso) return '–';
		const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
		if (s < 60) return `vor ${s} s`;
		if (s < 3600) return `vor ${Math.round(s / 60)} min`;
		return `vor ${Math.round(s / 3600)} h`;
	};
	const since = (iso: string) => {
		const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
		return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
	};

	// Zugriff: Einmal-Code aus der Adresse gegen das Token tauschen; danach nur noch im Fenster gespeichert
	let token = sessionStorage.getItem('runnerToken');
	const code = /[#&]c=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1];
	if (code) {
		history.replaceState(null, '', location.pathname);
		const r = await fetch('/api/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code })
		});
		if (r.ok) {
			token = ((await r.json()) as { token: string }).token;
			sessionStorage.setItem('runnerToken', token);
		}
	}
	const denied = () => {
		$('state').textContent = 'Kein Zugriff';
		$('stateHint').textContent = 'Bitte die Oberfläche über das Startmenü bzw. „atrium-runner app“ öffnen.';
		$('dot').className = 'dot bad';
	};
	if (!token) {
		denied();
		return;
	}
	const api = async (method: string, path: string, body?: unknown): Promise<any> => {
		const r = await fetch(path, {
			method,
			headers: { 'x-runner-token': token!, ...(body ? { 'content-type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined
		});
		if (r.status === 401) {
			sessionStorage.removeItem('runnerToken');
			denied();
			throw new Error('Kein Zugriff');
		}
		const data = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(data.error || `Fehler ${r.status}`);
		return data;
	};

	// Reiter
	let tab = 'overview';
	const showTab = (name: string) => {
		tab = name;
		document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === name));
		document.querySelectorAll('section[data-view]').forEach((s) => s.classList.toggle('hidden', (s as HTMLElement).dataset.view !== name));
		if (name === 'config' && !cfgLoaded) void loadConfig();
		if (name === 'logs') void pollLogs();
	};
	document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab((b as HTMLElement).dataset.tab!)));
	document.querySelectorAll('[data-open]').forEach((b) =>
		b.addEventListener('click', () =>
			api('POST', '/api/open', { which: (b as HTMLElement).dataset.open }).catch((e: Error) => toast(e.message, 'bad'))
		)
	);

	let busy = false;
	const act = async (name: string, label: string) => {
		if (busy) return;
		busy = true;
		render(last);
		toast(`${label} …`);
		try {
			const r = await api('POST', `/api/action/${name}`);
			toast(r.message || label, r.ok ? 'ok' : 'bad');
		} catch (e) {
			toast((e as Error).message, 'bad');
		} finally {
			busy = false;
			await refresh();
		}
	};

	const PROVIDERS: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', 'openai-api': 'OpenAI API', fake: 'Test' };
	const REASON: Record<string, string> = { suspend: 'Standby', shutdown: 'Herunterfahren', manual: 'manuell' };

	let last: any = null;
	const render = (s: any) => {
		if (!s) return;
		const r = s.runner;
		const running = s.process.running;
		$('sub').textContent = `${r?.name || s.config.name || 'PC-Runner'} · Version ${s.version}${r && r.version !== s.version ? ` (Runner ${r.version})` : ''}`;
		let tone = 'ok';
		let state = 'Aktiv';
		let hint = '';
		if (!s.config.exists || !s.config.complete) {
			tone = 'warn';
			state = 'Einrichtung nötig';
			hint = s.config.error || 'Atrium-Adresse und API-Key in der Konfiguration eintragen.';
		} else if (!s.config.ok) {
			tone = 'bad';
			state = 'Konfiguration fehlerhaft';
			hint = s.config.error || '';
		} else if (!running) {
			tone = 'bad';
			state = 'Gestoppt';
			hint = s.autostart.installed ? 'Startet beim nächsten Anmelden automatisch.' : 'Kein Autostart eingerichtet.';
		} else if (r?.pausedByUser) {
			tone = 'warn';
			state = 'Pausiert';
			hint = 'Keine neuen Aufträge; laufende wurden an einen Server-Runner übergeben.';
		} else if (r?.paused) {
			tone = 'warn';
			state = 'Wird übergeben';
			hint = `Grund: ${REASON[r.paused] || r.paused}`;
		} else if (r?.atrium && !r.atrium.ok && r.atrium.at) {
			tone = 'bad';
			state = 'Keine Verbindung zu Atrium';
			hint = r.atrium.error || '';
		} else if (r?.status === 'pending') {
			tone = 'warn';
			state = 'Wartet auf Freigabe';
			hint = 'In Atrium unter Administration → Runner & Konten freigeben.';
		} else if (r?.status === 'disabled') {
			tone = 'bad';
			state = 'In Atrium deaktiviert';
		} else if (!r) {
			tone = 'warn';
			state = 'Startet …';
		}
		$('dot').className = `dot ${tone}`;
		$('state').textContent = state;
		$('stateHint').textContent = hint;

		const facts = $('facts');
		facts.replaceChildren();
		const fact = (k: string, v: string) => facts.append(h('dt', { text: k }), h('dd', { text: v }));
		fact('Atrium', r?.atriumUrl || s.config.atriumUrl || '–');
		fact('Letzter Heartbeat', r ? ago(r.lastHeartbeatAt) : '–');
		fact('Prozess', running ? `läuft (PID ${s.process.pid})${r ? `, seit ${since(r.startedAt)}` : ''}` : 'läuft nicht');
		fact('Läufe', r ? `${(r.details || r.runs || []).length} von ${r.maxSlots ?? s.config.maxSlots ?? '?'}` : '–');
		fact('Standby-Erkennung', r?.power || '–');
		fact('Autostart', s.autostart.installed ? `eingerichtet (${s.autostart.detail})` : 'nicht eingerichtet');

		const actions = $('actions');
		actions.replaceChildren();
		const btn = (label: string, name: string, cls = 'btn', title = '') => {
			const b = h('button', { class: cls, text: label, ...(title ? { title } : {}) }) as HTMLButtonElement;
			b.disabled = busy || !!s.busy;
			b.addEventListener('click', () => void act(name, label));
			actions.append(b);
		};
		if (!running) btn('Starten', 'start', 'btn primary');
		else {
			if (r?.pausedByUser) btn('Fortsetzen', 'resume', 'btn primary');
			else btn('Pausieren', 'pause', 'btn', 'Keine neuen Aufträge annehmen; laufende an einen Server-Runner übergeben');
			btn('Jetzt an Server übergeben', 'handover', 'btn', 'Laufende Aufträge sofort an einen Server-Runner übergeben');
			btn('Neu starten', 'restart');
			btn('Stoppen', 'stop', 'btn danger', 'Laufende Aufträge werden übergeben, dann wird der Runner beendet');
		}
		if (s.busy) actions.append(h('span', { class: 'hint', text: `${s.busy} …` }));

		const banners = $('banners');
		banners.replaceChildren();
		if (s.isolation?.length) {
			const ul = h('ul');
			for (const f of s.isolation) ul.append(h('li', { text: `${f.label}: ${f.path}` }));
			banners.append(
				h(
					'div',
					{ class: 'card banner warn' },
					h('strong', { text: 'Sicherheit: ' }),
					'Die Agents laufen ohne Docker mit deinen Rechten und könnten diese persönlichen Daten lesen. Empfohlen ist ein eigenes Benutzerkonto nur für den Runner (siehe README, „Sicherheit ohne Docker“).',
					ul
				)
			);
		}

		const runs = $('runs');
		runs.replaceChildren();
		const list: any[] = r?.details || [];
		$('runsTitle').textContent = `Läufe (${list.length}${r?.maxSlots ? ` / ${r.maxSlots}` : ''})`;
		if (!list.length) runs.append(h('div', { class: 'empty', text: running ? 'Gerade kein Auftrag – der Runner wartet auf Arbeit.' : 'Runner läuft nicht.' }));
		for (const x of list) {
			runs.append(
				h(
					'div',
					{ class: 'run' },
					h('div', { class: 'title', text: x.title || x.taskId }),
					h(
						'div',
						{ class: 'meta' },
						h('span', { text: x.repo }),
						h('span', { text: x.branch }),
						h('span', { text: `${x.role} · ${PROVIDERS[x.provider] || x.provider} (${x.account})${x.model ? ` · ${x.model}` : ''}` }),
						h('span', { text: `seit ${since(x.startedAt)}` }),
						x.handover ? h('span', { class: 'chip warn', text: `wird übergeben (${REASON[x.handover] || x.handover})` }) : null
					),
					h('div', { class: 'activity', text: x.activity ? `${x.activity.text}  ·  ${ago(x.activity.at)}` : 'startet …' })
				)
			);
		}

		const acc = $('accounts');
		acc.replaceChildren();
		const known: any[] = r?.accounts || s.config.accounts || [];
		if (!known.length) acc.append(h('div', { class: 'empty', text: 'Keine Konten konfiguriert.' }));
		else {
			const table = h('table');
			table.append(h('tr', {}, h('th', { text: 'Konto' }), h('th', { text: 'Anbieter' }), h('th', { text: 'Zustand' }), h('th', { text: '' })));
			for (const a of known) {
				const st =
					a.ok === undefined
						? h('span', { class: 'chip', text: 'unbekannt' })
						: !a.ok
							? h('span', { class: 'chip bad', text: 'CLI fehlt' })
							: a.loggedIn
								? h('span', { class: 'chip ok', text: `angemeldet${a.version ? ` · ${a.version}` : ''}` })
								: h('span', { class: 'chip warn', text: 'nicht angemeldet' });
				const login = h('button', { class: 'btn', text: 'Anmelden', title: 'Öffnet ein Terminal mit der Anmeldung der CLI' }) as HTMLButtonElement;
				login.addEventListener('click', () =>
					api('POST', '/api/login', { account: a.key })
						.then((x: any) => toast(x.message, x.ok ? 'ok' : 'bad'))
						.catch((e: Error) => toast(e.message, 'bad'))
				);
				table.append(h('tr', {}, h('td', { text: a.label ? `${a.label} (${a.key})` : a.key }), h('td', { text: PROVIDERS[a.provider] || a.provider }), h('td', {}, st), h('td', {}, a.provider === 'fake' || a.provider === 'openai-api' ? null : login)));
			}
			acc.append(table);
		}

		const auto = $('autostart') as HTMLInputElement;
		auto.checked = !!s.autostart.installed;
		auto.disabled = busy || !!s.busy;
		$('autostartDetail').textContent = s.autostart.error || s.autostart.detail || '';
		const paths = $('paths');
		paths.replaceChildren();
		for (const [k, v] of [
			['Konfiguration', s.paths.config],
			['Arbeitsverzeichnis', s.paths.work],
			['Logs', s.paths.logs]
		])
			paths.append(h('dt', { text: k }), h('dd', { text: v }));
		$('cfgPath').textContent = s.paths.config;
	};

	const refresh = async () => {
		try {
			last = await api('GET', '/api/state');
			render(last);
		} catch (e) {
			if ((e as Error).message !== 'Kein Zugriff') {
				$('dot').className = 'dot bad';
				$('state').textContent = 'Oberfläche nicht erreichbar';
				$('stateHint').textContent = (e as Error).message;
			}
		}
	};

	($('autostart') as HTMLInputElement).addEventListener('change', (ev) => {
		const on = (ev.target as HTMLInputElement).checked;
		void act(on ? 'autostart-on' : 'autostart-off', on ? 'Autostart einrichten' : 'Autostart entfernen');
	});
	$('quitBtn').addEventListener('click', () => {
		void api('POST', '/api/quit').then((x: any) => {
			toast(x.message);
			setTimeout(() => window.close(), 600);
		});
	});

	// Prüfung
	$('probeBtn').addEventListener('click', async () => {
		const b = $('probeBtn') as HTMLButtonElement;
		const out = $('probeOut');
		b.disabled = true;
		out.classList.remove('hidden');
		out.textContent = 'Prüfe …';
		try {
			const r = await api('POST', '/api/probe');
			out.textContent = r.output || (r.ok ? 'Alles in Ordnung.' : 'Prüfung fehlgeschlagen.');
			toast(r.ok ? 'Prüfung erfolgreich' : 'Prüfung mit Problemen – siehe Ausgabe', r.ok ? 'ok' : 'bad');
		} catch (e) {
			out.textContent = (e as Error).message;
		} finally {
			b.disabled = false;
		}
	});

	// Konfiguration
	let cfgLoaded = false;
	const loadConfig = async () => {
		try {
			const c = await api('GET', '/api/config');
			($('cfgText') as HTMLTextAreaElement).value = c.text;
			cfgLoaded = true;
		} catch (e) {
			toast((e as Error).message, 'bad');
		}
	};
	const saveConfig = async (restart: boolean) => {
		try {
			const r = await api('PUT', '/api/config', { text: ($('cfgText') as HTMLTextAreaElement).value });
			if (!r.ok) {
				toast(r.message, 'bad');
				return;
			}
			toast(r.message);
			cfgLoaded = false;
			await loadConfig();
			if (restart) await act(last?.process.running ? 'restart' : 'start', 'Neu starten');
			else await refresh();
		} catch (e) {
			toast((e as Error).message, 'bad');
		}
	};
	$('cfgSave').addEventListener('click', () => void saveConfig(false));
	$('cfgSaveRestart').addEventListener('click', () => void saveConfig(true));
	$('cfgReload').addEventListener('click', () => void loadConfig());

	// Protokoll
	let logOffset = -1;
	let logBusy = false;
	const pollLogs = async () => {
		if (logBusy || tab !== 'logs') return;
		logBusy = true;
		try {
			const r = await api('GET', `/api/logs?offset=${logOffset}`);
			const pre = $('log');
			if (r.reset) pre.textContent = '';
			if (r.text) pre.append(r.text);
			// begrenzen, damit das Fenster nicht unendlich wächst
			if ((pre.textContent || '').length > 400_000) pre.textContent = (pre.textContent || '').slice(-300_000);
			logOffset = r.offset;
			if (($('follow') as HTMLInputElement).checked) pre.scrollTop = pre.scrollHeight;
		} catch {
			// nächster Versuch
		} finally {
			logBusy = false;
		}
	};

	await refresh();
	setInterval(() => {
		if (!document.hidden) void refresh();
	}, 2000);
	setInterval(() => {
		if (!document.hidden) void pollLogs();
	}, 1500);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Vollständige Seite (HTML mit eingebettetem CSS und Skript) */
export function appPage(): string {
	// `__name`: falls ein Transpiler Funktionsnamen-Hilfen einfügt (keepNames), existiert der Helfer auch hier
	const script = `var __name = function (f) { return f; };\n(${clientMain.toString()})();`;
	return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atrium Runner</title>
<style>${CSS}</style>
</head>
<body>
${BODY}
<script>${script}</script>
</body>
</html>`;
}
