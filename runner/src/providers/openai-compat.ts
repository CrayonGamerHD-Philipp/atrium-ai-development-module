/**
 * OpenAI-kompatible API (z. B. vLLM, LiteLLM, OpenRouter, Azure): nutzt die Agent-Schleife der Codex-CLI mit einem
 * eigenen Modell-Anbieter je Konto. Konfiguration über `-c` (Codex `config.toml`-Schlüssel):
 *
 *   model_provider="<key>"
 *   model_providers.<key>.name="<label>"
 *   model_providers.<key>.base_url="<baseUrl>"
 *   model_providers.<key>.env_key="<apiKeyEnv>"
 *   model_providers.<key>.wire_api="responses"   (Codex 0.164 lehnt "chat" ab)
 *
 * Für jedes Konto sollte `home` gesetzt sein (eigenes `CODEX_HOME`), damit keine ChatGPT-Anmeldung vermischt wird.
 */
import type { AccountConfig } from '../config.ts';
import { startCodex, tomlString } from './codex.ts';
import { probeFailed, probeVersion } from './process.ts';
import type { AgentProcess, ProbeResult, ProviderAdapter, StartOptions } from './types.ts';

/** `model_provider`-Schlüssel (TOML-Bare-Key) aus dem Kontoschlüssel */
export function providerKey(acct: AccountConfig): string {
	return `aidev_${acct.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export function openAiConfigArgs(acct: AccountConfig): string[] {
	const k = providerKey(acct);
	return [
		`model_provider=${tomlString(k)}`,
		`model_providers.${k}.name=${tomlString(acct.label || acct.key)}`,
		`model_providers.${k}.base_url=${tomlString(acct.baseUrl ?? '')}`,
		`model_providers.${k}.env_key=${tomlString(acct.apiKeyEnv ?? '')}`,
		`model_providers.${k}.wire_api=${tomlString(acct.wireApi)}`
	];
}

export const openAiCompatAdapter: ProviderAdapter = {
	id: 'openai-api',
	async probe(acct: AccountConfig, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
		const v = await probeVersion(acct.command ?? 'codex', env);
		if (!v.ok) return probeFailed(v.message ?? 'codex nicht gefunden');
		const key = acct.apiKeyEnv ? env[acct.apiKeyEnv] : undefined;
		return {
			ok: true,
			loggedIn: Boolean(key),
			version: v.version,
			message: key ? undefined : `Umgebungsvariable ${acct.apiKeyEnv ?? '?'} ist nicht gesetzt`
		};
	},
	start(o: StartOptions): AgentProcess {
		return startCodex(o, {
			provider: 'openai-api',
			configArgs: openAiConfigArgs(o.account),
			model: o.model ?? o.account.model ?? null
		});
	}
};
