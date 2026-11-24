import { describe, expect, it } from 'vitest';
import { extractPlan } from '../src/plan.ts';
import { FAKE_PLAN } from '../src/providers/fake.ts';

const valid = JSON.stringify(FAKE_PLAN);

describe('extractPlan', () => {
	it('liest den letzten gültigen ```json-Block', () => {
		const text = `Erst ein Beispiel:\n\`\`\`json\n{"foo":1}\n\`\`\`\n\nDer Plan:\n\`\`\`json\n${valid}\n\`\`\`\n`;
		expect(extractPlan(text)?.subtasks).toHaveLength(2);
	});

	it('nimmt den letzten gültigen Block, wenn danach ein ungültiger folgt', () => {
		const text = `\`\`\`json\n${valid}\n\`\`\`\n\`\`\`json\n{"subtasks":[]}\n\`\`\``;
		expect(extractPlan(text)?.summary).toBe(FAKE_PLAN.summary);
	});

	it('akzeptiert Blöcke ohne Sprache und rohe Objekte', () => {
		expect(extractPlan(`\`\`\`\n${valid}\n\`\`\``)).not.toBeNull();
		expect(extractPlan(`Hier: ${valid} – fertig.`)).not.toBeNull();
	});

	it('ignoriert andere Sprachen und ungültige Pläne', () => {
		expect(extractPlan(`\`\`\`ts\n${valid}\n\`\`\``)).not.toBeNull(); // rohes Objekt im Text greift
		expect(extractPlan('kein Plan')).toBeNull();
		expect(extractPlan('```json\n{"subtasks":[{"key":"a"}]}\n```')).toBeNull();
	});

	it('lehnt doppelte Keys ab und filtert unbekannte Abhängigkeiten', () => {
		const dup = { subtasks: [FAKE_PLAN.subtasks[0], FAKE_PLAN.subtasks[0]] };
		expect(extractPlan(JSON.stringify(dup))).toBeNull();
		const deps = {
			subtasks: [{ ...FAKE_PLAN.subtasks[1], dependsOn: ['gibt-es-nicht', 'impl'] }]
		};
		expect(extractPlan(JSON.stringify(deps))?.subtasks[0]?.dependsOn).toEqual([]);
	});

	it('beachtet geschweifte Klammern in Zeichenketten', () => {
		const p = { ...FAKE_PLAN, summary: 'Mit } und { im Text' };
		expect(extractPlan(`Plan: ${JSON.stringify(p)}`)?.summary).toBe('Mit } und { im Text');
	});
});
