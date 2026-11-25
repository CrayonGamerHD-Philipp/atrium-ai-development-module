# Atrium KI-Entwicklung (`aidev`)

Modul für [Kalypzo Atrium](https://github.com/KalypzoSolutions/kalypzo-atrium): **Vibe-Coding im Browser**. Du legst
Projekte mit GitHub-Repos an und gibst Aufträge – per Chat oder Board. Autonome Coding-Agents setzen sie selbstständig um,
committen, pushen und öffnen Pull Requests. Unterstützt werden:

- **Claude Code**
- **Codex CLI**
- **Gemini CLI**
- **OpenAI-kompatible API**

Ein Scheduler verteilt die Arbeit über mehrere Projekte und Agents gleichzeitig. Er lastet die Abos gleichmäßig aus und
achtet auf das 5-Stunden-Fenster, die Woche und Limits. Die [Limit-Analyse](#limit-analyse) zeigt dazu den echten
Limit-Stand der Anbieter mit Prognose und Budgetvorschlag.

## Aufbau

```
Browser ──REST + SSE──▶ Atrium (Modul aidev: Projekte, Warteschlange, Scheduler, Live-Log, Relay)
                             ▲  SSE-Befehle / JSON-POSTs (API-Key, ausgehend vom Runner)
                             │
                        Runner (runner/: git, gh, claude, codex, gemini, Worktrees, Terminal)
```

- **`modules/aidev/`** ist das Atrium-Modul, die Steuerzentrale. Es enthält Datenbank, Endpunkte, Scheduler (`scheduler.ts`),
  Auftragstexte (`prompts.ts`), Aktionsvorschläge der Agents (`actions.ts`) und die Oberfläche (`pages/`, `ui.ts`). Das
  Protokoll zum Runner steht in `protocol.ts`.
- **`runner/`** ist ein eigenständiger Dienst (Docker), auf dem die Agents mit deinen Abo-Logins laufen. Es können mehrere
  Runner sein, auf Servern oder deinem PC. Einrichtung: [`runner/README.md`](runner/README.md).
- Atrium selbst braucht weder git noch Agent-CLIs. Der Container bleibt gehärtet.

### Projekte anlegen

„Projekt anlegen“ (Recht „Projekte verwalten“) verbindet ein GitHub-Repo. Das Feld versteht `owner/repo`,
`https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git` und Links mit Unterpfad wie `…/tree/<branch>`.

- **Name**: Sobald das Repo-Feld einen gültigen Bezeichner enthält, wird der Repo-Name als Projektname eingetragen. Einen
  selbst geänderten Namen überschreibt der Dialog nicht mehr. Wird das Feld geleert, füllt er es wieder automatisch.
- **Repo-Prüfung**: Kurz nach der letzten Änderung fragt Atrium einen Runner (`POST /projects/probe`). Unter dem Feld steht
  das Ergebnis: Zugriff ok, nur lesen, nicht erreichbar oder „Kein Runner erreichbar“. Ist das Repo schon als Projekt
  angelegt, verlinkt der Dialog darauf. Die Prüfung blockiert das Anlegen nie.
- **Haupt-Branch**: Der Standard-Branch des Repos wird übernommen (bei einem `/tree/<branch>`-Link dieser Branch), solange
  du das Feld nicht selbst geändert hast. Alle Branches stehen als Vorschläge zur Auswahl. Freie Eingabe bleibt möglich.
  In den Projekteinstellungen erscheinen die Vorschläge nach „Repo prüfen“.

### Projekte finden

Die Projektübersicht (Startseite des Moduls) ist auch bei vielen Projekten schnell durchsuchbar:

- **Suche**: durchsucht Projektname, `owner/repo`, Standard-Branch und Commit-Policy, unabhängig von Groß-/Kleinschreibung
  und Umlauten. Bei mehreren Wörtern müssen alle vorkommen. Treffer werden hervorgehoben, „x von y Projekten“ zeigt die
  Trefferzahl.
- **Tastenkürzel**: `/` oder `Strg`/`⌘`+`K` fokussiert die Suche, `Esc` leert sie, `Enter` öffnet das Projekt, wenn es
  genau einen Treffer gibt.
- **Statusfilter**: Alle, Rückfragen, Laufend, PR offen und Favoriten, jeweils mit Anzahl.
- **Sortierung**: Aktivität (Standard, laufende Aufträge und Rückfragen zuerst), Name oder Zuletzt geändert. Bei aktiver
  Suche stehen die relevantesten Treffer oben.
- **Favoriten** (Stern) stehen immer oben. Sie werden nur im Browser gespeichert (`localStorage`), gelten also je Gerät
  und Browser und nicht serverseitig.
- **Ansicht**: Kacheln oder kompakte Liste. Ab 12 Projekten ist die Liste voreingestellt; die eigene Wahl merkt sich der
  Browser.
- Suchbegriff, Filter und Sortierung stehen in der URL (`?q=…&status=…&sort=…`). So lässt sich eine Ansicht als Link
  teilen oder per Zurück wiederherstellen.
- Archivierte Projekte erscheinen nicht in der Übersicht.

### Rollen und Verteilung

| Rolle | Zweck | Vorliebe (Standard) |
|---|---|---|
| Planen & aufteilen | großen Auftrag in Teilaufträge mit Abhängigkeiten zerlegen | Claude → Codex → Gemini |
| Recherche | nur lesen, Ergebnis geht an die abhängigen Aufträge | Codex → Gemini → Claude |
| Umsetzen | Code ändern, testen, committen | Claude → Codex → Gemini → API |
| Review | Diff prüfen, nur lesen | Gemini → Codex → Claude |
| Korrektur / Konflikt lösen | Nacharbeit, Merge-Konflikte | Claude → Codex |

Die Vorlieben lassen sich unter **Administration → KI-Verteilung** einstellen. Für jedes Konto gibt es Budgets
(5 Stunden / Woche, werden bei Limits automatisch gelernt), gleichzeitige Läufe und eine Wartezeit nach einem Limit. Sie
stehen unter **Administration → Runner & Konten**.

### Commit-Policy je Projekt

- **Pull Request**: Branch `aidev/…` und ein PR.
- **PR mit Auto-Merge**: `gh pr merge --auto --squash`. Das braucht Branch-Protection mit Checks.
- **Direkt**: Rebase und Push auf den Haupt-Branch.

Teilaufträge werden in einen Integrations-Branch gemergt und zum Schluss gemeinsam ausgeliefert.

**Branch-Namen** bildet das System selbst: `aidev/<kurz-id>-<slug>` für Aufträge und Integrations-Branches,
`aidev/<eltern-kurz>/<n>-<slug>` für Teilaufträge. `slugify` entfernt Umlaute, Füllwörter (deutsch/englisch) und
doppelte Wörter und kürzt an Wortgrenzen auf höchstens 5 Wörter bzw. 40 Zeichen. Aus „Ok die branches sollen
automatisch bessere Namen bekommen“ wird so `branches-automatisch-bessere-namen`. Der Orchestrator kann im Plan ein
optionales Feld `branch` (2–5 Wörter in Kebab-Case, ohne `aidev/`) vorschlagen; es benennt den Integrations-Branch.
Ein bereits gespeicherter Branch des Auftrags und der Head-Branch eines bestehenden PR haben Vorrang.

### Bestehende Pull Requests bearbeiten

Ein Auftrag kann einen offenen Pull Request weiterbearbeiten, statt einen neuen Branch und PR anzulegen. Im Tab
**Pull Requests** des Projekts entsteht dazu ein Auftrag mit `targetPr` (API: `targetPr: <PR-Nummer>`, auch im Chat).

Ablauf:

1. Atrium prüft den PR anhand der synchronisierten PR-Liste. Der Auftrag übernimmt den Head-Branch des PR als
   Arbeits-Branch, Basis ist der Haupt-Branch. Die Auslieferung ist `pr-update`.
2. Der Runner checkt den Head-Branch aus und prüft vor dem Agent-Start, dass der PR offen ist, aus demselben Repo
   stammt und zu diesem Branch gehört. Lässt sich der PR nicht laden, bricht der Lauf ab (nur fehlende
   Inline-Kommentare werden toleriert).
3. Der Agent bekommt PR-Beschreibung, Reviews, Kommentare und Inline-Kommentare angehängt, als **nicht
   vertrauenswürdigen Kontext** (Zitat, gekürzt). Er behandelt ihn als Daten, nicht als Anweisungen.
4. Nach dem Agent laufen Commit und **testCmd**. Schlägt der Test fehl, wird nichts gepusht.
5. Der Runner pusht **ohne Force** auf denselben Branch. Hat jemand parallel gepusht, werden nur die eigenen Commits
   darauf übernommen und **testCmd** läuft auf dem kombinierten Stand erneut, erst dann wird gepusht. Es entsteht kein
   neuer PR.
6. Die Zusammenfassung landet als Kommentar im PR (mit den neuen Commits und `Aidev-Task: <id>`). Der Auftrag geht auf
   **Prüfung**.

Voraussetzungen:

- Der PR ist offen, nicht von einem Fork und hat einen eigenen Branch (nicht den Haupt-Branch).
- Die Pull Requests des Projekts sind synchronisiert, sonst lehnt Atrium den Auftrag ab (422).
- Ein Runner mit der Fähigkeit `prUpdate`. Ältere Runner bekommen solche Aufträge nicht; sie warten in der Schlange.
- Das GitHub-Token des Runners hat Schreibrechte auf den PR-Branch und darf kommentieren
  (siehe [`runner/README.md`](runner/README.md#sicherheit)).

Grenzen:

- **Fork-PRs** werden nicht bearbeitet. Geschlossene oder gemergte PRs ebenso wenig.
- **Kein Force-Push**, auch nicht auf `aidev/`-Branches. Lassen sich die eigenen Commits nicht konfliktfrei auf parallel
  gepushte übernehmen, endet der Lauf als Konflikt; lehnt GitHub den Push ab, schlägt der Lauf fehl.
- **Konflikte** mit dem Haupt-Branch werden gelöst, indem `origin/<Haupt-Branch>` in den PR-Branch gemergt wird. Der
  Branch wird nie rebased.
- Fehlt der Branch auf dem Remote, bricht der Lauf ab. Er wird nicht neu angelegt.

Mit **Planen & Aufteilen** wird der PR-Branch zum Integrations-Branch: Die Teilaufträge zweigen von ihm ab und werden
hineingemergt, keiner öffnet einen neuen PR. Auch jeder Teilauftrag prüft den PR vorher (offen, kein Fork, passender
Branch) und legt einen fehlenden PR-Branch nie neu an; solche Teilaufträge gehen nur an Runner mit `prUpdate`. Die
abschließende Auslieferung pusht in den PR und meldet ihn auch dann als aktualisiert (mit Kommentar), wenn sie selbst
keinen Commit mehr beiträgt. Ein PR-Sync überträgt Merge oder Schließen auf alle Aufträge desselben PR.

### Dateianhänge

Aufträge und Chatnachrichten (Modus Auftrag, Frage und Notiz) können Dateien mitbringen, etwa Screenshots oder Logs.
Jede Datei wird einzeln hochgeladen (`POST /projects/:id/attachments`, Multipart-Feld `file`) und beim Absenden über
`attachmentIds` verknüpft. Es gelten **höchstens 10 Dateien je Auftrag bzw. Nachricht** und **10 MB je Datei**.
Dateinamen werden bereinigt. Im Entwurf entfernte bzw. verworfene Uploads werden sofort gelöscht; übrige hochgeladene
Dateien, die nach 24 Stunden noch nicht verwendet wurden, löscht der Job `attachment-cleanup`. Teilaufträge einer Orchestrierung und per „Umsetzen“ angelegte Aufträge sehen die Anhänge ihres
Ursprungsauftrags. Die Dateien liegen als `bytea` in der Modul-Datenbank; Backups werden dadurch entsprechend größer.

Solche Aufträge gehen nur an Runner mit `capabilities.attachments`. Der Runner lädt die Dateien für seinen eigenen
Lauf, prüft die SHA-256 und legt sie unter `.aidev/attachments/` im Arbeitsverzeichnis ab. `.aidev/` steht in
`info/exclude` und wird nicht committet; versioniert das Repository bereits Dateien unter `.aidev/attachments/`,
bricht der Lauf ab. Im Browser werden nur Rasterbilder (PNG, JPEG, GIF, WebP) inline angezeigt.
Alles andere, auch SVG und HTML, kommt als Download mit `nosniff`.

### Parallelisierung und Modellwahl

**Planen & Aufteilen** zerlegt große Aufträge in Teilaufträge mit Abhängigkeiten. Unabhängige Teilaufträge verteilt
der Scheduler parallel auf freie Konten und Runner. Welcher Anbieter welche Rolle übernimmt, stellst du unter
**Administration → KI-Verteilung** ein. Der Orchestrator setzt `provider` für einen Teilauftrag nur, wenn ein Anbieter
dafür klar geeignet ist; sonst gilt die Verteilung.

### Aufträge neu starten

Fehlgeschlagene, abgebrochene, wartende (Rückfrage) und erledigte Aufträge (auch im Review) startest du auf der
Auftragsseite mit **Neu starten** neu. Nach einer Bestätigung wird der Auftrag mit zurückgesetzten Versuchen neu
eingeplant; bei erledigten Aufträgen arbeitet der Agent erneut auf dem bestehenden Branch. Bei Orchestrierungen werden
standardmäßig nur fehlgeschlagene und abgebrochene Teilaufträge neu gestartet, mit **Auch erledigte Teilaufträge neu
starten** zusätzlich die erledigten. Einzelne Teilaufträge startest du im Reiter **Teilaufträge** über das Symbol in
ihrer Zeile neu. Der übergeordnete Auftrag wartet dann wieder auf seine Teilaufträge.

### Limit-Analyse

Neben der eigenen Schätzung über die Budgets wertet Atrium den **echten Limit-Stand der Anbieter** aus. Du siehst ihn
in der Übersicht **Auslastung der Konten** und unter **Administration → Runner & Konten** im Kasten „Limits laut
Anbieter“.

Woher die Daten kommen:

- Der Runner liest den Stand aus den Läufen mit (Claude `rate_limit_event`, Codex `rate_limits`). Für Claude-Konten mit
  OAuth-Login fragt er ihn zusätzlich alle 5 Minuten aktiv ab, wenn kein frischer Stand aus einem Lauf vorliegt.
- Er sendet den Stand im Heartbeat (`accounts[].limits`) und bei einem Limit-Treffer mit `/limit`. Tokens und Logins
  verlassen den Runner dabei nie, übertragen werden nur Fenster, Prozentwerte, Rücksetzzeiten und Status.
- Unterstützt sind **Claude** (Stream und Abfrage) und **Codex** mit ChatGPT-Login (Stream bzw. Sitzungsdatei).
  Gemini und `openai-api` melden keinen Stand; dort gilt weiter nur die eigene Schätzung. Details und Schalter:
  [`runner/README.md`](runner/README.md#limit-stand).

Was Atrium daraus macht (`modules/aidev/limits.ts`, Speicherung in `limits.service.ts`, Migration `0005`):

- **Speichern**: Je Konto wird der neueste Stand gehalten; ältere Meldungen werden ignoriert. Dazu kommt höchstens alle
  5 Minuten eine Probe je Fenster mit dem Verbrauch laut Ledger. Proben älter als 14 Tage löscht der Job `retention`.
- **Aktualität**: Ein Stand älter als 30 Minuten gilt als **veraltet** und wird so angezeigt.
- **Prognose**: Aus den Proben der aktuellen Periode (gleiche Rücksetzzeit) wird linear hochgerechnet, wann das
  Fenster 100 % erreicht („voraussichtlich erschöpft um …“). Nur bei steigender Nutzung und vor der Rücksetzzeit.
- **Budgetvorschlag**: Median von `Einheiten im Fenster / gemeldete Auslastung` aus den Proben der letzten 7 Tage mit
  mindestens 10 % Auslastung, getrennt für 5 Stunden und Woche. Im Konto-Dialog übernimmt „Vorschlag übernehmen“ die
  Werte in die Budget-Felder; gespeichert wird erst mit „Speichern“.
- **Abgleich**: Weichen eigene Schätzung und Meldung um mehr als 15 Prozentpunkte ab, weist die Oberfläche darauf hin.

Im Scheduler:

- Ob ein Konto noch Aufträge bekommt, prüft er gegen das **Maximum aus eigener Schätzung und aktueller Meldung**
  (5 Stunden; Woche als Maximum aus `week`, `week-opus` und `week-sonnet`). Veraltete Meldungen zählen nicht.
- Ein Fenster mit Status `rejected` und Rücksetzzeit in der Zukunft sperrt das Konto bis dahin, wie eine Wartezeit –
  auch bei veralteten Daten. Ausnahme ist `other` (z. B. Overage), weil das reguläre Kontingent dann oft noch reicht.
- Die Meldung wirkt nur beim Ausschluss, nicht bei der Auswahl, welches Konto einen Auftrag bekommt.

Ältere Runner ohne die Fähigkeit `limitReport` funktionieren weiter. Für ihre Konten steht „Keine Limit-Daten vom
Runner“, und es gilt nur die eigene Schätzung.

### Runner neu starten

Ein Runner darf auch mit laufenden Aufträgen neu gestartet werden. Geordnet beendete Läufe meldet er als abgebrochen,
Atrium plant sie ohne Zählung des Versuchs neu ein. Mit `DRAIN_SEC` wartet der Runner vorher, bis laufende Läufe fertig
sind; in der Zeit steht er unter **Runner & Konten** als „Wird beendet“ und bekommt nichts Neues. Nach einem harten Ende
meldet er bei der nächsten Anmeldung, dass er nichts mehr ausführt (`runIds`), und Atrium gibt die verwaisten Läufe
sofort frei, statt die Lease (90 s) abzuwarten. Details: [`runner/README.md`](runner/README.md#neustart-während-laufender-aufträge).

## Entwicklung

```bash
npm run setup          # Core (.core, Submodul auf festem Tag) installieren, node_modules verlinken, Modul-Pakete
npm run check          # Typprüfung (Core + Modul)
npm run lint           # ESLint mit Modulgrenzen des Core
npm test               # Vitest: modules/aidev/tests
npm run build          # Produktions-Build des Core mit diesem Modul
npm run demo           # Demo-Server http://localhost:4300 (admin@demo.test / Demo-Admin-2026!)
npm run runner:install && npm run runner:test   # Runner
npm run branches:prune # gemergte Branches (lokal + origin) auflisten; mit `-- --apply` löschen
```

`branches:prune` erkennt normale Merges, Squash-Merges, Rebases und Teil-Branches gemergter Sammel-Branches. Den
Basis-Branch, in einem Worktree ausgecheckte Branches und Branches mit Commits aus der letzten Stunde (`--min-age`) lässt
es stehen. Worktrees räumt der Runner selbst auf (nach 48 h bzw. ab 30 Stück).

Neue `aidev/`-Branches räumt Atrium **automatisch** auf: Nach jedem PR-Abgleich (auch im Job) löscht es bei gemergten
PRs den PR-Branch sowie die Branches aller Teilaufträge und Läufe über den Runner-RPC `git.branch-delete` (höchstens
`MAX_BRANCH_DELETE` pro Aufruf). Nur Runner mit der Capability `branchCleanup` bekommen diesen Aufruf. Der Haupt-Branch,
Branches außerhalb von `aidev/` und Branches, die ein aktiver Auftrag (auch als Basis oder Integrations-Branch eines
Vorfahren), ein laufender Lauf oder ein offener PR noch nutzt, bleiben stehen; offene PRs prüft der Runner zusätzlich live
auf GitHub. PRs aus Forks (oder unbekannter Herkunft) und geschlossene, nicht gemergte PRs werden nicht angefasst; der
PR-Branch wird nur auf dem gemergten Stand gelöscht. Während des Löschens sind die Branches reserviert
(`branch_cleanup_claim`), der Scheduler vergibt sie dann weder als Branch noch als Basis. Ist alles erledigt, setzt
Atrium `pull_request.branch_deleted_at` und schreibt das Audit `aidev.branch.deleted`; sonst stellt es den PR um
15 Minuten zurück, damit blockierte PRs spätere nicht verdrängen. `branches:prune` bleibt für Altlasten, also Branches von vor dieser Funktion oder ohne passenden Runner.

## Installation in Atrium

Gehe zu **Administration → Module → Installieren** und gib den GitHub-Link
`https://github.com/<owner>/atrium-ai-development-module/tree/<commit>/modules` ein. Danach aktivierst du das Modul und
startest einen Runner (siehe [`runner/README.md`](runner/README.md)). Dafür legst du einen technischen Benutzer mit einer
Rolle an, die nur das Recht `aidev.runner.connect` hat, und erstellst einen API-Key mit diesem Scope. Den Runner gibst du
anschließend unter **Runner & Konten** frei.

## Sicherheit

- Die Agents laufen **ohne Rückfragen** (`--dangerously-skip-permissions`, `--yolo` …). Betreibe sie deshalb nur im
  Runner-Container, nie auf dem Atrium-Host.
- CLI-Logins, das GitHub-Token und API-Keys bleiben auf dem Runner. Atrium sieht sie nie. Ausgaben werden vor dem
  Hochladen bereinigt (`runner/src/redact.ts`).
- Für die [Limit-Analyse](#limit-analyse) sendet der Runner nur Limit-Werte (Fenster, Prozent, Rücksetzzeit, Status).
  Die aktive Claude-Abfrage nutzt das OAuth-Token lokal und lässt sich mit `LIMIT_PROBE=false` abschalten.
- Verwende ein fine-grained PAT, das nur für die gewählten Repos gilt, und Branch-Protection auf `main`.
- Terminal und Dateieditor geben vollen Zugriff auf die Arbeitskopie des Runners, also eigene Rechte
  (`aidev.workspace.terminal`, `aidev.workspace.files`). Jede Sitzung wird protokolliert.
- Externe Empfänger sind GitHub und die KI-Anbieter (Anthropic, OpenAI, Google bzw. die eingestellte API). Sie werden
  ausschließlich vom Runner aus angesprochen.

### Auslieferung pro Auftrag

Bei neuen Aufträgen im Board oder Chat bestimmt „Auslieferung“ das Ergebnis: „Projektvorgabe“
verwendet weiterhin die aktuelle Commit-Policy des Projekts. „Branch bereitstellen (ohne PR)“
pusht getestete Änderungen auf einen eigenen Remote-Branch, erstellt keinen Pull Request und
ändert den Hauptbranch nicht. Bei aufgeteilten Aufträgen werden die Teilaufträge zunächst auf
dem Integrations-Branch zusammengeführt; die Wahl gilt für die abschließende Auslieferung.
Leseaufträge liefern keine Änderungen aus. Die Auftragsansicht zeigt, ob ein Branch tatsächlich
bereitgestellt wurde; ohne Änderungen wird kein Branch gepusht. API-Aufrufe können optional
`delivery: "branch"` setzen; ohne Angabe gilt `delivery: "project"`, auch für bestehende Aufträge.
Runner müssen für die neue Option aktualisiert werden: Der Scheduler vergibt Branch-Auslieferungen
nur an Runner, die sich mit der Capability `branchDelivery` anmelden; bei gemischten Runner-Versionen
bleiben solche Aufträge in der Warteschlange, bis ein aktueller Runner frei ist.

Im Projekt-Chat beantwortet der Modus „Frage“ freie Fragen durch einen lesenden Agenten. Der
Anbieter kann gewählt werden; frühere Fragen und Antworten werden begrenzt als Kontext übergeben,
Notizen und Aufträge nicht. Antwort, Fehler und Abbruch erscheinen im Chat und sind mit dem Lauf
verknüpft. Fragen benötigen wie Aufträge das Recht `task.create`. Der Runner führt kein Projekt-Setup
oder Auslieferung für Fragen aus; hierfür muss er auf die aktuelle Version aktualisiert werden.
Die Lesebeschränkung hängt zusätzlich von den jeweiligen CLI-Anbietern und deren Konfiguration ab;
sie ersetzt keine isolierte Runner-Umgebung oder restriktive Zugangsdaten.

Der Modus „Automatisch“ ist im UI der Standard: Die Nachricht wird regelbasiert (Deutsch und Englisch,
`classifyChatIntent` in `modules/aidev/intent.ts`) als Frage oder Auftrag erkannt. Aufforderungen mit
Änderungsverb („Passe … an“, „Kannst du den Bug fixen?“, „Add dark mode“) werden Aufträge; Fragezeichen am
Ende, Fragewörter („Wie …“, „What …“) und Erklärungswünsche werden Fragen; Code-Blöcke und Inline-Code
zählen nicht. Ohne eindeutige Merkmale entsteht ein Auftrag. Der Modus lässt sich jederzeit manuell auf
„Auftrag“, „Frage“ oder „Notiz“ übersteuern. Über die API gilt ohne `mode` weiterhin `mode: "task"`;
`mode: "auto"` muss ausdrücklich gesetzt werden. Die Antwort von `POST /projects/:id/chat` enthält neben
`message` und `task` den wirksamen Modus `mode` (`task`, `question` oder `note`).

#### Vom Chat zur Umsetzung

Typischer Ablauf: Du stellst eine **Frage**, ein lesender Agent antwortet, und unter der Antwort steht der Knopf
**„Umsetzen“**. Er stellt die Eingabe auf „Auftrag“, schlägt den Text „Setze den Vorschlag aus dieser Antwort um.“
vor und zeigt den Bezug als entfernbaren Chip („Bezug: Antwort von 14:05“). Beim Senden geht die Antwort als
`replyTo` mit; der neue Auftrag erhält Frage und Antwort als Kontext (gekürzt, zusätzlich zum bisherigen Verlauf).
Kurze Folgebefehle wie „Mach das“, „Los geht's“ oder „Do it“ erkennt der Auto-Modus ebenfalls als Auftrag.

**Vorschläge der Agents:** Agents dürfen am Ende einer Antwort Plattformaktionen vorschlagen – einen neuen Auftrag
anlegen (`create`), einen bestehenden ändern (`update`: Titel, Text, Priorität, Anbieter) oder abbrechen (`cancel`).
Dazu hängen sie einen Code-Block in der Sprache `aidev-actions` an (`{"actions":[…]}`, höchstens 10; Schema und
Parser in `modules/aidev/actions.ts`). Atrium entfernt den Block aus dem sichtbaren Text, prüft jede Aktion einzeln
und zeigt die gültigen als Karten unter der Antwort. **Nichts passiert ohne Bestätigung:** Jede Karte muss mit
„Übernehmen“ bestätigt oder mit „Verwerfen“ abgelehnt werden; ab zwei offenen Vorschlägen gibt es „Alle übernehmen“.
Übernehmen braucht `task.create`; fremde Aufträge ändern oder abbrechen nur mit `task.manage`, und nur Aufträge
desselben Projekts. Scheitert eine Aktion (z. B. Auftrag läuft gerade), steht sie mit Fehlertext auf „Nicht
übernommen“. API: `POST /chat/:id/actions/:index` mit `{ "decision": "apply" | "reject" }`.
