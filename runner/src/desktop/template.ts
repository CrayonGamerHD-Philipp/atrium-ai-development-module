/** Konfigurationsvorlage für den PC-Runner (`atrium-runner install` legt sie an, falls noch keine existiert). */

export function desktopConfigTemplate(o: { name: string; workDir: string }): string {
	const config = {
		atriumUrl: 'https://atrium.example.org',
		apiKey: 'API-KEY-EINTRAGEN',
		name: o.name,
		kind: 'desktop',
		workDir: o.workDir,
		maxSlots: 2,
		handoverSec: 20,
		wipCheckpointMin: 10,
		accounts: [
			{ key: 'claude-pc', provider: 'claude', label: 'Claude (PC)' },
			{ key: 'codex-pc', provider: 'codex', label: 'Codex (PC)' }
		]
	};
	return `${JSON.stringify(config, null, 2)}\n`;
}
