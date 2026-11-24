# Atrium KI-Entwicklung (`aidev`) – Projekthinweise für Claude

Modul-Repo für **Kalypzo Atrium**. Der Core liegt als Git-Submodul unter `.core` (fester Tag `v2.0.0-pre.2`); seine Regeln gelten
weiter: `.core/.claude/CLAUDE.md` und `.core/.claude/rules/*.md` (vor allem `modules.md`, `architecture.md`, `ui-design.md`,
`testing-and-verification.md`). Der Nutzer ist deutschsprachig.

## Aufbau
- `modules/aidev/` – Atrium-Modul (Steuerzentrale): `protocol.ts` (Runner ↔ Atrium, auch vom Runner gebündelt – nur `zod`),
  `schemas.ts` (Rechte, DTOs, Endpunkt-Tabelle), `scheduler.ts` + `prompts.ts` (reine Logik), `*.endpoints.ts`/`*.service.ts`,
  `live.ts` (SSE-Hubs), `jobs.ts`, `migrations/`, `pages/` + `ui.ts` (Oberfläche), `tests/`.
- `runner/` – eigenständiger Node-Dienst (Docker) mit git, gh und den Agent-CLIs; nicht von Atrium geladen.

## Befehle
| Befehl | Zweck |
|---|---|
| `npm run setup` | Core installieren, `node_modules` → `.core/node_modules`, Modul-Pakete |
| `npm run check` / `npm run lint` / `npm run format:check` | Typen / ESLint / Prettier |
| `npm test` | Modultests (Vitest im Core mit `ATRIUM_MODULES_DIR`) |
| `npm run build` / `npm run demo` | Build / Demo (:4300) |
| `npm run runner:test` | Tests des Runners |

## Regeln
1. Nie in `.core` ändern. Module importieren nur `$lib/sdk/*`, `$lib/components/{ui,layout,forms}`, `$lib/utils`.
2. `protocol.ts` ändert beide Seiten – abwärtskompatibel, `PROTOCOL_VERSION` beachten, Runner-Tests mitlaufen lassen.
3. Migrationen additiv und unveränderlich (`check:migrations`), neue Rechte in Manifest **und** `atrium-module.json`.
4. Agent-Ausgaben nie als `{@html}`; Geheimnisse bleiben auf dem Runner.
5. Nichts committen oder pushen, solange der Nutzer es nicht verlangt.
