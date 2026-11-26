# Verpackung des PC-Runners

Wird von `.github/workflows/release-runner.yml` verwendet (Einzel-Binary aus `scripts/build-sea.mjs`).

| Datei | Zweck |
|---|---|
| `windows/atrium-runner.iss` | Inno-Setup-Installer (pro Benutzer, ohne Administratorrechte): Programm nach `%LOCALAPPDATA%\Programs\AtriumRunner`, `PATH` des Benutzers, Autostart über `atrium-runner install`, Deinstallation entfernt den Autostart |
| `macos/postinstall` | `.pkg`: verlinkt `/usr/local/bin/atrium-runner` und richtet den LaunchAgent für den angemeldeten Benutzer ein |
| `macos/entitlements.plist` | Hardened Runtime für die Node-Laufzeit (JIT) und das beigelegte `node-pty` (nur bei Developer-ID-Signatur) |
| `linux/install.sh` | Installation aus dem `.tar.gz` nach `~/.local/lib/atrium-runner` mit systemd-User-Unit |
| `linux/deb-postinst` | `.deb`: Hinweis auf `atrium-runner install` (Autostart ist pro Benutzer) |
| `runner.desktop.example.json` | Konfigurationsvorlage für den PC-Betrieb (identisch mit `atrium-runner init`) |
