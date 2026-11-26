/**
 * Laufende Oberfläche dieses Benutzers (`app.json` im Datenverzeichnis: PID, Port, Token; Rechte 0600) – für einen
 * zweiten Aufruf von `atrium-runner app` (Fenster der laufenden öffnen) und für `uninstall` (Oberfläche beenden,
 * damit das Programm nicht mehr in Benutzung ist).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface AppFile {
	pid: number;
	port: number;
	token: string;
}

export const TOKEN_HEADER = 'x-runner-token';

export const appFileOf = (dataDir: string) => path.join(dataDir, 'app.json');

async function readAppFile(dataDir: string): Promise<AppFile | null> {
	try {
		return JSON.parse(await readFile(appFileOf(dataDir), 'utf8')) as AppFile;
	} catch {
		return null;
	}
}

async function callApp(info: AppFile, apiPath: string): Promise<Response | null> {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 2000);
		const r = await fetch(`http://127.0.0.1:${info.port}${apiPath}`, {
			method: 'POST',
			headers: { [TOKEN_HEADER]: info.token },
			signal: ctrl.signal
		});
		clearTimeout(t);
		return r.ok ? r : null;
	} catch {
		return null;
	}
}

/** Fensteradresse (mit frischem Einmal-Code) der laufenden Oberfläche, sonst `null` */
export async function existingLaunchUrl(dataDir: string): Promise<string | null> {
	const info = await readAppFile(dataDir);
	const r = info ? await callApp(info, '/api/launch-url') : null;
	return r ? ((await r.json()) as { url: string }).url : null;
}

/** Laufende Oberfläche beenden; `true`, wenn eine lief */
export async function quitRunningApp(dataDir: string): Promise<boolean> {
	const info = await readAppFile(dataDir);
	if (!info) return false;
	const r = await callApp(info, '/api/quit');
	if (!r) return false;
	// kurz warten, bis der Prozess weg ist (Dateien frei für Deinstallation/Update)
	for (let i = 0; i < 20; i++) {
		try {
			process.kill(info.pid, 0);
		} catch {
			return true;
		}
		await new Promise((res) => setTimeout(res, 150));
	}
	return true;
}
