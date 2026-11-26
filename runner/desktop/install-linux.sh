#!/usr/bin/env bash
set -euo pipefail
runner_dir=$(cd "$(dirname "$0")/.." && pwd -P)
config=${1:-${RUNNER_CONFIG:-}}
name=${2:-${RUNNER_NAME:-}}
if [[ -z $config ]]; then read -r -p 'Pfad zur Konfiguration: ' config; fi
config=$(cd "$(dirname "$config")" && pwd -P)/$(basename "$config")
for cmd in node npm git gh systemctl; do command -v "$cmd" >/dev/null || { echo "Fehlt: $cmd" >&2; exit 1; }; done
node_bin=$(command -v node)
node -e 'if (+process.versions.node.split(".")[0] < 24) process.exit(1)' || { echo 'Node.js 24 oder neuer erforderlich.' >&2; exit 1; }
for cmd in claude codex gemini; do command -v "$cmd" >/dev/null || echo "Warnung: $cmd wurde nicht gefunden."; done
[[ -f $config ]] || { echo 'Konfigurationsdatei fehlt.' >&2; exit 1; }
if [[ -z ${ATRIUM_URL:-} ]] && ! node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).atriumUrl ? 0 : 1)' "$config"; then
  read -r -p 'Atrium-URL: ' ATRIUM_URL; export ATRIUM_URL
fi
if [[ -z ${ATRIUM_API_KEY:-} ]] && ! node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).apiKey ? 0 : 1)' "$config"; then
  read -r -s -p 'Atrium-API-Key: ' ATRIUM_API_KEY; echo; export ATRIUM_API_KEY
fi
(cd "$runner_dir" && npm ci && npm run build)
base=${XDG_CONFIG_HOME:-$HOME/.config}/atrium-aidev-runner
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
mkdir -p "$base" "$unit_dir"
chmod 700 "$base"
export SOURCE_CONFIG="$config" DEST_CONFIG="$base/config.json" RUNNER_NAME_VALUE="$name"
export RUNNER_DIR_VALUE="$runner_dir" NODE_VALUE="$node_bin" UNIT_DIR_VALUE="$unit_dir" BASE_VALUE="$base"
# JSON sicher kopieren; URL und Schlüssel werden separat als systemd-Umgebung gespeichert.
umask 077
node <<'NODE'
const fs = require('fs');
const c = JSON.parse(fs.readFileSync(process.env.SOURCE_CONFIG, 'utf8'));
const url = process.env.ATRIUM_URL || c.atriumUrl;
const key = process.env.ATRIUM_API_KEY || c.apiKey;
if (!url || !key) throw new Error('ATRIUM_URL und ATRIUM_API_KEY müssen in der Umgebung oder Konfiguration stehen.');
delete c.apiKey;
if (process.env.RUNNER_NAME_VALUE) c.name = process.env.RUNNER_NAME_VALUE;
c.mode = 'desktop';
fs.writeFileSync(process.env.DEST_CONFIG, JSON.stringify(c, null, 2) + '\n', {mode: 0o600});
fs.chmodSync(process.env.DEST_CONFIG, 0o600);
const envQuote = v => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
const envFile = process.env.BASE_VALUE + '/runner.env';
fs.writeFileSync(envFile, 'ATRIUM_URL=' + envQuote(url) + '\nATRIUM_API_KEY=' + envQuote(key) + '\n', {mode: 0o600});
fs.chmodSync(envFile, 0o600);
const q = v => '"' + v.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const handoff = Number(process.env.HANDOFF_SEC ?? c.handoffSec ?? 8);
if (!Number.isInteger(handoff) || handoff < 0 || handoff > 86400) throw new Error('Ungültiges handoffSec.');
const unit = `[Unit]\nDescription=Atrium aidev-Runner\n[Service]\nType=simple\nWorkingDirectory=${q(process.env.RUNNER_DIR_VALUE)}\nEnvironment=${q('PATH=' + process.env.PATH)}\nEnvironmentFile=${q(envFile)}\nExecStart=${q(process.env.NODE_VALUE)} ${q(process.env.RUNNER_DIR_VALUE + '/dist/main.js')} start --config ${q(process.env.DEST_CONFIG)}\nRestart=on-failure\nKillSignal=SIGTERM\nTimeoutStopSec=${handoff + 30}\n[Install]\nWantedBy=default.target\n`;
fs.writeFileSync(process.env.UNIT_DIR_VALUE + '/atrium-aidev-runner.service', unit);
NODE
systemctl --user daemon-reload
systemctl --user enable --now atrium-aidev-runner.service
systemctl --user restart atrium-aidev-runner.service
echo "Installiert. Logs: journalctl --user -u atrium-aidev-runner.service -f"
echo "Konten anmelden: cd \"$runner_dir\" && node dist/main.js login <konto> --config \"$base/config.json\""
echo "Prüfen: node dist/main.js probe --config \"$base/config.json\" (ATRIUM_URL und ATRIUM_API_KEY setzen). In Atrium den Runner freigeben."
echo 'Optional: loginctl enable-linger ermöglicht den Betrieb auch ohne aktive Anmeldung.'
