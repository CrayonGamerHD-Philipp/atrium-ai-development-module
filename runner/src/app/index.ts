/**
 * `atrium-runner app [--background]`: PC-Oberfläche starten – lokaler Server (`server.ts`), Tray-Symbol (`tray.ts`)
 * und App-Fenster (`desktop-open.ts`). Je Benutzer läuft höchstens eine Oberfläche: Ein weiterer Aufruf öffnet nur
 * ein Fenster der laufenden (Adresse und Token in `app.json` im Datenverzeichnis, Rechte 0600).
 *
 * `--background` (Autostart): ohne Fenster starten, nur Tray. Die Oberfläche steuert den Runner, ist aber nicht der
 * Runner – beendet man sie, läuft er weiter.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopConfigPath, selfCommand } from '../desktop/cli.ts';
import { desktopPaths } from '../desktop/paths.ts';
import { openAppWindow } from './desktop-open.ts';
import { appFileOf, existingLaunchUrl, type AppFile } from './instance.ts';
import { RunnerOps } from './ops.ts';
import { appPage } from './page.ts';
import { AppServer } from './server.ts';
import { startTray, type TrayCommand } from './tray.ts';

export async function runApp(rest: string[], configPath: string | undefined): Promise<number> {
	const background = rest.includes('--background');
	const paths = desktopPaths();
	const configFile = desktopConfigPath(configPath);
	const profileDir = path.join(paths.dataDir, 'ui-profile');
	await mkdir(paths.dataDir, { recursive: true });

	const running = await existingLaunchUrl(paths.dataDir);
	if (running) {
		if (!background) await openAppWindow(running, profileDir);
		return 0;
	}

	const token = randomBytes(32).toString('base64url');
	let server: AppServer | null = null;
	let tray: Awaited<ReturnType<typeof startTray>> = null;
	let quitting = false;
	const done = new Promise<void>((resolve) => {
		const quit = () => {
			if (quitting) return;
			quitting = true;
			void (async () => {
				await tray?.stop().catch(() => undefined);
				await server?.close().catch(() => undefined);
				await rm(appFileOf(paths.dataDir), { force: true }).catch(() => undefined);
				resolve();
			})();
		};
		const ops = new RunnerOps({ configFile, paths, onQuit: quit });
		server = new AppServer({ ops, token, page: appPage() });
		process.once('SIGINT', quit);
		process.once('SIGTERM', quit);
		void (async () => {
			const port = await server!.listen();
			const file = appFileOf(paths.dataDir);
			await writeFile(file, JSON.stringify({ pid: process.pid, port, token } satisfies AppFile), { mode: 0o600 });
			if (process.platform !== 'win32') await chmod(file, 0o600).catch(() => undefined);
			const open = () =>
				openAppWindow(server!.launchUrl(), profileDir).catch((e: unknown) =>
					process.stderr.write(`${(e as Error).message}\n`)
				);
			const onTray = (cmd: TrayCommand) => {
				if (cmd === 'open') void open();
				else if (cmd === 'quit') quit();
				else void ops.action(cmd);
			};
			tray = await startTray({ exe: (await selfCommand()).exe, onCommand: onTray });
			process.stdout.write(`Atrium-Runner-Oberfläche: ${server!.url} (Tray: ${tray ? 'an' : 'nicht verfügbar'})\n`);
			// ohne Tray (Linux) bliebe ein Hintergrundstart unsichtbar → dann Fenster öffnen
			if (!background || !tray) await open();
		})().catch((e: unknown) => {
			process.stderr.write(`Oberfläche konnte nicht starten: ${(e as Error).message}\n`);
			quit();
		});
	});
	await done;
	return 0;
}
