// Version für das Runner-Release prüfen: `node scripts/release-version.mjs [runner-vX.Y.Z]`
// - Version aus runner/package.json (Quelle von `RUNNER_VERSION`, siehe src/version.ts)
// - muss mit modules/aidev/runner-release.ts (Update-Hinweis in Atrium) und – falls angegeben – mit dem Tag übereinstimmen
// Ausgabe für GitHub Actions (`$GITHUB_OUTPUT`): version, tag, prerelease (true bei -beta/-rc/-alpha)
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const release = readFileSync(join(root, '..', 'modules', 'aidev', 'runner-release.ts'), 'utf8');
const moduleVersion = /RUNNER_RELEASE_VERSION\s*=\s*'([^']+)'/.exec(release)?.[1];
const tag = (process.argv[2] ?? '').replace(/^refs\/tags\//, '');
const fail = (msg) => {
	console.error(`::error::${msg}`);
	process.exit(1);
};
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`Ungültige Version in runner/package.json: ${version}`);
if (moduleVersion !== version)
	fail(`modules/aidev/runner-release.ts (${moduleVersion}) passt nicht zu runner/package.json (${version})`);
if (tag && tag !== `runner-v${version}`) fail(`Tag ${tag} passt nicht zur Version ${version} (erwartet runner-v${version})`);
const prerelease = /-(alpha|beta|rc)/i.test(version);
const out = { version, tag: `runner-v${version}`, prerelease: String(prerelease) };
console.log(JSON.stringify(out));
if (process.env.GITHUB_OUTPUT) {
	appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
}
