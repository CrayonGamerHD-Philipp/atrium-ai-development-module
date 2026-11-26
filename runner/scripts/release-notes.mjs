// Release Notes aus den Commits seit dem letzten Runner-Tag: `node scripts/release-notes.mjs <tag> > notes.md`
// Berücksichtigt Änderungen am Runner, am Protokoll und an der Release-Pipeline; PR-Nummern aus den
// Commit-Betreffs (z. B. „(#12)“) bleiben erhalten und werden von GitHub verlinkt.
import { execFileSync } from 'node:child_process';

const tag = process.argv[2] ?? '';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let previous = '';
try {
	previous = git('describe', '--tags', '--abbrev=0', '--match', 'runner-v*', `${tag && tag !== 'HEAD' ? `${tag}^` : 'HEAD^'}`);
} catch {
	previous = '';
}
const range = previous ? `${previous}..${tag || 'HEAD'}` : tag || 'HEAD';
const paths = ['runner', 'modules/aidev/protocol.ts', 'modules/aidev/runner-release.ts', '.github/workflows/release-runner.yml'];
let log = '';
try {
	log = git('log', '--no-merges', ...(previous ? [] : ['--max-count=50']), '--format=- %s (%h)', range, '--', ...paths);
} catch {
	log = '';
}
const lines = [
	`## Atrium-Runner ${tag && tag !== 'HEAD' ? tag.replace(/^runner-v/, '') : '(Entwicklungsstand)'}`,
	'',
	previous ? `Änderungen seit ${previous}:` : 'Änderungen:',
	'',
	log || '- (keine Änderungen am Runner)',
	'',
	'### Downloads',
	'',
	'| System | Datei |',
	'|---|---|',
	'| Windows 10/11 (x64) | `atrium-runner-<version>-windows-x64-setup.exe` (Installer) oder `…-windows-x64.zip` |',
	'| Windows 11 (arm64) | `…-windows-arm64-setup.exe` (falls vorhanden) |',
	'| macOS (Apple Silicon / Intel) | `…-macos-arm64.pkg` / `…-macos-x64.pkg` oder `.tar.gz` |',
	'| Linux (x64 / arm64) | `…-linux-x64.tar.gz` / `…-linux-arm64.tar.gz` oder `.deb` |',
	'',
	'Prüfsummen: `SHA256SUMS.txt`. Nicht enthalten: Agent-CLIs (claude, codex, gemini), git und gh – `atrium-runner probe` nennt fehlende Programme.',
	'Unsignierte Builds: Windows SmartScreen bzw. macOS Gatekeeper warnen beim ersten Start (siehe runner/README.md).',
	''
];
process.stdout.write(lines.join('\n'));
