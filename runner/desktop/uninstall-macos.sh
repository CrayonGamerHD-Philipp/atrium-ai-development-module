#!/usr/bin/env bash
set -euo pipefail
launchctl bootout "gui/$(id -u)/org.atrium.aidev-runner" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/org.atrium.aidev-runner.plist"
echo 'LaunchAgent entfernt. Konfiguration und Logs bleiben im Library-Verzeichnis erhalten.'
