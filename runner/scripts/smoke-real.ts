// Manueller Rauchtest gegen die echten CLIs (nicht Teil von `npm test`): npx tsx scripts/smoke-real.ts <claude|codex> <cwd>
import { accountConfigSchema, accountEnv } from '../src/config.ts';
import { defaultAdapters } from '../src/providers/index.ts';

const provider = (process.argv[2] ?? 'claude') as 'claude' | 'codex';
const cwd = process.argv[3] ?? process.cwd();
const account = accountConfigSchema.parse({ key: `${provider}-smoke`, provider });
const adapter = defaultAdapters[provider];
console.log('probe', await adapter.probe(account, accountEnv(account)));
const proc = adapter.start({
	cwd,
	prompt: 'Antworte nur mit dem Wort OK.\nZweite Zeile mit "Anführungszeichen" & Sonderzeichen | < >.',
	systemPrompt: 'Mehrzeilige Systemanweisung:\n- antworte knapp\n- "Zitat" & | < >',
	model: provider === 'claude' ? 'haiku' : null,
	resumeSessionId: null,
	env: accountEnv(account),
	readOnly: true,
	signal: new AbortController().signal,
	account,
	tmpDir: cwd + '/.tmp-smoke'
});
for await (const ev of proc.events) console.log('event', JSON.stringify(ev).slice(0, 200));
console.log('done', await proc.done);
