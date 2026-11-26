/**
 * Prüfung der externen Programme (nicht im Runner enthalten): git, gh und die Agent-CLIs der konfigurierten Konten.
 * `probe` nennt fehlende Programme mit Installationshinweis je Betriebssystem.
 */
import type { Provider } from '../protocol.ts';
import { exec } from '../util/proc.ts';

export interface ToolCheck {
	name: string;
	command: string;
	ok: boolean;
	version: string;
	hint: string;
	required: boolean;
}

const HINTS: Record<string, Partial<Record<NodeJS.Platform | 'default', string>>> = {
	git: {
		win32: 'winget install --id Git.Git -e',
		darwin: 'xcode-select --install  (oder: brew install git)',
		default: 'sudo apt install git  (bzw. dnf/pacman)'
	},
	gh: {
		win32: 'winget install --id GitHub.cli -e, danach: gh auth login',
		darwin: 'brew install gh, danach: gh auth login',
		default: 'https://github.com/cli/cli#installation, danach: gh auth login'
	},
	claude: { default: 'npm install -g @anthropic-ai/claude-code, danach: atrium-runner login <konto>' },
	codex: { default: 'npm install -g @openai/codex, danach: atrium-runner login <konto>' },
	gemini: { default: 'npm install -g @google/gemini-cli, danach: atrium-runner login <konto>' }
};

export function installHint(tool: string, platform: NodeJS.Platform = process.platform): string {
	const h = HINTS[tool];
	if (!h) return '';
	return h[platform] ?? h.default ?? '';
}

async function version(command: string): Promise<{ ok: boolean; version: string }> {
	// ohne Shell: `exec` mit `shell: true` verwirft die Argumente; `.cmd`-Shims löst cross-spawn auch so auf
	const r = await exec(command, ['--version'], { timeoutMs: 15_000 });
	if (r.spawnError || r.code !== 0) return { ok: false, version: '' };
	return { ok: true, version: (r.stdout || r.stderr).trim().split('\n')[0]?.slice(0, 120) ?? '' };
}

/** git, gh und die CLIs der Konten (`fake`/`openai-api` brauchen keine eigene CLI außer codex) */
export async function checkTools(
	accounts: { provider: Provider; command?: string }[]
): Promise<ToolCheck[]> {
	const wanted = new Map<string, { command: string; required: boolean }>([
		['git', { command: 'git', required: true }],
		['gh', { command: 'gh', required: false }]
	]);
	for (const a of accounts) {
		if (a.provider === 'fake') continue;
		const name = a.provider === 'openai-api' ? 'codex' : a.provider;
		if (!wanted.has(name)) wanted.set(name, { command: a.command ?? name, required: true });
	}
	return Promise.all(
		[...wanted].map(async ([name, w]) => {
			const v = await version(w.command);
			return { name, command: w.command, ...v, hint: installHint(name), required: w.required };
		})
	);
}
