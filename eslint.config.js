// ESLint des Module-Repos = Konfiguration des Core (Modulgrenzen, Core-Interna, Svelte/TS-Regeln),
// Muster relativ zu diesem Ordner. Umgebung zuerst setzen, dann die Core-Konfiguration laden.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
process.env.ATRIUM_ESLINT_ROOT = root;
process.env.ATRIUM_MODULES_DIR ??= join(root, 'modules');

const coreConfig = (await import('./.core/eslint.config.js')).default;

// Core-Fehler (v2.0.0-pre.2): Bei nur EINEM Modul im Verzeichnis entsteht für „relative Importe in andere Module“ ein
// Muster mit leerem `group: []`, an dem `@typescript-eslint/no-restricted-imports` beim Laden scheitert. Leere Muster
// entfernen (ändert nichts an der Prüfung – es gibt keine anderen Module, in die man importieren könnte).
const RULE = '@typescript-eslint/no-restricted-imports';
const core = coreConfig.map((block) => {
	const rule = block.rules?.[RULE];
	if (!Array.isArray(rule) || typeof rule[1] !== 'object' || !rule[1]?.patterns) return block;
	const patterns = rule[1].patterns.filter((p) => !(Array.isArray(p.group) && p.group.length === 0));
	return { ...block, rules: { ...block.rules, [RULE]: [rule[0], { ...rule[1], patterns }] } };
});

export default [
	...core,
	{
		ignores: [
			'.core/',
			'runner/',
			'modules/node_modules/',
			'.data/',
			'test-results/',
			'playwright-report/'
		]
	}
];
