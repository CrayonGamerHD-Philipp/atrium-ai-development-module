# Atrium aidev-Runner

Der Runner führt die Agent-Läufe des Atrium-Moduls **KI-Entwicklung** (`aidev`) aus. Atrium ist die Steuerzentrale;
der Runner läuft getrennt davon (Docker-Container auf einem Server oder als fertiges Programm auf deinem PC, siehe
[PC-Runner](#pc-runner-windows-macos-linux)), verbindet sich **ausgehend** mit Atrium und braucht keine offenen Ports.

- Anmeldung mit einem API-Key, Befehle per Server-Sent Events (`GET /runner/stream`), Rückmeldungen per JSON-POST.
- Agents: **Claude Code** (`claude`), **Codex** (`codex`), **Gemini CLI** (`gemini`), **OpenAI-kompatible APIs**
  (über Codex) – jeweils mit den Abo-Logins bzw. Keys, die auf dem Runner hinterlegt sind.
- Jeder Lauf arbeitet in einem eigenen git-Worktree, committet, testet, pusht und öffnet PRs (`gh`).
- Für die Browser-Oberfläche: Dateien lesen/schreiben, git-Status/Diff/Log, PR-Liste, Terminals (node-pty).

Der verbindliche Vertrag steht in [`modules/aidev/protocol.ts`](../modules/aidev/protocol.ts) und wird mitgebündelt.

## Einrichtung Schritt für Schritt

### 1. Technischen Benutzer und API-Key in Atrium anlegen

1. In Atrium einen eigenen Benutzer anlegen, z. B. `runner-bot` (kein Mensch, kein Login nötig).
2. Diesem Benutzer **nur** die Berechtigung `aidev.runner.connect` geben.
3. Für diesen Benutzer einen API-Key erzeugen. Er wird nur einmal angezeigt – sicher aufbewahren.

### 2. Konfiguration

Umgebungsvariablen (Vorrang) und/oder eine JSON-Datei (`RUNNER_CONFIG`, Standard `./runner.config.json`,
Vorlage: [`runner.config.example.json`](runner.config.example.json)):

| Variable | Bedeutung | Standard |
|---|---|---|
| `ATRIUM_URL` | Adresse von Atrium | – (Pflicht) |
| `ATRIUM_API_KEY` | API-Key aus Schritt 1 | – (Pflicht) |
| `RUNNER_NAME` | Anzeigename in Atrium | Rechnername |
| `WORK_DIR` | Repos, Worktrees, Arbeitskopien | `./.work` (Docker: `/work`) |
| `MAX_SLOTS` | gleichzeitige Läufe | `2` |
| `RUNNER_ACCOUNTS` | Konten als JSON (statt `accounts` in der Datei) | – |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | Commit-Autor | `Atrium Agent` / `agent@atrium.local` |
| `GH_TOKEN` | GitHub-Token für `gh` und `git push` | – (alternativ `gh auth login`) |
| `GIT_REMOTE_TEMPLATE` | Remote-URL-Vorlage | `https://github.com/{owner}/{repo}.git` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `LIMIT_PROBE` | aktive Limit-Abfrage ohne Lauf (`true`/`false`, Datei: `limitProbe`) | an für Claude-Konten mit OAuth-Login |
| `LIMIT_PROBE_MIN` | Abstand der aktiven Limit-Abfrage in Minuten (1–1440, Datei: `limitProbeMin`) | `5` |
| `DRAIN_SEC` | beim Beenden so viele Sekunden auf laufende Läufe warten (0–86400, Datei: `drainSec`), siehe [Neustart](#neustart-während-laufender-aufträge) | `0` |
| `AUTO_REPAIR_ROUNDS` | Selbstreparatur im selben Lauf: Runden je Testfehler bzw. Konflikt (0–10, `0` = aus, Datei: `autoRepairRounds`), siehe [Selbstreparatur](#selbstreparatur-und-konflikte-im-selben-lauf) | `2` |
| `RESEARCH` | Recherche-Schnittstelle für Agents (`true`/`false`, Datei: `research`), siehe [Recherche](#recherche-auf-anforderung) | `true` |
| `RESEARCH_MAX` | höchstens so viele Recherchen je Lauf (0–20, Datei: `researchMax`) | `3` |
| `RESEARCH_ACCOUNTS` | bevorzugte Konten für Recherchen, kommagetrennt (Datei: `researchAccounts` als Liste) | – (anderes freies Konto, sonst dasselbe) |
| `REPO_MAP` | Repository-Übersicht aus git an den Auftrag hängen (`true`/`false`, Datei: `repoMap`) | `true` |

Ein Konto (`accounts[]`):

| Feld | Bedeutung |
|---|---|
| `key` | eindeutiger Schlüssel, z. B. `claude-main` (Kleinbuchstaben, Ziffern, `-`) |
| `provider` | `claude`, `codex`, `gemini`, `openai-api` oder `fake` (Tests/Vorführung) |
| `label` | Anzeigename in Atrium |
| `home` | eigenes Login-Verzeichnis je Konto: setzt `HOME`, `CLAUDE_CONFIG_DIR=<home>/.claude`, `CODEX_HOME=<home>/.codex`, `GEMINI_CLI_HOME=<home>` |
| `env` | zusätzliche Umgebungsvariablen für den Agent (Werte gelten als geheim und werden aus allen Ausgaben entfernt) |
| `models` | Modelle, die Atrium für das Konto anbieten darf (leer = Standardmodell der CLI) |
| `command` | Pfad zur CLI, falls nicht im `PATH` |
| `baseUrl`, `apiKeyEnv`, `model`, `wireApi` | nur `openai-api` (siehe unten) |
| `reasoningEffort` | nur Codex/`openai-api`: `model_reasoning_effort` |
| `limitProbe` | aktive Limit-Abfrage für dieses Konto an/aus (Vorrang vor `LIMIT_PROBE`; derzeit nur Claude) |

Konfiguration prüfen: `node dist/main.js probe` (bzw. `docker compose run --rm runner probe`).

### 3. Bei den Agent-CLIs anmelden (je Konto einmal)

Die Logins bleiben auf dem Runner und erreichen Atrium nie. Mit `home` je Konto lassen sich mehrere Abos derselben
Art nebeneinander betreiben. Der Runner startet die Anmeldung mit der richtigen Umgebung:

```sh
docker compose run --rm runner login claude-main   # claude auth login
docker compose run --rm runner login codex-main    # codex login --device-auth
docker compose run --rm runner login gemini-main   # gemini (interaktive Google-Anmeldung)
docker compose run --rm --entrypoint gh runner auth login   # oder GH_TOKEN setzen
docker compose run --rm runner probe
```

Ohne `home` geht auch direkt: `docker compose run --rm --entrypoint claude runner auth login` bzw. `… codex login`.

### 4. Starten

```sh
cd runner
cp docker-compose.example.yml docker-compose.yml   # anpassen
mkdir -p config && cp runner.config.example.json config/runner.config.json   # anpassen
docker compose build      # Build-Kontext ist die Repo-Wurzel (protocol.ts wird mitgebündelt)
docker compose up -d
docker compose logs -f runner
```

Ohne Compose: `docker build -f runner/Dockerfile -t atrium-aidev-runner .` (aus der Repo-Wurzel).

Lokal ohne Docker zur Entwicklung: `npm install && npm run build && npm start` bzw. `npm run dev`. Für den
Dauerbetrieb auf dem eigenen PC gibt es fertige Programme mit Autostart und Übergabe an Server-Runner, siehe
[PC-Runner](#pc-runner-windows-macos-linux) (Sicherheit ohne Docker beachten).

### 5. In Atrium freigeben

Der Runner meldet sich mit Status **pending** an. Unter **Administration → Runner & Konten** freigeben; danach erhält
der Runner Aufträge. Konten, deren CLI fehlt oder die nicht angemeldet sind, meldet der Runner als `loggedIn: false`
(Prüfung beim Start und alle 5 Minuten); Angebote für solche Konten lehnt er ab.

## Ablauf eines Laufs

1. **Worktree** `WORK_DIR/wt/<runId>` aus dem Bare-Cache `WORK_DIR/cache/<owner>/<repo>.git` (vorher `fetch --prune`):
   existiert `origin/<branch>`, wird darauf fortgesetzt; sonst neuer Branch von `origin/<baseRef>`. Fehlt die Basis
   (Integrations-Branch beim ersten Teilauftrag), wird sie aus dem Haupt-Branch angelegt und gepusht – außer beim
   Head-Branch eines PR (`pr-update`, `integrate` mit `pullNumber`): dann bricht der Lauf ab.
2. **setupCmd** in der Shell im Worktree (Ausgabe als Ereignisse; Fehlschlag → `setup`).
   Danach **Anhänge** (`offer.attachments`, Fähigkeit `capabilities.attachments`): binär über
   `GET /runner/runs/<runId>/attachments/<attachmentId>` laden (höchstens die angekündigte Größe, SHA-256 geprüft,
   Wiederholung bei 5xx/429), nach `.aidev/attachments/<name>` schreiben (gemeinsame Namensregel `uniqueAttachmentNames`
   aus `protocol.ts`, Duplikate als `name-2.ext` – dieselben Namen wie im Prompt von Atrium). Enthält das Repository
   unter `.aidev/attachments/` versionierte Dateien, bricht der Lauf ab (`setup`). `/.aidev/` steht in `info/exclude`
   des gemeinsamen git-dir, und der Runner nimmt die Ablage vor seinem Commit ausdrücklich aus dem Index (auch nach
   `git add -f` des Agents) – in keinem Auslieferungsmodus wird sie committet. Nennt der Auftrag nicht schon jeden
   gespeicherten Pfad, wird ein Abschnitt „Anhänge“ mit den tatsächlichen Pfaden an den Prompt angehängt. Fehlschlag → `setup` mit Dateinamen und Ursache.
3. **Agent** mit Auftrag, Systemanweisung, Modell, ggf. Fortsetzung der Sitzung. Limit erkannt → `/limit`, Abbruch,
   `limited`. Zeitlimit → `timeout`. Abbruch durch Atrium → `cancelled`.
4. **Nur-Lese-Rollen**: Änderungen verwerfen (`reset --hard`, `clean -fd`), Zusammenfassung = letzte Antwort; bei
   Orchestrierung wird der Plan (```json-Block) mitgesendet.
5. **Schreibend**: offene Änderungen committen (Trailer `Aidev-Task: <id>`), **testCmd** (Fehlschlag → nichts
   pushen), dann Auslieferung: `pr` (Push + `gh pr create`, optional Auto-Merge), `direct` (Rebase + Push auf den
   Haupt-Branch, bis zu 3 Versuche), `integrate` (Merge `--no-ff` in den Integrations-Branch, bis zu 3 Versuche),
   `pr-update` (Push ohne Force auf den Head-Branch eines bestehenden PR, nach einem Rebase auf parallel gepushte
   Commits erneut **testCmd**, Zusammenfassung als PR-Kommentar) oder
   `none`. Konflikte löst der Agent im selben Lauf (siehe unten); erst wenn das scheitert → `conflict` mit Dateiliste.

### Selbstreparatur und Konflikte im selben Lauf

Statt einen Lauf bei der ersten Hürde scheitern zu lassen (und später einen neuen Lauf von vorn zu starten), setzt der
Runner die **Sitzung desselben Agents im selben Worktree** mit einem gezielten Reparaturauftrag fort (Claude, Codex und
`openai-api` mit `--resume`, sonst mit dem ursprünglichen Auftrag plus Reparaturauftrag). Je Hürde höchstens
`AUTO_REPAIR_ROUNDS` Runden (Standard 2); alles läuft innerhalb des Zeitlimits des Laufs:

| Hürde | Verhalten |
|---|---|
| vorübergehender Fehler des Agents (Überlastung/529, 5xx, Netzwerk, abgebrochener Stream) | bis zu 2 neue Versuche mit Wartezeit, Sitzung wird fortgesetzt |
| `git fetch` schlägt mit Netzwerkfehler fehl | bis zu 3 Versuche mit Wartezeit |
| **testCmd** schlägt fehl | der Agent bekommt Befehl, Exit-Code und das Ende der Ausgabe und behebt die Ursache; Commit „… (Nachbesserung Tests)“, danach erneut testen |
| **Konflikt** beim Ausliefern (`direct`, `integrate`, `pr-update`) | der Runner mergt den neuen Stand des Ziels in den Branch (Merge statt Rebase: alle Konflikte in einem Durchgang), der Agent löst die Konfliktmarker und committet den Merge; der Runner prüft, dass keine Datei mehr „unmerged“ ist bzw. Marker enthält, testet erneut und liefert aus (bei `direct` per Fast-Forward, ohne erneuten Rebase) |
| `pr`/`branch`: Branch würde mit dem Haupt-Branch kollidieren | vorab geprüft (`git merge-tree`), dann wie oben gelöst, damit der PR mergebar bleibt; gelingt das nicht, wird trotzdem ausgeliefert (wie bisher) |
| Auftrag mit Rolle `resolve` (Rückfall von Atrium) | der Runner mergt das Ziel **vor** dem ersten Aufruf, damit die Konflikte wirklich im Worktree stehen |

Gelingt die Lösung nicht, endet der Lauf wie bisher mit `conflict` bzw. `tests`; Atrium plant dann eine Konfliktlösung
bzw. einen neuen Versuch. Bei `direct` sichert der Runner vorher den Arbeitsstand auf dem Auftrags-Branch, damit die
Konfliktlösung darauf aufsetzen kann. Was nachgebessert wurde, steht am Ende der Zusammenfassung
(„Automatisch im selben Lauf nachgebessert“) und im Verlauf.

### Recherche auf Anforderung

Agents können **mitten im Lauf eine Recherche anfordern**, z. B. wenn Claude, Codex oder Gemini Wissen zu einer
externen API, einer Bibliotheksversion oder einem unklaren Verhalten fehlt. Der Systemanweisung wird dazu ein
Abschnitt „Research on demand“ angehängt; der Agent ruft auf:

```sh
node .aidev/bin/research.mjs "<präzise Frage>" "<optional: Kontext, was schon bekannt ist>"
```

Der Befehl blockiert, bis die Recherche fertig ist, und gibt das Ergebnis als Markdown aus. Ohne `node` kann der
Agent die Anfrage auch selbst als `.aidev/research/<id>.request.json` (`{"question": "…"}`) ablegen und auf
`<id>.answer.json` warten. Der Transport läuft über Dateien im Worktree – ohne Netzwerkport, in jeder Sandbox und auf
allen Systemen; `.aidev/` wird nie committet.

Der Runner beantwortet die Anfrage mit einem eigenen, **nur lesenden** Recherche-Agent im selben Worktree (Claude:
`Read,Glob,Grep,WebSearch,WebFetch`; Gemini: Lese-Werkzeuge plus `google_web_search`, `web_fetch`; Codex:
`--sandbox read-only`). Konto: zuerst `RESEARCH_ACCOUNTS` in dieser Reihenfolge, sonst ein **anderes** angemeldetes
Konto ohne aktives Limit (verteilt die Last, z. B. recherchiert Gemini für Claude), sonst dasselbe Konto. Stößt ein
Konto ans Limit, wird das nächste versucht. Höchstens `RESEARCH_MAX` Recherchen je Lauf, je höchstens 15 Minuten.
Fragen und Ergebnisse erscheinen im Verlauf des Laufs; der Verbrauch desselben Kontos zählt zum Lauf. Nicht für
Chat-Fragen und Recherche-Aufträge (keine Rekursion). Ergebnisse werden je Repository zwischengespeichert
(`WORK_DIR/meta/research/<owner>/<repo>/`, 3 Tage): dieselbe Frage (gleicher Text und Kontext) kostet dann keine
Tokens.

### Repository-Übersicht

Vor dem ersten Agent-Aufruf hängt der Runner eine kompakte Übersicht an den Auftrag (höchstens 3000 Zeichen):
Dateizahl, Ordner mit Dateizahlen (zweite Ebene für große Ordner), Dateitypen, wichtige Dateien (README, Manifeste,
CI) und die Skripte aus `package.json`. Sie entsteht nur aus git (`ls-files`), kostet also keine Tokens, und wird je
Tree-SHA unter `WORK_DIR/meta/repomap/<owner>/<repo>/` zwischengespeichert (die letzten 10). Bei einer fortgesetzten
Sitzung entfällt sie. Abschalten mit `REPO_MAP=false`.

Worktrees bleiben nach dem Lauf erhalten (Editor/Terminal „Lauf“), aufgeräumt wird beim Start und stündlich
(älter als 48 h bzw. mehr als 30). Die Arbeitskopie des Haupt-Branchs je Projekt liegt in
`WORK_DIR/projects/<projectId>/main`. Repo-Hooks sind für die git-Befehle des Runners abgeschaltet
(`core.hooksPath` auf ein leeres Verzeichnis).

**Branches aufräumen** (RPC `git.branch-delete`, Capability `branchCleanup`, nur mit git und gh): Atrium schickt bis zu
50 Branches, die nach dem PR nicht mehr gebraucht werden, optional mit erwartetem Stand je Branch (`expect`). Der Runner
akzeptiert nur `aidev/…`-Branches mit gültigem Namen, nie den Haupt-Branch (sonst wird die ganze Anfrage abgelehnt).
Vorhandene Branches ermittelt er per `ls-remote` (fehlende → `missing`); weicht der Stand von `expect` ab, bleibt der
Branch stehen (`kept`, `changed`). Danach fragt er alle offenen PRs live über gh ab (paginiert bis 1000, sonst Abbruch):
Head-Branches aus demselben Repository und Basis-Branches offener PRs bleiben stehen (`kept`, `open-pr`), Fork-Heads
zählen nicht. Den Rest löscht er mit einem Push (`--delete` mit `--force-with-lease` auf den gelesenen Stand). Schlägt
dieser fehl, versucht er jeden Branch einzeln (→ `failed` mit gekürzter, bereinigter Meldung). Danach löscht er im Cache die lokalen Branches und
`refs/remotes/origin/<b>`. Worktrees laufender Läufe bleiben unangetastet, andere Worktrees mit dem Branch werden auf
„detached“ gestellt.

Beim Beenden (`SIGTERM`/`SIGINT`) nimmt der Runner keine neuen Läufe an, bricht laufende ab und meldet sie als
`cancelled`; Worktrees bleiben erhalten. Mit `DRAIN_SEC` dürfen sie vorher noch fertig werden (siehe unten).

### Neustart während laufender Aufträge

Ein Neustart ist jederzeit möglich, kein Auftrag geht verloren:

| Art des Beendens | Was mit laufenden Läufen passiert | Versuch zählt? |
|---|---|---|
| geordnet, `DRAIN_SEC=0` (Standard) | sofort abgebrochen, als `cancelled` gemeldet, Atrium plant sie neu ein; bekommt der Auftrag dasselbe Konto wieder, setzt der Agent seine Sitzung fort | nein |
| geordnet, `DRAIN_SEC>0` | der Runner meldet `draining` (Atrium zeigt „Wird beendet“ und bietet ihm nichts Neues an) und wartet bis zu `DRAIN_SEC` Sekunden, bis die Läufe fertig sind (inkl. Commit, Push, PR); danach Rest wie oben | nein |
| hart (`kill -9`, Absturz, Stromausfall) | beim nächsten Start meldet der Runner seine (leeren) Läufe bei der Anmeldung (`runIds`); Atrium gibt die verwaisten sofort frei und plant sie neu ein | nein (Verbindungsverlust; nach 20 in Folge `failed`) |
| Runner kommt nicht wieder | nach Ablauf der Lease (Server 90 s, PC-Runner 60 s, je Runner einstellbar) gibt der Scheduler-Job die Läufe frei und plant sie neu ein | nein (Verbindungsverlust; nach 20 in Folge `failed`) |
| PC-Runner: Standby, Herunterfahren, `handover` | geordnete Übergabe mit Zwischenstand (WIP-Ref), siehe [PC-Runner](#vorrang-und-übergabe) | nein |

Der Heartbeat (alle 15 s) bleibt sicher unter der Lease: je Versuch höchstens 20 s für Antwortkopf und -körper,
höchstens zwei Versuche und dazwischen höchstens 10 s Wartezeit (auch bei `retry-after`). Ein hängender Antwortkörper
blockiert die Heartbeat-Schleife damit nicht mehr.

Signale: Das erste `SIGTERM`/`SIGINT` startet das geordnete Beenden, ein zweites bricht die Wartefrist ab
(laufende Läufe werden abgebrochen und neu eingeplant), ein drittes beendet sofort. Bei Docker muss
`stop_grace_period` größer als `DRAIN_SEC` plus etwa 30 s sein, sonst beendet Docker den Runner hart.

## PC-Runner (Windows, macOS, Linux)

Ein Runner kann auch auf deinem eigenen PC laufen – als fertiges Programm aus den
[GitHub Releases](https://github.com/CrayonGamerHD-Philipp/atrium-ai-development-module/releases?q=runner-v), ohne Node
und ohne Docker (Docker bleibt möglich). Solange der PC läuft, bekommt er Aufträge **zuerst**; geht er in den Standby,
wird er heruntergefahren oder verliert er die Verbindung, übernimmt ein Server-Runner die laufenden und wartenden
Aufträge – ohne Datenverlust und ohne dass der Versuch zählt.

Nicht enthalten sind die Agent-CLIs (`claude`, `codex`, `gemini`), `git` und `gh`. `atrium-runner probe` prüft sie und
nennt fehlende Programme mit Installationshinweis.

### Installation je Betriebssystem

| System | Download | Installation |
|---|---|---|
| Windows 10/11 (x64, arm64) | `atrium-runner-<v>-windows-x64-setup.exe` (oder `.zip`) | Installer ausführen (pro Benutzer, keine Administratorrechte). Er legt das Programm nach `%LOCALAPPDATA%\Programs\AtriumRunner`, ergänzt den `PATH`, legt die Konfigurationsvorlage `%APPDATA%\AtriumRunner\runner.config.json` an und richtet den Autostart ein (Aufgabe „AtriumRunner“ bei Anmeldung, ohne Berechtigung über `HKCU\…\Run`). Startmenü: Status, „Jetzt an Server übergeben“, Pausieren, Fortsetzen, Konfiguration. |
| macOS (Apple Silicon, Intel) | `atrium-runner-<v>-macos-arm64.pkg` bzw. `-macos-x64.pkg` (oder `.tar.gz`) | `.pkg` öffnen: Programm nach `/usr/local/lib/atrium-runner`, Befehl `/usr/local/bin/atrium-runner`, LaunchAgent `~/Library/LaunchAgents/de.kalypzo.atrium-runner.plist` (ohne Start). Konfiguration: `~/Library/Application Support/AtriumRunner/runner.config.json`, Logs: `~/Library/Logs/AtriumRunner/runner.log`. |
| Linux (x64, arm64, systemd) | `atrium-runner-<v>-linux-x64.tar.gz` (oder `.deb`) | `tar xzf …tar.gz && ./atrium-runner-<v>-linux-x64/install.sh` (als normaler Benutzer): Programm nach `~/.local/lib/atrium-runner`, Befehl `~/.local/bin/atrium-runner`, systemd-User-Unit `~/.config/systemd/user/atrium-runner.service`. Konfiguration: `~/.config/atrium-runner/runner.config.json`, Daten: `~/.local/share/atrium-runner/`. Das `.deb` installiert nach `/opt/atrium-runner`; den Autostart richtet danach jeder Benutzer mit `atrium-runner install` ein. Damit der Runner auch ohne Anmeldung läuft: `loginctl enable-linger`. |

Danach:

1. In der Konfiguration `atriumUrl` und `apiKey` eintragen (technischer Benutzer, siehe Schritt 1) und die Konten
   anpassen. Die Datei hat die Rechte `0600`; der API-Key verlässt den PC nie in Richtung der Agents.
2. Bei den CLIs anmelden: `atrium-runner login <konto>` (wie beim Server-Runner).
3. `atrium-runner probe` – prüft Konfiguration, git, gh, CLIs und Logins.
4. `atrium-runner service-start` (bzw. `atrium-runner install`, falls der Autostart noch fehlt).
5. In Atrium unter **Administration → Runner & Konten** freigeben. Der Runner erscheint als **PC-Runner** mit Vorrang 10.

### Befehle

| Befehl | Wirkung |
|---|---|
| `atrium-runner install [--no-start]` | Konfigurationsvorlage anlegen (falls fehlend), Autostart einrichten, starten |
| `atrium-runner uninstall [--purge]` | geordnet beenden, Autostart entfernen; `--purge` löscht auch Konfiguration und Arbeitsverzeichnis |
| `atrium-runner service-start` / `stop` / `restart` | über den Autostart starten, geordnet beenden (Übergabe laufender Läufe), neu starten |
| `atrium-runner status` | Autostart, Prozess, Zustand in Atrium, Übergabe, Läufe, letzter Heartbeat, Energie-Überwachung |
| `atrium-runner handover` | laufende Läufe **jetzt** an einen Server-Runner übergeben, danach normal weiter |
| `atrium-runner pause` / `resume` | übergeben und keine neuen Aufträge annehmen bzw. wieder annehmen |
| `atrium-runner login <konto>`, `probe`, `start`, `init` | wie beim Server-Runner; `start` läuft im Vordergrund, `init` legt nur die Vorlage an |

`stop`, `handover` und `pause` wirken über Steuerdateien im Arbeitsverzeichnis (`<WORK_DIR>/control/`) auf den laufenden
Runner – plattformunabhängig, auch unter Windows. Ein Tray-Icon gibt es (noch) nicht; unter Windows decken die
Startmenü-Einträge dieselben Aktionen ab.

PC-spezifische Einstellungen (Datei bzw. Umgebung):

| Variable / Feld | Bedeutung | Standard |
|---|---|---|
| `RUNNER_KIND` / `kind` | `server` oder `desktop` | `server` (Vorlage des PC-Runners: `desktop`) |
| `HANDOVER_SEC` / `handoverSec` | Zeitbudget einer Übergabe (3–300 s); das Betriebssystem begrenzt ggf. weiter | `20` |
| `WIP_CHECKPOINT_MIN` / `wipCheckpointMin` | Zwischenstände laufender Läufe alle n Minuten sichern (0 = aus) | desktop `10`, server `0` |
| `POWER_EVENTS` / `powerEvents` | Standby/Herunterfahren beobachten | an für `desktop` |

### Vorrang und Übergabe

- **Vorrang**: Der Scheduler bietet einen Auftrag zuerst den Konten der höchsten Vorrangstufe an, die ihn übernehmen
  können (Rolle, Anbieter-Wunsch, Limits, freie Slots wie bisher). PC-Runner haben automatisch Vorrang 10,
  Server-Runner 0; unter **Runner & Konten → Bearbeiten** lassen sich Art, Vorrang und Heartbeat-Zeitlimit festlegen.
  Innerhalb einer Stufe entscheidet die bisherige Punktzahl (Auslastung, Sitzung, bevorzugter Runner des Projekts).
- **Kein Hin- und Herspringen**: Kommt der PC zurück, bekommt er nur **neue** Aufträge; laufende Server-Läufe bleiben, wo
  sie sind. Ein Runner/Konto, auf dem ein Auftrag die Verbindung verloren hat, fällt für diesen Auftrag hinter alle
  anderen zurück (bleibt aber Ausweg).
- **Anderes Konto/Anbieter**: Die Übergabe darf auf einem anderen Konto oder Anbieter landen; Rollen-Vorlieben,
  `providerHint` und Limits gelten unverändert. Die Agent-Sitzung wird nur bei gleichem Konto fortgesetzt, sonst
  beginnt der neue Agent mit dem Zwischenstand und einem Hinweis im Auftragstext („Continuation after handoff“).

**Geordnete Übergabe** (Standby, Herunterfahren, Abmelden, `handover`/`pause`), so kurz wie möglich:

1. Heartbeat mit `handover` – Atrium zeigt „Wird übergeben“ und bietet nichts Neues an.
2. Agents stoppen.
3. Zwischenstand als **WIP-Commit auf dem eigenen Ref `refs/aidev/wip/<runId>`** pushen (falls in der Frist machbar).
   Der Commit entsteht über einen temporären Index (Worktree, Index und Branch bleiben unberührt) und enthält auch
   lokale, noch nicht gepushte Commits. Ein Ref außerhalb von `refs/heads/` ist kein Branch: Er erscheint in keinem PR,
   nicht im Haupt-Branch und löst keine Branch-CI aus.
4. Läufe als übergeben melden (`finish` mit `status: cancelled` und `handoff`). Atrium plant sofort neu ein – der
   Versuch zählt nicht –, und der Verlauf zeigt „Übergeben von PC-Runner X an Server-Runner Y (Grund: Standby)“.

Der übernehmende Runner holt den WIP-Ref, prüft, dass er genau der gemeldete Commit ist und den aktuellen Stand von
`origin/<branch>` enthält (sonst ist er veraltet und wird ignoriert), und stellt ihn als **nicht committete Änderungen**
wieder her. Ausgeliefert wird wie immer ein normaler Commit; nach Erfolg löscht der Runner den verbrauchten WIP-Ref.

| System | Ereignis | Zeit, die das System lässt |
|---|---|---|
| Linux | logind `PrepareForSleep`/`PrepareForShutdown` über D-Bus (`gdbus`, sonst `dbus-monitor`) mit Delay-Inhibitor (`systemd-inhibit --mode=delay`); `SIGTERM` beim Herunterfahren | `InhibitDelayMaxSec` in `/etc/systemd/logind.conf` (Standard 5 s; empfohlen `InhibitDelayMaxSec=30`) |
| Windows | verstecktes Fenster (PowerShell-Hilfsprozess, C# ohne native Abhängigkeit): `WM_POWERBROADCAST`/`PBT_APMSUSPEND`, `WM_QUERYENDSESSION`/`WM_ENDSESSION` mit `ShutdownBlockReasonCreate` | Standby ca. 2 s, Herunterfahren bis 15 s (Windows zeigt „Atrium-Runner übergibt laufende Aufträge“) |
| macOS | JXA-Hilfsprozess: `NSWorkspaceWillSleepNotification`, `…WillPowerOffNotification`, `…DidWakeNotification`; `SIGTERM` von launchd (`ExitTimeOut` 30 s) | wenige Sekunden (macOS wartet nicht auf die Benachrichtigung) |
| alle | Zeitsprung der Wanduhr (Prozess war eingefroren) → Aufwachen erkannt, auch ohne Ereignis | – |

Reicht die Zeit nicht für den Push, wird ohne Zwischenstand übergeben; dann zählt der letzte gepushte Stand bzw. der
letzte Checkpoint.

**Ungeordneter Ausfall** (Strom weg, Absturz, WLAN weg, Standby ohne Ereignis): Atrium erkennt ihn am Heartbeat-Zeitlimit
(Lease; PC-Runner **60 s**, Server-Runner 90 s, je Runner einstellbar 30–900 s) und plant den Lauf als
Verbindungsverlust neu ein – ab dem letzten gepushten Stand bzw. dem letzten **Checkpoint**: Während langer Läufe
sichert der PC-Runner alle `WIP_CHECKPOINT_MIN` Minuten einen WIP-Commit auf seinen Ref und meldet ihn
(`POST /runner/runs/:id/checkpoint`).

### Keine doppelte Ausführung (Fencing)

Jedes Angebot erhöht das **Fencing-Token** des Auftrags (`task.lease_epoch` → `offer.fence`). Der Runner sendet es bei
Ereignissen, Checkpoints und Abschluss mit; Atrium lehnt Meldungen zu einem übernommenen Lauf oder mit veraltetem Token mit
**409** ab. Vor **jedem Push** (Auslieferung und Checkpoint) prüft der Runner seine Lease (`POST /runner/leases`); ist sie
ungültig oder Atrium nicht erreichbar, pusht er nicht. Wacht der PC auf, prüft er zuerst alle Leases: übernommene Läufe
verwirft er (Agent stoppen, nichts pushen, nichts melden), meldet sich neu an und nimmt danach wieder neue Aufträge an.
Die Worktrees verworfener Läufe räumt das normale Aufräumen später weg. WIP-Refs sind je Lauf getrennt – ein
aufgewachter PC kann den Zwischenstand des Server-Runners also nicht überschreiben.

### Sicherheit ohne Docker

Die Agents laufen ohne Rückfragen. Im Container begrenzen Benutzer, Capabilities und Netz, was sie anrichten können –
auf dem PC laufen sie mit **deinen** Rechten: Sie könnten Dateien außerhalb des Worktrees lesen oder ändern (SSH-Keys,
Browser-Profile, andere Projekte) und alles erreichen, was dein Benutzer im Netz erreicht. Umgesetzt ist eine
vertretbare Grundlinie:

- kein Root bzw. keine Installation mit Administratorrechten (Installer pro Benutzer, `install`/`start` verweigern root),
- eigenes Arbeitsverzeichnis je Runner (Repos, Worktrees), Konfiguration mit Rechten `0600`, API-Key nie an Agents,
  Terminals oder Projektbefehle,
- Zugangsdaten bleiben auf dem PC, Ausgaben werden bereinigt, `systemd`: `NoNewPrivileges=true`,
- fine-grained GitHub-Token nur für die gewählten Repos, Branch-Protection auf dem Haupt-Branch.

**Empfohlener Betrieb** (abgestuft):

1. **Eigenes Benutzerkonto nur für den Runner** (Standardempfehlung) – trennt die Agents von deinen persönlichen
   Daten, ohne Docker. Das Konto bekommt eigene CLI-Logins und ein eigenes fine-grained `gh`-Token, keine
   Administratorrechte und keinen Zugriff auf dein Home-Verzeichnis.
2. **Docker Desktop** bzw. Podman mit dem bestehenden Image – volle Isolation wie auf dem Server
   (siehe [Starten](#4-starten)).
3. Zusätzlich möglich: Firewall-Regeln nur für GitHub, Atrium und die KI-Anbieter.

**Prüfung im Runner:** Läuft ein PC-Runner unter einem Konto mit persönlichen Daten, warnen `probe`, `install` und der
Start. Geprüft wird nur, ob typische Pfade existieren (Inhalte werden nie gelesen): private SSH-Schlüssel
(`~/.ssh/id_*`), Cloud-Zugangsdaten (AWS, Azure, Google Cloud, Kubernetes), GnuPG, Docker-/npm-Anmeldung und
Browser-Profile. Was der Runner selbst braucht (gh- und CLI-Logins), zählt nicht. Der Hinweis ist eine Warnung; der
Runner startet trotzdem. Der Windows-Installer zeigt dieselbe Empfehlung vor der Installation.

**Eigenes Konto einrichten:**

| System | Schritte |
|---|---|
| Windows | Einstellungen → Konten → Andere Benutzer → „Konto hinzufügen“ → lokales Konto (Standardbenutzer) `atrium-runner`. Als dieses Konto anmelden, git/gh/CLIs installieren (falls nur für den eigenen Benutzer), Installer ausführen, `gh auth login` und `atrium-runner login <konto>`. Der Autostart greift bei der Anmeldung dieses Kontos; per „Benutzer wechseln“ bleibt es angemeldet, während du mit deinem Konto arbeitest. |
| macOS | Systemeinstellungen → Benutzer & Gruppen → Benutzer hinzufügen (Standard) `atrium-runner`. Das `.pkg` installiert systemweit; als `atrium-runner` anmelden (schneller Benutzerwechsel), dort `atrium-runner install`, `gh auth login`, `atrium-runner login <konto>`. |
| Linux | `sudo useradd -m -s /bin/bash atrium-runner && sudo loginctl enable-linger atrium-runner`, dann `sudo -iu atrium-runner` und dort `install.sh`, `gh auth login`, `atrium-runner login <konto>`. Mit Linger läuft der Runner ohne Anmeldung; Standby/Herunterfahren erkennt er weiterhin über logind. |

Das Home-Verzeichnis deines persönlichen Kontos sollte für andere Benutzer nicht lesbar sein (Linux: `chmod 700 ~`;
Windows und macOS sind so voreingestellt).

### Manuelle Tests je Betriebssystem

Vorbereitung: ein Server-Runner (Docker) und ein PC-Runner, beide freigegeben, ein Testprojekt mit einem Auftrag, der
einige Minuten dauert.

| Schritt | Windows | macOS | Linux |
|---|---|---|---|
| Installation | Setup ausführen, `atrium-runner status` in neuer Konsole | `.pkg` installieren, `atrium-runner status` | `install.sh`, `systemctl --user status atrium-runner` |
| Erscheint als „pending“, Freigabe | Runner & Konten | dito | dito |
| Vorrang | neuer Auftrag läuft auf dem PC | dito | dito |
| Standby | Start → Energie → Energie sparen | Apple-Menü → Ruhezustand | `systemctl suspend` |
| Erwartung | Runner-Seite „Wird übergeben“ bzw. „Standby“; Auftrag läuft auf dem Server weiter, Verlauf „Übergeben von PC-Runner … (Grund: Standby)“; `git ls-remote origin 'refs/aidev/wip/*'` zeigt den WIP-Ref; PR wird **einmal** erstellt, kein WIP-Commit im PR | dito | dito |
| Aufwachen | PC aufwecken: Runner „Zurück“, kein zweiter Push/PR (Log: „Lauf … wurde übernommen und wird verworfen“), neue Aufträge gehen wieder an den PC | dito | dito |
| Herunterfahren | Herunterfahren mit laufendem Auftrag (kurz „Atrium-Runner übergibt …“) | Ausschalten | `systemctl poweroff` |
| Harter Ausfall | Netzwerk trennen bzw. Stecker ziehen: nach ≤ 60 s übernimmt der Server ab dem letzten Checkpoint | dito | dito |
| Deinstallation | Apps → Atrium Runner → Deinstallieren (Autostart weg) | `atrium-runner uninstall`, dann `/usr/local/lib/atrium-runner` löschen | `atrium-runner uninstall`, `rm -r ~/.local/lib/atrium-runner` |

### Release erstellen

1. Version in `runner/package.json` **und** `modules/aidev/runner-release.ts` erhöhen (ein Test prüft die Gleichheit;
   `runner-release.ts` steuert den Hinweis „Update verfügbar“ auf der Runner-Seite).
2. Commit auf `main`, dann Tag setzen und pushen: `git tag runner-v0.5.0 && git push origin runner-v0.5.0`.
   Tags mit `-beta`/`-rc` (z. B. `runner-v0.5.0-rc.1`) werden als Pre-Release veröffentlicht.
3. `.github/workflows/release-runner.yml` läuft: CI (Lint, Typen, Tests von Modul und Runner) → Versionsprüfung (Tag ↔
   `package.json` ↔ `runner-release.ts`, sonst Abbruch) → Build auf nativen Runnern (Linux x64/arm64, macOS arm64/x64,
   Windows x64, optional arm64) → Smoke-Test (`--version`, `probe` mit `fake`-Provider) → Pakete → GitHub Release mit
   allen Dateien, `SHA256SUMS.txt` und Release Notes aus den Commits seit dem letzten Runner-Tag. Optional veröffentlicht
   derselbe Workflow das Docker-Image `ghcr.io/<owner>/atrium-aidev-runner:<version>` (und `latest` für Releases).
   Manuell: **Actions → Release Runner → Run workflow** (nur Artefakte, oder mit „publish“ als Release).

**Technik:** Node **SEA** (Single Executable Application, `scripts/build-sea.mjs`): Die Node-Laufzeit des Build-Rechners
mit dem gebündelten Runner (CommonJS) als eingebettetem Blob (`postject`). Gewählt, weil der Runner auf genau der
Node-Version läuft, gegen die `node-pty` gebaut wird (gleiche ABI), und weil keine fremde Laufzeit nötig ist (`bun
--compile` unterstützt `node-pty` nicht zuverlässig). `node-pty` wird je Plattform/Architektur auf dem nativen Runner
gebaut und als `node_modules/node-pty` neben das Programm gelegt; der Runner lädt es von dort (`createRequire`).

**Signierung (optional):** Ohne Secrets wird unsigniert gebaut. Repository-Secrets:

| Secret | Zweck |
|---|---|
| `WINDOWS_CERT_PFX_BASE64`, `WINDOWS_CERT_PASSWORD` | Authenticode für `atrium-runner.exe` und den Installer |
| `MACOS_CERT_P12_BASE64`, `MACOS_CERT_PASSWORD`, `MACOS_SIGN_IDENTITY` | Developer ID Application (Hardened Runtime, `packaging/macos/entitlements.plist`) |
| `MACOS_INSTALLER_IDENTITY` | Developer ID Installer für das `.pkg` |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | Notarisierung des `.pkg` (`notarytool`, danach `stapler`) |

Zertifikate landen nur im temporären Verzeichnis bzw. einer temporären Keychain des Build-Rechners und werden danach
gelöscht; die Workflow-Schritte sehen die Werte nur, wo sie sie brauchen.

Unsignierte Builds: **Windows SmartScreen** meldet „Der Computer wurde durch Windows geschützt“ → **Weitere
Informationen → Trotzdem ausführen**. **macOS Gatekeeper** meldet „kann nicht geöffnet werden, da der Entwickler nicht
verifiziert werden kann“ → Rechtsklick auf das `.pkg` → **Öffnen** (bzw. Systemeinstellungen → Datenschutz & Sicherheit →
„Trotzdem öffnen“), beim `.tar.gz`: `xattr -d com.apple.quarantine atrium-runner`. Prüfsummen: `shasum -a 256 -c
SHA256SUMS.txt --ignore-missing`.

**Update-Hinweis:** Der Runner meldet Version und Protokoll bei der Anmeldung. Die Runner-Seite zeigt „Update
verfügbar“, wenn er älter ist als die mit dem Modul ausgelieferte Runner-Version, und „Protokoll veraltet“ bei älterer
Protokollversion. Ein automatisches Selbst-Update gibt es bewusst nicht (erst nach Abstimmung).

## Annahmen zu den CLIs

| CLI | Aufruf | geprüft |
|---|---|---|
| Claude Code 2.1.331 | `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --append-system-prompt-file <datei> [--model m] [--resume id]`, Auftrag über stdin | mit `--help` und echtem Lauf (Windows) |
| Codex 0.164 | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check [-m m] [-c model_reasoning_effort=…] -C <cwd> -`; Fortsetzen `codex exec resume … <thread_id> -` (ohne `-C`, cwd des Prozesses) | mit `--help`, echtem Lauf und Fortsetzung |
| Gemini CLI | `gemini -p <Hinweis> --output-format stream-json --yolo [-m m]`, Auftrag über stdin | **nur nach öffentlicher Doku** (nicht installiert); Parser defensiv |
| OpenAI-kompatibel | Codex mit `-c model_provider=…`, `model_providers.<k>.base_url/env_key/wire_api` | Schlüssel im Codex-Binary gefunden; nicht gegen eine echte API getestet |

- Bei Codex und Gemini wird die Systemanweisung dem Auftrag vorangestellt (`<system_instructions>…`), weil mehrzeilige
  `-c`-Werte über die Kommandozeile (Windows-Shims) nicht zuverlässig sind. Beim Fortsetzen (Codex) entfällt sie.
- Codex 0.164 lehnt `wire_api = "chat"` ab („no longer supported“); Standard ist daher `responses`. Für APIs, die nur
  Chat Completions können, ist ein Proxy (z. B. LiteLLM) nötig.
- Gemini: Fortsetzen von Sitzungen wird nicht genutzt; `GEMINI_CLI_HOME` als Konto-Verzeichnis ist eine Annahme
  (Login-Datei `<home>/.gemini/oauth_creds.json`), alternativ `GEMINI_API_KEY` in `env`.
- Login-Status: Claude über `claude auth status --json` (Rückfall: Anmeldedaten im Config-Verzeichnis), Codex über
  `codex login status` (Rückfall: `auth.json`), Gemini über die OAuth-Datei bzw. `GEMINI_API_KEY`/`GOOGLE_API_KEY`,
  `openai-api` über die Variable aus `apiKeyEnv`.
- Verbrauch: Claude aus dem `result`-Ereignis (inkl. Kosten); Codex summiert `turn.completed.usage`
  (`inputTokens` ohne die gecachten Tokens, diese als `cacheReadTokens`); Gemini aus `result.stats`.
- Limit-Erkennung: versionierte Muster-Tabelle in `src/providers/limits.ts` (u. a. Claude `rate_limit_event` mit
  `status: rejected`, „usage limit reached“, „5-hour limit“, „weekly limit“, Codex „You've hit your usage limit“,
  Gemini `RESOURCE_EXHAUSTED`, 429). Rücksetzzeit aus Unix-Zeit, ISO, „in 2 hours“, „resets 3pm (Zeitzone)“.

## Limit-Stand

Der Runner meldet je Konto den zuletzt beobachteten Limit-Stand im Heartbeat (`accounts[].limits`, Fähigkeit
`limitReport`), sofern er sich geändert hat oder jünger als 30 Minuten ist. Bei einem Limit-Treffer gehen die bekannten
Fenster zusätzlich mit `/limit` an Atrium. Quellen (Abbildung in `src/providers/limit-snapshot.ts`):

- **Claude, Run-Stream**: jedes `rate_limit_event` (auch `allowed`): `five_hour` → `5h`, `seven_day` → `week`,
  `seven_day_opus` → `week-opus`, `seven_day_sonnet` → `week-sonnet`, sonst `other`; `utilization` (0–1) → Prozent,
  `resetsAt` (Sekunden/Millisekunden) → ISO, ergänzend `unifiedWindows`.
- **Claude, aktive Abfrage** (nur ohne frischen Stand aus einem Lauf): `GET https://api.anthropic.com/api/oauth/usage`
  mit dem OAuth-Token des Kontos (`CLAUDE_CODE_OAUTH_TOKEN` bzw. `<CLAUDE_CONFIG_DIR>/.credentials.json`). Der Endpunkt
  ist **undokumentiert** und kann sich ändern. Das Token wird nur lokal gelesen, nie erneuert, nie protokolliert und nie
  an Atrium gesendet; abgelaufene Tokens werden übersprungen. Zeitlimit 10 s, Konten nacheinander, nach Fehlern
  wachsender Abstand (bei 401/403/429 60 min). Abschalten mit `LIMIT_PROBE=false` bzw. `limitProbe: false`.
- **Codex**: `rate_limits.primary/secondary` (`used_percent`, `window_minutes` ≈300 → `5h`, ≈10080 → `week`,
  `resets_in_seconds`/`resets_at`) aus dem `--json`-Stream, falls vorhanden, sonst nach dem Lauf aus der Sitzungsdatei
  `<CODEX_HOME>/sessions/JJJJ/MM/TT/rollout-…-<thread_id>.jsonl` (letztes `token_count`).
- **Fehlermeldungen**: Ohne Stand aus dem Stream wird ein erkannter 5-Stunden- bzw. Wochen-Treffer als gesperrtes
  Fenster (`source: error`) übernommen.

Unterstützte Anbieter:

| Anbieter | Lauf (`source: stream`) | Aktive Abfrage (`source: probe`) | Fehlermeldung (`source: error`) |
|---|---|---|---|
| `claude` | ja | ja, nur mit OAuth-Login (Abo), nicht mit reinem `ANTHROPIC_API_KEY` | ja |
| `codex` | ja, nur mit ChatGPT-Login (Stream bzw. Sitzungsdatei) | nein | ja |
| `gemini`, `openai-api` | nein | nein | ja |
| `fake` | ja (5h-Stand für Demo und Tests) | nein | – |

Ohne gemeldeten Stand rechnet Atrium für das Konto nur mit der eigenen Schätzung über die Budgets. Die Auswertung in
Atrium beschreibt die [Limit-Analyse](../README.md#limit-analyse).

Konfiguration der aktiven Abfrage (siehe auch die Tabellen unter [Konfiguration](#2-konfiguration)):

| Option | Bedeutung | Standard |
|---|---|---|
| `LIMIT_PROBE` / Datei `limitProbe` | für alle Konten an oder aus (`true`/`false`, in der Umgebung auch `1`/`0`) | an für Claude-Konten mit OAuth-Login, sonst aus |
| `LIMIT_PROBE_MIN` / Datei `limitProbeMin` | Abstand in Minuten (1–1440) | `5` |
| `accounts[].limitProbe` | Schalter je Konto, hat Vorrang | – |

Der OAuth-Endpunkt ist nicht offiziell dokumentiert. Prüfe vor dem Einsatz die Nutzungsbedingungen deines Abos; wer
ihn nicht nutzen will, setzt `LIMIT_PROBE=false`. Die Stände aus den Läufen kommen trotzdem weiter an.

**Datenschutz**: An Atrium gehen je Konto nur Fenster (`window`, `label`), Auslastung in Prozent, Rücksetzzeit, Status
(`allowed`, `warning`, `rejected`, `unknown`), Quelle und Beobachtungszeit. OAuth-Tokens, Logins und der übrige Inhalt
der Codex-Sitzungsdateien bleiben auf dem Runner. Die aktive Abfrage spricht nur `api.anthropic.com` an.

## Sicherheit

- **Agents laufen ohne Rückfragen** (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`,
  `--yolo`). Auf Servern den Runner deshalb **im Container** betreiben: Benutzer ohne Root (UID 10002), `cap_drop: ALL`,
  `no-new-privileges`, eigenes Netz, optional Egress-Allowlist (nur GitHub, Atrium, KI-Anbieter). Niemals auf dem
  Atrium-Host. Auf dem eigenen PC ohne Docker: siehe [Sicherheit ohne Docker](#sicherheit-ohne-docker).
- **Übergabe/Fencing**: WIP-Zwischenstände liegen nur unter `refs/aidev/wip/<runId>` (kein Branch, kein PR). Vor jedem
  Push prüft der Runner seine Lease; Meldungen mit veraltetem Fencing-Token lehnt Atrium ab.
- **GitHub**: fine-grained Personal Access Token **nur für die gewählten Repos** (Contents, Pull requests, ggf.
  Workflows: Read & write). Auf dem Haupt-Branch **Branch-Protection** aktivieren (Reviews/Checks), dann kann auch ein
  fehlerhafter Agent nichts direkt zerstören. Force-Pushes macht der Runner nur `--force-with-lease` auf eigene
  `aidev/`-Branches.
- **Bestehende PRs bearbeiten (`pr-update`)**: Das Token braucht Schreibrechte auf die Head-Branches der PRs
  (fine-grained PAT: **Contents: Read & write**) und **Pull requests: Read & write**, um den PR-Kontext zu lesen und
  die Zusammenfassung als Kommentar zu posten. `gh` muss im Runner verfügbar und angemeldet sein (`GH_TOKEN` oder
  `gh auth login`). Bei `pr-update` pusht der Runner nie mit Force, auch nicht auf `aidev/`-Branches. Liegen die
  Branches unter Branch-Protection, muss das Token dort pushen dürfen.
- **Zugangsdaten bleiben auf dem Runner**: CLI-Logins, gh-Token und API-Keys werden nie an Atrium übertragen. Der
  API-Key des Runners wird nicht an Agents, Projektbefehle oder Terminals weitergegeben.
- **Limit-Abfrage**: Das OAuth-Token eines Claude-Kontos wird nur lokal gelesen (`CLAUDE_CODE_OAUTH_TOKEN` bzw.
  `<CLAUDE_CONFIG_DIR>/.credentials.json`), nie erneuert, nie protokolliert und nie an Atrium gesendet. Im Heartbeat
  stehen nur die Limit-Werte (siehe [Limit-Stand](#limit-stand)). Abschalten mit `LIMIT_PROBE=false`.
- **Bereinigung**: Alle hochgeladenen Texte (Ereignisse, Fehlermeldungen, Diffs, Terminal-Ausgabe) werden von Tokens
  befreit (`ghp_`, `gho_`, `github_pat_`, `sk-`, `sk-ant-`, `AIza…`, `xox…`, `Bearer …`, AWS-Keys, Zugangsdaten in
  URLs, der eigene API-Key und alle Werte aus `env`/`apiKeyEnv`) → `[entfernt]`. Ausnahme: Dateiinhalte für den Editor
  (`fs.read`) werden unverändert übertragen, sonst würde Speichern die Datei verändern.
- **Pfad-Jail** für Editor-RPCs: nur innerhalb des Worktrees bzw. der Arbeitskopie (`realpath`), keine absoluten Pfade,
  kein `..`, keine Symlinks nach außen, kein Schreiben in `.git`.
- Externe Empfänger der Daten: GitHub (Code, PRs) und der jeweilige KI-Anbieter (Auftrag, Code-Ausschnitte).

## Entwicklung

```sh
npm install
npm run check   # tsc --noEmit
npm test        # vitest: SSE, Batcher, Redaction, Pfad-Jail, Limits, Parser, Plan, Git-Ablauf, Runner, Übergabe/Fencing, PC-Betrieb
npm run build   # esbuild → dist/main.js (bündelt protocol.ts, zod, cross-spawn; node-pty bleibt extern)
npm run build:sea   # Einzel-Binary für diese Plattform → release/atrium-runner-<v>-<os>-<arch>/ (Node SEA)
node dist/main.js --help
```

Die Git-Tests nutzen ein lokales Bare-Remote, den `fake`-Adapter und einen gh-Shim (`test/fixtures/gh-shim`).
`scripts/smoke-real.ts` ist ein manueller Rauchtest gegen die echten CLIs (`npx tsx scripts/smoke-real.ts claude`).
