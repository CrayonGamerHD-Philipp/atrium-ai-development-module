/** Zuordnung Anbieter → Adapter */
import type { Provider } from '../protocol.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { fakeAdapter } from './fake.ts';
import { geminiAdapter } from './gemini.ts';
import { openAiCompatAdapter } from './openai-compat.ts';
import type { ProviderAdapter } from './types.ts';

export type AdapterRegistry = Record<Provider, ProviderAdapter>;

export const defaultAdapters: AdapterRegistry = {
	claude: claudeAdapter,
	codex: codexAdapter,
	gemini: geminiAdapter,
	'openai-api': openAiCompatAdapter,
	fake: fakeAdapter
};
