# Atrium AI Development (`aidev`) – Project notes for Claude

Module repository for **Kalypzo Atrium**. The core is a Git submodule at `.core` (pinned to tag `v2.0.0-pre.2`); its rules
still apply: `.core/.claude/CLAUDE.md` and `.core/.claude/rules/*.md` (especially `modules.md`, `architecture.md`, `ui-design.md`,
`testing-and-verification.md`). The user speaks German.

## Structure
- `modules/aidev/` – Atrium module (control center): `protocol.ts` (Runner ↔ Atrium, also bundled by the runner – only `zod`),
  `schemas.ts` (permissions, DTOs, endpoint table), `scheduler.ts` + `prompts.ts` (pure logic), `*.endpoints.ts`/`*.service.ts`,
  `live.ts` (SSE hubs), `jobs.ts`, `migrations/`, `pages/` + `ui.ts` (interface), `tests/`.
- `runner/` – standalone Node service (Docker) with git, gh, and the agent CLIs; not loaded by Atrium.

## Commands
| Command | Purpose |
|---|---|
| `npm run setup` | Install core, `node_modules` → `.core/node_modules`, module packages |
| `npm run check` / `npm run lint` / `npm run format:check` | Types / ESLint / Prettier |
| `npm test` | Module tests (Vitest in core with `ATRIUM_MODULES_DIR`) |
| `npm run build` / `npm run demo` | Build / demo (:4300) |
| `npm run runner:test` | Runner tests |

## Rules
1. Never modify `.core`. Modules import only `$lib/sdk/*`, `$lib/components/{ui,layout,forms}`, `$lib/utils`.
2. `protocol.ts` affects both sides – maintain backward compatibility, observe `PROTOCOL_VERSION`, and run the runner tests.
3. Migrations are additive and immutable (`check:migrations`); add new permissions to both the manifest **and** `atrium-module.json`.
4. Never render agent output as `{@html}`; secrets stay on the runner.
5. Do not commit or push anything unless the user requests it.
