#!/usr/bin/env bash
set -euo pipefail
runner_dir=$(cd "$(dirname "$0")/.." && pwd -P)
config=${1:-${RUNNER_CONFIG:-}}
name=${2:-${RUNNER_NAME:-}}
if [[ -z $config ]]; then read -r -p 'Pfad zur Konfiguration: ' config; fi
config=$(cd "$(dirname "$config")" && pwd -P)/$(basename "$config")
for cmd in node npm git gh launchctl; do command -v "$cmd" >/dev/null || { echo "Fehlt: $cmd" >&2; exit 1; }; done
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
base="$HOME/Library/Application Support/atrium-aidev-runner"
logs="$HOME/Library/Logs/atrium-aidev-runner"
plist="$HOME/Library/LaunchAgents/org.atrium.aidev-runner.plist"
mkdir -p "$base" "$logs" "$(dirname "$plist")"
chmod 700 "$base" "$logs"
umask 077
export SOURCE_CONFIG="$config" DEST_CONFIG="$base/config.json" RUNNER_NAME_VALUE="$name" RUNNER_DIR_VALUE="$runner_dir" NODE_VALUE="$node_bin" LOGS_VALUE="$logs" PLIST_VALUE="$plist"
node <<'NODE'
const fs = require('fs');
const c = JSON.parse(fs.readFileSync(process.env.SOURCE_CONFIG, 'utf8'));
c.atriumUrl = process.env.ATRIUM_URL || c.atriumUrl;
c.apiKey = process.env.ATRIUM_API_KEY || c.apiKey;
if (!c.atriumUrl || !c.apiKey) throw new Error('ATRIUM_URL und ATRIUM_API_KEY müssen in der Umgebung oder Konfiguration stehen.');
if (process.env.RUNNER_NAME_VALUE) c.name = process.env.RUNNER_NAME_VALUE;
c.mode = 'desktop';
fs.writeFileSync(process.env.DEST_CONFIG, JSON.stringify(c, null, 2) + '\n', {mode: 0o600});
fs.chmodSync(process.env.DEST_CONFIG, 0o600);
const handoff = Number(process.env.HANDOFF_SEC ?? c.handoffSec ?? 8);
if (!Number.isInteger(handoff) || handoff < 0 || handoff > 86400) throw new Error('Ungültiges handoffSec.');
const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const str = s => '<string>' + x(s) + '</string>';
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key>${str('org.atrium.aidev-runner')}\n<key>ProgramArguments</key><array>${[process.env.NODE_VALUE, process.env.RUNNER_DIR_VALUE + '/dist/main.js', 'start', '--config', process.env.DEST_CONFIG].map(str).join('')}</array>\n<key>WorkingDirectory</key>${str(process.env.RUNNER_DIR_VALUE)}\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ExitTimeOut</key><integer>${handoff + 30}</integer>\n<key>EnvironmentVariables</key><dict><key>PATH</key>${str(process.env.PATH)}<key>RUNNER_CONFIG</key>${str(process.env.DEST_CONFIG)}</dict>\n<key>StandardOutPath</key>${str(process.env.LOGS_VALUE + '/stdout.log')}\n<key>StandardErrorPath</key>${str(process.env.LOGS_VALUE + '/stderr.log')}\n</dict></plist>\n`;
fs.writeFileSync(process.env.PLIST_VALUE, plist);
NODE
launchctl bootout "gui/$(id -u)/org.atrium.aidev-runner" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Installiert. Logs: $logs"
echo "Konten anmelden: cd \"$runner_dir\" && node dist/main.js login <konto> --config \"$base/config.json\""
echo "Prüfen: node dist/main.js probe --config \"$base/config.json\". In Atrium den Runner freigeben."
