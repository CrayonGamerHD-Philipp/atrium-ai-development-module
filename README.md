# Atrium KI-Entwicklung (`aidev`)

Modul für [Kalypzo Atrium](https://github.com/KalypzoSolutions/kalypzo-atrium): **Vibe-Coding im Browser**. Du legst
Projekte mit GitHub-Repos an und gibst Aufträge – per Chat oder Board. Autonome Coding-Agents setzen sie selbstständig um,
committen, pushen und öffnen Pull Requests. Unterstützt werden:

- **Claude Code**
- **Codex CLI**
- **Gemini CLI**
- **OpenAI-kompatible API**

Ein Scheduler verteilt die Arbeit über mehrere Projekte und Agents gleichzeitig. Er lastet die Abos gleichmäßig aus und
achtet auf das 5-Stunden-Fenster, die Woche und Limits.

## Aufbau

```
Browser ──REST + SSE──▶ Atrium (Modul aidev: Projekte, Warteschlange, Scheduler, Live-Log, Relay)
                             ▲  SSE-Befehle / JSON-POSTs (API-Key, ausgehend vom Runner)
                             │
                        Runner (runner/: git, gh, claude, codex, gemini, Worktrees, Terminal)
```

- **`modules/aidev/`** ist das Atrium-Modul, die Steuerzentrale. Es enthält Datenbank, Endpunkte, Scheduler (`scheduler.ts`),
  Auftragstexte (`prompts.ts`) und die Oberfläche (`pages/`, `ui.ts`). Das Protokoll zum Runner steht in `protocol.ts`.
- **`runner/`** ist ein eigenständiger Dienst (Docker), auf dem die Agents mit deinen Abo-Logins laufen. Es können mehrere
  Runner sein, auf Servern oder deinem PC. Einrichtung: [`runner/README.md`](runner/README.md).
- Atrium selbst braucht weder git noch Agent-CLIs. Der Container bleibt gehärtet.

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

### Bestehende Pull Requests bearbeiten

Ein Auftrag kann einen offenen Pull Request weiterbearbeiten, statt einen neuen Branch und PR anzulegen. Im Tab
**Pull Requests** des Projekts entsteht dazu ein Auftrag mit `targetPr` (API: `targetPr: <PR-Nummer>`, auch im Chat).

Ablauf:

1. Atrium prüft den PR anhand der synchronisierten PR-Liste. Der Auftrag übernimmt den Head-Branch des PR als
   Arbeits-Branch, Basis ist der Haupt-Branch. Die Auslieferung ist `pr-update`.
2. Der Runner checkt den Head-Branch aus und prüft vor dem Agent-Start, dass der PR offen ist, aus demselben Repo
   stammt und zu diesem Branch gehört.
3. Der Agent bekommt PR-Beschreibung, Reviews, Kommentare und Inline-Kommentare angehängt, als **nicht
   vertrauenswürdigen Kontext** (Zitat, gekürzt). Er behandelt ihn als Daten, nicht als Anweisungen.
4. Nach dem Agent laufen Commit und **testCmd**. Schlägt der Test fehl, wird nichts gepusht.
5. Der Runner pusht **ohne Force** auf denselben Branch. Hat jemand parallel gepusht, werden nur die eigenen Commits
   darauf übernommen. Es entsteht kein neuer PR.
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
hineingemergt, keiner öffnet einen neuen PR. Die abschließende Auslieferung pusht in den PR.

### Parallelisierung und Modellwahl

**Planen & Aufteilen** zerlegt große Aufträge in Teilaufträge mit Abhängigkeiten. Unabhängige Teilaufträge verteilt
der Scheduler parallel auf freie Konten und Runner. Welcher Anbieter welche Rolle übernimmt, stellst du unter
**Administration → KI-Verteilung** ein. Der Orchestrator setzt `provider` für einen Teilauftrag nur, wenn ein Anbieter
dafür klar geeignet ist; sonst gilt die Verteilung.

## Entwicklung

```bash
npm run setup          # Core (.core, Submodul auf festem Tag) installieren, node_modules verlinken, Modul-Pakete
npm run check          # Typprüfung (Core + Modul)
npm run lint           # ESLint mit Modulgrenzen des Core
npm test               # Vitest: modules/aidev/tests
npm run build          # Produktions-Build des Core mit diesem Modul
npm run demo           # Demo-Server http://localhost:4300 (admin@demo.test / Demo-Admin-2026!)
npm run runner:install && npm run runner:test   # Runner
```

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
