import { describe, expect, it } from 'vitest';
import { sanitizeAttachmentName, uniqueAttachmentNames } from '../../attachments.service';
import { buildTaskPrompt, type PromptContext } from '../../prompts';
import { uniqueAttachmentNames as runnerNames } from '../../protocol';

const RAW = [
	'con.txt',
	'Bild.png',
	'bild.png',
	'image.png',
	'image.png',
	'.env',
	'Größe & Maße?.pdf',
	`${'n'.repeat(300)}.md`,
	'LPT1',
	'..'
];

describe('gemeinsame Namensregel Atrium ↔ Runner', () => {
	it('Atrium vergibt Namen, die der Runner unverändert übernimmt', () => {
		const stored = RAW.map((n) => ({ name: sanitizeAttachmentName(n) }));
		const offered = uniqueAttachmentNames(stored).map((r) => String(r.name));
		// Der Runner bildet aus den angebotenen Namen die Dateinamen der Ablage
		expect(runnerNames(offered)).toEqual(offered);
		expect(offered.slice(0, 5)).toEqual([
			'_con.txt',
			'Bild.png',
			'bild-2.png',
			'image.png',
			'image-2.png'
		]);
		expect(offered).toContain('_LPT1');
		for (const n of offered) expect(n.length).toBeLessThanOrEqual(120);
	});

	it('auch für bereits gespeicherte Altnamen (z. B. `con.txt`) gilt im Angebot die gemeinsame Regel', () => {
		const offered = uniqueAttachmentNames([{ name: 'con.txt' }, { name: 'a.txt' }]).map((r) =>
			String(r.name)
		);
		expect(offered).toEqual(['_con.txt', 'a.txt']);
		expect(runnerNames(offered)).toEqual(offered);
	});

	it('der Prompt nennt genau die Pfade der Ablage', () => {
		const offered = uniqueAttachmentNames([{ name: 'shot.png' }, { name: 'Shot.png' }]).map((r) =>
			String(r.name)
		);
		const prompt = buildTaskPrompt({
			role: 'implement',
			project: {
				name: 'P',
				repoOwner: 'o',
				repoName: 'r',
				defaultBranch: 'main',
				instructions: '',
				testCmd: ''
			},
			task: { title: 'T', prompt: 'P' },
			readOnly: false,
			expectPlan: false,
			dependencyResults: [],
			replies: [],
			parent: null,
			conflictFiles: [],
			previousError: null,
			attachments: offered.map((name) => ({ name, mime: 'image/png', size: 1 }))
		} satisfies PromptContext);
		for (const name of runnerNames(offered)) {
			expect(prompt).toContain(`\`.aidev/attachments/${name}\``);
		}
	});
});
