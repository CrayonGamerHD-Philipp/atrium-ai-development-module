#!/usr/bin/env bash
set -euo pipefail
systemctl --user disable --now atrium-aidev-runner.service 2>/dev/null || true
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/atrium-aidev-runner.service"
systemctl --user daemon-reload
echo 'Dienst entfernt. Konfiguration und Zugangsdaten bleiben unter ~/.config/atrium-aidev-runner erhalten.'
