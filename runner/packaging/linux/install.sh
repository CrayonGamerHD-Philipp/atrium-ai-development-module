#!/bin/sh
# Installation des Atrium-Runners aus dem .tar.gz für den aktuellen Benutzer (ohne root):
#   ./install.sh            Programm nach ~/.local/lib/atrium-runner, Befehl ~/.local/bin/atrium-runner,
#                           Konfigurationsvorlage und systemd-User-Unit (ohne Start)
#   ./install.sh --start    zusätzlich sofort starten
set -eu
if [ "$(id -u)" = "0" ]; then
	echo "Bitte nicht als root ausführen – der PC-Runner läuft im eigenen Benutzerkonto." >&2
	exit 2
fi
SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEST="$HOME/.local/lib/atrium-runner"
mkdir -p "$DEST"
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
# laufenden Runner geordnet beenden, bevor die Dateien ersetzt werden
if [ -x "$DEST/atrium-runner" ]; then "$DEST/atrium-runner" stop >/dev/null 2>&1 || true; fi
cp -R "$SRC/." "$DEST/"
ln -sf "$DEST/atrium-runner" "$BIN/atrium-runner"
if [ "${1:-}" = "--start" ]; then
	"$DEST/atrium-runner" install
else
	"$DEST/atrium-runner" install --no-start
	echo "Konfiguration ausfüllen, dann: atrium-runner probe && atrium-runner service-start"
fi
case ":$PATH:" in
	*":$BIN:"*) ;;
	*) echo "Hinweis: $BIN ist nicht im PATH – z. B. in ~/.profile ergänzen." ;;
esac
