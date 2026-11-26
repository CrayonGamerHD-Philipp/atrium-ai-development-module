import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	compareVersions,
	handoversOf,
	handoverText,
	isUpdateAvailable,
	runnerStateOf,
	type HandoverRun
} from '../../handover';
import { fenceProblem, leaseProblem } from '../../leases';
import { RUNNER_RELEASE_VERSION } from '../../runner-release';

const run = (over: Partial<HandoverRun>): HandoverRun => ({
	id: 'r1',
	status: 'succeeded',
	errorKind: null,
	runnerName: 'pc-philipp',
	runnerKind: 'desktop',
	startedAt: '2026-11-26T10:00:00Z',
	createdAt: '2026-11-26T10:00:00Z',
	handoff: null,
	hasWip: false,
	...over
});

describe('Übergaben im Auftragsverlauf', () => {
	it('geordnete Übergabe: von PC-Runner an den nächsten gestarteten Lauf', () => {
		const map = handoversOf([
			run({
				id: 'r1',
				status: 'cancelled',
				handoff: { reason: 'suspend', wipPushed: true }
			}),
			// nie gestartet (Angebot verfallen) → zählt nicht als Übernahme
			run({
				id: 'r2',
				status: 'lost',
				startedAt: null,
				runnerName: 'srv-a',
				runnerKind: 'server',
				createdAt: '2026-11-26T10:01:00Z'
			}),
			run({
				id: 'r3',
				status: 'running',
				runnerName: 'srv-b',
				runnerKind: 'server',
				createdAt: '2026-11-26T10:02:00Z'
			})
		]);
		const h = map.get('r1')!;
		expect(h).toMatchObject({
			reason: 'suspend',
			toRunner: 'srv-b',
			toKind: 'server',
			wipPushed: true
		});
		expect(handoverText(h)).toBe(
			'Übergeben von PC-Runner pc-philipp an Server-Runner srv-b (Grund: Standby)'
		);
		expect(map.has('r2')).toBe(false);
	});
	it('Verbindungsverlust zählt als Übergabe, ohne Nachfolger ohne Ziel', () => {
		const map = handoversOf([
			run({ id: 'x', status: 'lost', errorKind: 'connection', hasWip: true })
		]);
		const h = map.get('x')!;
		expect(h).toMatchObject({ reason: 'connection', toRunner: null, wipPushed: true });
		expect(handoverText(h)).toBe('Übergeben von PC-Runner pc-philipp (Grund: Verbindungsverlust)');
	});
	it('gewöhnliche Abbrüche sind keine Übergabe', () => {
		expect(
			handoversOf([run({ status: 'cancelled' }), run({ id: 'y', status: 'failed' })]).size
		).toBe(0);
	});
});

describe('Anzeige-Zustand der Runner', () => {
	const base = {
		status: 'approved',
		online: true,
		handoverReason: null,
		returnedAt: null,
		now: 1_000_000,
		returnedShowMs: 60_000
	};
	it.each([
		[{}, 'active'],
		[{ status: 'pending' }, 'pending'],
		[{ status: 'disabled' }, 'disabled'],
		[{ handoverReason: 'suspend' }, 'handover'],
		[{ handoverReason: 'suspend', online: false }, 'standby'],
		[{ handoverReason: 'shutdown', online: false }, 'offline'],
		[{ online: false }, 'offline'],
		[{ returnedAt: 990_000 }, 'returned'],
		[{ returnedAt: 100_000 }, 'active']
	] as const)('%o → %s', (over, state) => {
		expect(runnerStateOf({ ...base, ...over })).toBe(state);
	});
});

describe('Leases und Fencing', () => {
	const row = (over: Record<string, unknown> = {}) => ({
		status: 'running',
		runner_id: 'pc',
		fence: 3,
		lease_epoch: 3,
		expired: false,
		...over
	});
	it('gültig: eigener, laufender Lauf mit aktuellem Token', () => {
		expect(leaseProblem(row(), 'pc', 3)).toBeNull();
		// ältere Runner ohne Token: nur Zustand und Lease zählen
		expect(leaseProblem(row(), 'pc')).toBeNull();
	});
	it('aufgewachter PC: übernommener Lauf, neu vergebener Auftrag oder abgelaufene Lease → ungültig', () => {
		expect(leaseProblem(row({ status: 'lost' }), 'pc', 3)).toMatch(/übernommen/);
		expect(leaseProblem(row({ lease_epoch: 4 }), 'pc', 3)).toMatch(/neu vergeben/);
		expect(leaseProblem(row({ expired: true }), 'pc', 3)).toMatch(/abgelaufen/);
		expect(leaseProblem(row({ runner_id: 'srv' }), 'pc', 3)).toMatch(/gehört nicht/);
		expect(leaseProblem(null, 'pc', 3)).toMatch(/gehört nicht/);
		expect(leaseProblem(row({ status: 'cancelled' }), 'pc', 3)).toMatch(/beendet/);
	});
	it('veraltetes Token', () => {
		expect(fenceProblem(row({ fence: 4, lease_epoch: 4 }), 3)).toMatch(/Veraltetes/);
		expect(fenceProblem(row({ fence: null, lease_epoch: 0 }), 1)).toBeNull();
	});
});

describe('Versionen', () => {
	it('vergleicht semantisch inkl. Vorabversionen', () => {
		expect(compareVersions('0.3.0', '0.4.0')).toBeLessThan(0);
		expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
		expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
		expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
	});
	it('Update-Hinweis nur für ältere, echte Versionen', () => {
		expect(isUpdateAvailable('0.3.0', '0.4.0')).toBe(true);
		expect(isUpdateAvailable('0.4.0', '0.4.0')).toBe(false);
		expect(isUpdateAvailable('0.3.0-dev', '0.4.0')).toBe(false);
		expect(isUpdateAvailable('', '0.4.0')).toBe(false);
	});
	it('mit dem Modul ausgelieferte Runner-Version = runner/package.json', () => {
		const pkg = JSON.parse(
			readFileSync(new URL('../../../../runner/package.json', import.meta.url), 'utf8')
		) as { version: string };
		expect(RUNNER_RELEASE_VERSION).toBe(pkg.version);
	});
});
