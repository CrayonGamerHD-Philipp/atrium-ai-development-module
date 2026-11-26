/**
 * Isolation des PC-Runners ohne Docker: Die Agents laufen ohne Rückfragen mit den Rechten des Benutzers, unter dem der
 * Runner läuft. Liegen in dessen Home-Verzeichnis persönliche Zugangsdaten oder Browser-Profile, könnten die Agents
 * sie lesen. Empfohlen ist deshalb ein **eigenes Benutzerkonto nur für den Runner** (siehe runner/README.md,
 * „Sicherheit ohne Docker“).
 *
 * `personalDataFindings` sucht nur nach dem Vorhandensein typischer Pfade (Inhalte werden nie gelesen) und liefert
 * Fundstellen für einen Hinweis in `probe`, `install` und beim Start. Was der Runner selbst braucht (gh-Login,
 * CLI-Logins der Konten), zählt nicht als Fund.
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface IsolationFinding {
	/** kurze Beschreibung, z. B. „SSH-Schlüssel“ */
	label: string;
	/** gefundener Pfad zur Anzeige (`~/…` bzw. `%USERPROFILE%\…`) */
	path: string;
}

export interface IsolationFs {
	exists(p: string): boolean;
	list(p: string): string[];
}

const realFs: IsolationFs = {
	exists: (p) => existsSync(p),
	list: (p) => {
		try {
			return readdirSync(p);
		} catch {
			return [];
		}
	}
};

interface Candidate {
	label: string;
	/** Pfadteile relativ zum Home-Verzeichnis */
	parts: string[];
	platforms?: NodeJS.Platform[];
}

const CANDIDATES: Candidate[] = [
	{ label: 'Cloud-Zugangsdaten (AWS)', parts: ['.aws', 'credentials'] },
	{ label: 'Cloud-Zugangsdaten (Azure)', parts: ['.azure'] },
	{ label: 'Cloud-Zugangsdaten (Google Cloud)', parts: ['.config', 'gcloud'] },
	{ label: 'Kubernetes-Zugang', parts: ['.kube', 'config'] },
	{ label: 'GnuPG-Schlüssel', parts: ['.gnupg'] },
	{ label: 'Docker-Anmeldung', parts: ['.docker', 'config.json'] },
	{ label: 'npm-Token', parts: ['.npmrc'] },
	// Browser-Profile (Cookies, gespeicherte Passwörter)
	{ label: 'Browser-Profil (Chrome)', parts: ['AppData', 'Local', 'Google', 'Chrome', 'User Data'], platforms: ['win32'] },
	{ label: 'Browser-Profil (Edge)', parts: ['AppData', 'Local', 'Microsoft', 'Edge', 'User Data'], platforms: ['win32'] },
	{ label: 'Browser-Profil (Firefox)', parts: ['AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'], platforms: ['win32'] },
	{ label: 'Browser-Profil (Chrome)', parts: ['Library', 'Application Support', 'Google', 'Chrome'], platforms: ['darwin'] },
	{ label: 'Browser-Profil (Safari)', parts: ['Library', 'Safari'], platforms: ['darwin'] },
	{ label: 'Browser-Profil (Firefox)', parts: ['Library', 'Application Support', 'Firefox', 'Profiles'], platforms: ['darwin'] },
	{ label: 'Browser-Profil (Chrome)', parts: ['.config', 'google-chrome'], platforms: ['linux'] },
	{ label: 'Browser-Profil (Chromium)', parts: ['.config', 'chromium'], platforms: ['linux'] },
	{ label: 'Browser-Profil (Firefox)', parts: ['.mozilla', 'firefox'], platforms: ['linux'] }
];

/** Typische persönliche Daten im Home-Verzeichnis, die Agents ohne Docker lesen könnten (nur Existenzprüfung) */
export function personalDataFindings(
	home: string = os.homedir(),
	platform: NodeJS.Platform = process.platform,
	fs: IsolationFs = realFs
): IsolationFinding[] {
	const p = platform === 'win32' ? path.win32 : path.posix;
	const show = (rel: string) => (platform === 'win32' ? `%USERPROFILE%\\${rel}` : `~/${rel}`);
	const found: IsolationFinding[] = [];
	// SSH: nur private Schlüssel zählen (known_hosts/config allein sind unkritisch); der Runner selbst nutzt HTTPS + gh
	const sshDir = p.join(home, '.ssh');
	const keys = fs.list(sshDir).filter((f) => /^id_[a-z0-9_]+$/i.test(f));
	if (keys.length) found.push({ label: 'SSH-Schlüssel', path: show(p.join('.ssh', keys[0]!)) });
	for (const c of CANDIDATES) {
		if (c.platforms && !c.platforms.includes(platform)) continue;
		if (fs.exists(p.join(home, ...c.parts))) found.push({ label: c.label, path: show(p.join(...c.parts)) });
	}
	return found;
}

/** Hinweistext (mehrzeilig) oder `null`, wenn nichts gefunden wurde */
export function isolationHint(findings: IsolationFinding[], user: string = safeUser()): string | null {
	if (!findings.length) return null;
	const list = findings.map((f) => `    - ${f.label}: ${f.path}`);
	return [
		`Die Agents laufen ohne Docker mit den Rechten von „${user}“ und könnten persönliche Daten lesen:`,
		...list,
		'  Empfehlung: den Runner unter einem eigenen Benutzerkonto nur für den Runner betreiben (eigene CLI-Logins,',
		'  eigenes gh-Token) oder Docker verwenden – siehe README, Abschnitt „Sicherheit ohne Docker“.'
	].join('\n');
}

function safeUser(): string {
	try {
		return os.userInfo().username;
	} catch {
		return 'diesem Benutzer';
	}
}
