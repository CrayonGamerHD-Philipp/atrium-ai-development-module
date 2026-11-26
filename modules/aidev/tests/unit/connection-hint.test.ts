import { describe, expect, it } from 'vitest';
import {
	connectionLostHint,
	newestRunsFirst,
	offerRestartAtLostRun
} from '../../pages/task/connection';

it('erkennt den neuesten Lauf auch nach einem Neustart mit zurückgesetzter Versuchsnummer', () => {
	const runs = [
		{ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', attempt: 3 },
		{ id: 'b', createdAt: '2026-01-02T00:00:00.000Z', attempt: 1 },
		{ id: 'c', createdAt: '2026-01-02T00:00:00.000Z', attempt: 1 }
	];
	const latest = newestRunsFirst(runs)[0];
	expect(latest?.id).toBe('c');
	expect(offerRestartAtLostRun({ taskStatus: 'failed', latest: latest?.id === 'c' }, true)).toBe(
		true
	);
	expect(runs[0]?.id).toBe('a');
});

describe('connectionLostHint', () => {
	it('neuester Lauf, Auftrag wartend/laufend → automatisch neu eingeplant', () => {
		expect(connectionLostHint({ taskStatus: 'queued', latest: true })).toMatch(
			/automatisch neu eingeplant/
		);
		expect(connectionLostHint({ taskStatus: 'running', latest: true })).toMatch(
			/automatisch neu eingeplant/
		);
	});

	it('nach dem letzten erlaubten Verlust (failed) → kein „automatisch“, sondern Hinweis auf „Neu starten“', () => {
		const t = connectionLostHint({ taskStatus: 'failed', latest: true });
		expect(t).not.toMatch(/wird automatisch neu eingeplant/);
		expect(t).toMatch(/Neu starten/);
	});

	it('abgebrochen oder älterer Lauf → keine falsche Zusage', () => {
		expect(connectionLostHint({ taskStatus: 'cancelled', latest: true })).not.toMatch(
			/automatisch/
		);
		expect(connectionLostHint({ taskStatus: 'failed', latest: false })).toMatch(
			/danach neu eingeplant/
		);
	});
});

describe('offerRestartAtLostRun', () => {
	it('nur am neuesten Lauf, mit Recht und wenn nicht ohnehin neu eingeplant wird', () => {
		expect(offerRestartAtLostRun({ taskStatus: 'failed', latest: true }, true)).toBe(true);
		expect(offerRestartAtLostRun({ taskStatus: 'failed', latest: true }, false)).toBe(false);
		expect(offerRestartAtLostRun({ taskStatus: 'failed', latest: false }, true)).toBe(false);
		expect(offerRestartAtLostRun({ taskStatus: 'queued', latest: true }, true)).toBe(false);
		expect(offerRestartAtLostRun({ taskStatus: 'running', latest: true }, true)).toBe(false);
	});
});
