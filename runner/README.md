# Atrium aidev-Runner

Der Runner führt die Agent-Läufe des Atrium-Moduls **KI-Entwicklung** (`aidev`) aus. Atrium ist die Steuerzentrale;
der Runner läuft getrennt davon (Docker-Container auf einem Server oder nativ auf dem
[eigenen PC](#runner-auf-dem-eigenen-pc)), verbindet sich **ausgehend** mit Atrium und braucht keine offenen Ports.

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
| `RUNNER_MODE` | `server` oder `desktop` (Runner auf dem eigenen PC, Datei: `mode`), siehe [PC-Runner](#runner-auf-dem-eigenen-pc) | `server` |
| `HANDOFF_SEC` | Frist für die Übergabe laufender Läufe im Modus desktop (1–60, Datei: `handoffSec`) | `8` |
| `POWER_EVENTS` | Standby, Aufwachen und Herunterfahren beobachten (`true`/`false`, Datei: `powerEvents`) | an im Modus desktop |

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

Lokal ohne Docker (nur zur Entwicklung, siehe Sicherheit): `npm install && npm run build && npm start`
bzw. `npm run dev`.

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
   `none`. Konflikte → `conflict` mit Dateiliste.

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
| hart (`kill -9`, Absturz, Stromausfall) | beim nächsten Start meldet der Runner seine (leeren) Läufe bei der Anmeldung (`runIds`); Atrium gibt die verwaisten sofort frei und plant sie neu ein | ja |
| Runner kommt nicht wieder | nach Ablauf der Lease (90 s, PC-Runner 45 s) gibt der Scheduler-Job die Läufe frei | ja (PC-Runner: nein) |
| Standby (PC, `RUNNER_MODE=desktop`) | `draining`, Abbruch, WIP-Commit mit Push und `cancelled` mit `handoff` innerhalb von `HANDOFF_SEC`; Atrium plant sofort neu ein, ein Server-Runner setzt auf demselben Branch fort. Nach dem Aufwachen bleibt die Auslieferung bis nach Neuanmeldung und Heartbeat gesperrt, übernommene Läufe enden ohne Push | nein |
| Herunterfahren (PC) | wie Standby, statt `DRAIN_SEC` abzuwarten; danach beendet sich der Runner | nein |

Signale: Das erste `SIGTERM`/`SIGINT` startet das geordnete Beenden, ein zweites bricht die Wartefrist ab
(laufende Läufe werden abgebrochen und neu eingeplant), ein drittes beendet sofort. Bei Docker muss
`stop_grace_period` größer als `DRAIN_SEC` plus etwa 30 s sein, sonst beendet Docker den Runner hart.

## Runner auf dem eigenen PC

Ein Runner kann zusätzlich auf dem eigenen PC laufen (Linux, Windows, macOS). Er meldet sich als `kind: desktop` an
und bekommt Aufträge **vor** den Server-Runnern; das entlastet den Server. Geht der PC in den Standby oder wird er
heruntergefahren, übergibt er laufende Läufe, und ein Server-Runner setzt auf demselben Branch fort. Aufträge laufen
so auch weiter, wenn der PC aus ist.

**Voraussetzungen**

- Node.js ab 24, npm, git, GitHub CLI (`gh`, angemeldet oder `GH_TOKEN`) und die gewünschten Agent-CLIs.
- Der Runner läuft **nativ** im Benutzerkonto, nicht in Docker: Nur so erreicht er die Energieverwaltung des
  Betriebssystems (logind, Fenstermeldungen, NSWorkspace) und kann den Standby kurz aufschieben. Docker Desktop läuft
  unter Windows und macOS in einer VM, die vom Standby nichts mitbekommt. Folge: keine Container-Isolation, Agents und
  Projektbefehle haben die Rechte des Benutzers (siehe [Sicherheit](#sicherheit)).
- **Eigener technischer Benutzer und API-Key je Runner** (Schritt 1), nicht den Key des Servers wiederverwenden. So
  lässt sich der PC-Runner getrennt freigeben, sperren und widerrufen.

**Installation** mit den Skripten unter [`desktop/`](desktop/README.md): Vorlage
[`runner.desktop.example.json`](desktop/runner.desktop.example.json) kopieren (`mode: desktop`, absolute Pfade), dann:

| Plattform | Installation | Autostart | Entfernen |
|---|---|---|---|
| Linux | `desktop/install-linux.sh <config.json> [name]` | systemd-User-Unit `atrium-aidev-runner.service` | `desktop/uninstall-linux.sh` |
| Windows | `desktop/install-windows.ps1 -Config <config.json> [-Name name]` | Aufgabenplanung beim Anmelden | `desktop/uninstall-windows.ps1` |
| macOS | `desktop/install-macos.sh <config.json> [name]` (grafische Sitzung) | LaunchAgent `org.atrium.aidev-runner` | `desktop/uninstall-macos.sh` |

Danach Konten anmelden (`node dist/main.js login <konto> --config <datei>`), prüfen (`… probe --config <datei>`) und
den Runner in Atrium freigeben. Logs und Hinweise je Plattform stehen in [`desktop/README.md`](desktop/README.md).

**Ablauf**

- **Standby**: Der Runner meldet sofort `draining` (keine neuen Angebote) und bricht laufende Läufe ab. Innerhalb von
  `HANDOFF_SEC` committet er bei schreibenden Läufen den Zwischenstand als `wip(aidev): Zwischenstand vor Übergabe`
  (Trailer `Aidev-Task` und `Aidev-Handoff: suspend|shutdown`, ohne Hooks und ohne testCmd), pusht ihn ohne Force auf
  den Arbeits-Branch und meldet `finish` `cancelled` mit `handoff`. Den WIP-Push gibt es nur, wenn Atrium bei der
  Anmeldung `features.handoff` meldet, und nie bei Nur-Lese-Läufen, Fragen, `none`, `pr-update` oder auf dem
  Haupt-Branch. Atrium plant den Auftrag sofort neu ein, ohne den Versuch zu zählen. Der nächste Lauf bekommt denselben
  Branch und im Prompt einen Hinweis auf die Fortsetzung.
- **Herunterfahren** (Ereignis des Systems oder erstes `SIGTERM`/`SIGINT`): Übergabe wie beim Standby, statt mit
  `DRAIN_SEC` zu warten; danach beendet sich der Runner. Das zweite Signal bricht die Übergabe ab, das dritte beendet
  sofort.
- **Aufwachen** (Ereignis oder Uhrsprung): Zuerst sperrt der Runner jede Auslieferung (kein Push). Dann meldet er sich
  neu an (`runIds`) und sendet einen Heartbeat; inzwischen übernommene Läufe kommen als `cancel` zurück und enden ohne
  Push. Erst danach gibt er die Auslieferung frei, nimmt wieder Angebote an und verbindet den Befehlsstrom neu. Ein
  verspäteter Abschluss eines schon übergebenen Laufs ändert in Atrium nichts.
- **Lease**: Für PC-Runner gilt 45 s statt 90 s (`registerResult.leaseSec`; der Heartbeat wird auf höchstens ein
  Drittel davon verkürzt). Läuft sie ab oder meldet sich der PC neu an, zählt der Versuch nicht („PC-Runner nicht
  erreichbar (Standby?) – Lauf wird neu eingeplant“).

**Vorrang**: automatisch PC 10, Server 0; höher bekommt Aufträge zuerst. Unter **Administration → Runner & Konten**
lässt sich der Vorrang je Runner setzen (−100 bis 100, „automatisch“ = nach Art). Je Auftrag wählt der Scheduler die
höchste Stufe mit einem geeigneten Konto, innerhalb der Stufe gilt die bisherige Bewertung. Ein laufender Server-Lauf
wird nicht verdrängt.

**Abos**: Konten gehören zu einem Runner. Ist dasselbe Abo auf PC und Server angemeldet, sind das in Atrium zwei Konten
mit getrennten Budgets und getrennter Schätzung; dass sie dasselbe Kontingent teilen, weiß Atrium nicht. Budgets dann
aufteilen oder das Abo nur auf einem Runner anmelden. Der vom Anbieter gemeldete [Limit-Stand](#limit-stand) zeigt
dagegen für beide denselben Verbrauch.

**Erkennung und Grenzen je Plattform**

| Plattform | Erkennung | Zeit vor dem Standby | Grenzen |
|---|---|---|---|
| Linux (systemd-logind) | Delay-Inhibitor über `systemd-inhibit --mode=delay` (ohne Root), `PrepareForSleep`/`PrepareForShutdown` über `gdbus monitor` (Rückfall `dbus-monitor`); Freigabe nach der Übergabe, nach dem Aufwachen neu geholt | bis `InhibitDelayMaxSec` (Standard 5 s) | kürzer als `HANDOFF_SEC` (8 s); ohne logind nur der Rückfall |
| Windows 10/11 | PowerShell-Kindprozess mit verborgenem Fenster (`WM_POWERBROADCAST`, `WM_QUERYENDSESSION`/`WM_ENDSESSION`); zusätzlich `SIGBREAK`/`SIGHUP` | ca. 2 s | beim Abmelden kann Windows den Prozess vor Ende der Übergabe beenden |
| macOS | `osascript` (JXA) mit `NSWorkspaceWillSleep`/`DidWake`/`WillPowerOff` | nicht aufschiebbar | nur in einer grafischen Sitzung; die Übergabe vor dem Standby ist nicht garantiert, verlässlich ist nur die Bereinigung nach dem Aufwachen |
| alle | Rückfall: Uhrsprung (Timer feuert > 30 s zu spät) gilt als Aufwachen | – | Standby unter 30 s nur über die Plattform erkennbar |

Fehlt ein Werkzeug, schreibt der Runner eine Warnung und erkennt nur noch das Aufwachen über den Uhrsprung. Der Hook vor
dem Standby beschleunigt nur: Reicht die Zeit nicht, wird der Rest nach dem Aufwachen bereinigt. Bei leerem Akku,
Stromausfall oder Netzverlust gibt Atrium die Läufe nach Ablauf der Lease frei; nicht gepushte lokale Änderungen gehen
dann verloren. Bricht der Nutzer ein Herunterfahren ab, hat sich der Runner schon beendet und startet erst mit der
nächsten Anmeldung wieder. Die Erkennung ist bisher nur mit simulierten Prozessen getestet, nicht auf echten PCs.

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
  `--yolo`). Den Server-Runner deshalb **nur im Container** betreiben: Benutzer ohne Root (UID 10002), `cap_drop: ALL`,
  `no-new-privileges`, eigenes Netz, optional Egress-Allowlist (nur GitHub, Atrium, KI-Anbieter). Niemals auf dem
  Atrium-Host.
- **PC-Runner** laufen ohne Container mit den Rechten des Benutzers: Agents und Projektbefehle können auf dessen
  Dateien zugreifen. Nur auf einem vertrauenswürdigen Rechner, mit eigenem API-Key und einem Token mit möglichst
  wenigen Rechten betreiben (siehe [Runner auf dem eigenen PC](#runner-auf-dem-eigenen-pc)).
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
npm test        # vitest: SSE, Batcher, Redaction, Pfad-Jail, Limits, Parser, Plan, Git-Ablauf, Runner
npm run build   # esbuild → dist/main.js (bündelt protocol.ts, zod, cross-spawn; node-pty bleibt extern)
node dist/main.js --help
```

Die Git-Tests nutzen ein lokales Bare-Remote, den `fake`-Adapter und einen gh-Shim (`test/fixtures/gh-shim`).
`scripts/smoke-real.ts` ist ein manueller Rauchtest gegen die echten CLIs (`npx tsx scripts/smoke-real.ts claude`).
