/**
 * Plan aus der Agent-Ausgabe lesen – gleiche Regeln wie Atrium (`modules/aidev/prompts.ts`): letzter
 * ```json-Block (bzw. ohne Sprache), der `planSchema` erfüllt; sonst letztes balanciertes `{…}`. Atrium prüft erneut.
 */
import { planSchema, type Plan } from './protocol.ts';

function fencedBlocks(text: string): string[] {
	const out: string[] = [];
	const re = /```([A-Za-z0-9_+-]*)[^\S\r\n]*\r?\n([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const lang = (m[1] ?? '').toLowerCase();
		if (lang === '' || lang === 'json' || lang === 'jsonc' || lang === 'json5') out.push(m[2] ?? '');
	}
	return out;
}

function lastBalancedObject(text: string): string | null {
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	let last: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (depth > 0 && ch === '"') inString = true;
		else if (ch === '{') {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === '}' && depth > 0) {
			depth--;
			if (depth === 0) last = text.slice(start, i + 1);
		}
	}
	return last;
}

function validatePlan(raw: string): Plan | null {
	let data: unknown;
	try {
		data = JSON.parse(raw.trim());
	} catch {
		return null;
	}
	const parsed = planSchema.safeParse(data);
	if (!parsed.success) return null;
	const plan = parsed.data;
	const keys = new Set<string>();
	for (const s of plan.subtasks) {
		if (keys.has(s.key)) return null;
		keys.add(s.key);
	}
	return {
		...plan,
		subtasks: plan.subtasks.map((s) => ({
			...s,
			dependsOn: [...new Set(s.dependsOn)].filter((d) => d !== s.key && keys.has(d))
		}))
	};
}

export function extractPlan(text: string): Plan | null {
	if (!text) return null;
	const blocks = fencedBlocks(text);
	for (let i = blocks.length - 1; i >= 0; i--) {
		const plan = validatePlan(blocks[i] ?? '');
		if (plan) return plan;
	}
	const raw = lastBalancedObject(text);
	return raw ? validatePlan(raw) : null;
}
