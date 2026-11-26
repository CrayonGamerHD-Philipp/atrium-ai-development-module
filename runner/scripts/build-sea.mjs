// Einzel-Binary des Runners (Node SEA – Single Executable Application) für die aktuelle Plattform bauen:
//
//   node scripts/build-sea.mjs [--out release] [--name atrium-runner]
//
// 1. Runner als CommonJS-Bündel (`dist/sea/main.cjs`, inkl. protocol.ts, zod, cross-spawn)
// 2. SEA-Blob erzeugen (`node --experimental-sea-config`)
// 3. die laufende Node-Binärdatei kopieren, Signatur entfernen (macOS/Windows), Blob mit `postject` einsetzen
// 4. macOS: ad-hoc signieren (echte Signatur/Notarisierung übernimmt die Release-Pipeline)
// 5. `node-pty` (nativ, je Plattform/Architektur gebaut) als `node_modules/node-pty` neben das Programm legen
//
// Ergebnis: `<out>/atrium-runner-<version>-<os>-<arch>/` mit `atrium-runner(.exe)`, `node_modules/node-pty`,
// `runner.config.example.json`, `runner.desktop.example.json`, `README.md`, `LICENSE-NOTICE.txt` (Linux: `install.sh`). Benötigt kein installiertes Node beim Nutzer.
// Muss auf der Zielplattform laufen (kein Cross-Compile): Die Node-Laufzeit und node-pty stammen vom Build-Rechner.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const outRoot = resolve(root, arg('--out', 'release'));
const name = arg('--name', 'atrium-runner');
const platform = process.platform;
const arch = process.arch;
const osName = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform] ?? platform;
const exeName = platform === 'win32' ? `${name}.exe` : name;
const dirName = `${name}-${pkg.version}-${osName}-${arch}`;
const outDir = join(outRoot, dirName);
const seaDir = join(root, 'dist', 'sea');

const run = (cmd, args, opts = {}) => {
	console.log(`$ ${cmd} ${args.join(' ')}`);
	execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
};

/** `zod` immer aus `runner/node_modules` – auch für die Protokolldatei außerhalb des Pakets */
const zodFromRunner = {
	name: 'zod-from-runner',
	setup(b) {
		b.onResolve({ filter: /^zod(\/.*)?$/ }, async (a) => {
			if (a.pluginData?.fromRunner) return undefined;
			const r = await b.resolve(a.path, { kind: a.kind, resolveDir: root, pluginData: { fromRunner: true } });
			return r.errors.length ? { errors: r.errors } : { path: r.path };
		});
	}
};

rmSync(seaDir, { recursive: true, force: true });
mkdirSync(seaDir, { recursive: true });
await build({
	entryPoints: [join(root, 'src/main.ts')],
	outfile: join(seaDir, 'main.cjs'),
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	tsconfig: join(root, 'tsconfig.json'),
	external: ['node-pty'],
	plugins: [zodFromRunner],
	define: { __RUNNER_VERSION__: JSON.stringify(pkg.version), 'import.meta.url': '__aidevImportMetaUrl' },
	banner: { js: "const __aidevImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
	logLevel: 'info'
});

const blob = join(seaDir, 'sea-prep.blob');
writeFileSync(
	join(seaDir, 'sea-config.json'),
	JSON.stringify(
		{ main: join(seaDir, 'main.cjs'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false },
		null,
		2
	)
);
run(process.execPath, ['--experimental-sea-config', join(seaDir, 'sea-config.json')]);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const exe = join(outDir, exeName);
copyFileSync(process.execPath, exe);
if (platform !== 'win32') chmodSync(exe, 0o755);
if (platform === 'darwin') run('codesign', ['--remove-signature', exe]);
if (platform === 'win32') {
	// vorhandene Signatur der Node-Binärdatei entfernen (sonst ungültig nach dem Einsetzen); ohne signtool egal
	try {
		execFileSync('signtool', ['remove', '/s', exe], { stdio: 'ignore' });
	} catch {
		console.log('signtool nicht gefunden – Signatur der Node-Binärdatei bleibt (wird beim Signieren ersetzt)');
	}
}
const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const postjectArgs = [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, postjectArgs);
if (platform === 'darwin') run('codesign', ['--sign', '-', exe]);

// node-pty (optional): ohne gebautes Modul bleiben Terminals im Browser deaktiviert
const pty = join(root, 'node_modules', 'node-pty');
if (existsSync(join(pty, 'package.json'))) {
	cpSync(pty, join(outDir, 'node_modules', 'node-pty'), {
		recursive: true,
		filter: (src) => !/[\\/](src|deps|test|scripts|third_party)([\\/]|$)/.test(src.slice(pty.length))
	});
	writeFileSync(join(outDir, 'package.json'), JSON.stringify({ name: 'atrium-runner-bundle', private: true }, null, 2));
	console.log('node-pty beigelegt');
} else {
	console.warn('WARNUNG: node-pty fehlt – Terminals sind in diesem Build deaktiviert');
}

cpSync(join(root, 'runner.config.example.json'), join(outDir, 'runner.config.example.json'));
cpSync(join(root, 'packaging', 'runner.desktop.example.json'), join(outDir, 'runner.desktop.example.json'));
if (platform === 'linux') {
	cpSync(join(root, 'packaging', 'linux', 'install.sh'), join(outDir, 'install.sh'));
	chmodSync(join(outDir, 'install.sh'), 0o755);
}
// Oberfläche ohne Konsolenfenster öffnen (Startmenü-Eintrag des Installers)
if (platform === 'win32') cpSync(join(root, 'packaging', 'windows', 'open-ui.vbs'), join(outDir, 'open-ui.vbs'));
cpSync(join(root, 'README.md'), join(outDir, 'README.md'));
writeFileSync(
	join(outDir, 'LICENSE-NOTICE.txt'),
	[
		`Atrium aidev-Runner ${pkg.version} (${osName}-${arch})`,
		'',
		'Enthält die Node.js-Laufzeit (MIT, https://nodejs.org/en/about) sowie die npm-Pakete zod (MIT),',
		'cross-spawn (MIT) und node-pty (MIT). Agent-CLIs (claude, codex, gemini), git und gh sind nicht enthalten.',
		''
	].join('\n')
);
writeFileSync(join(outRoot, `${dirName}.dirname`), dirName);
console.log(`\nFertig: ${outDir}`);
