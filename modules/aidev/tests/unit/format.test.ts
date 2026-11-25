import { describe, it, expect } from 'vitest';
import { atDayClock, dayClock, dayClockParts } from '../../pages/datetime';

// Zeitpunkte über lokale Konstruktoren, formatiert in der lokalen Zeitzone des Testprozesses
const LOCAL = Intl.DateTimeFormat().resolvedOptions().timeZone;
const NOW = new Date(2026, 10, 25, 10, 0).getTime();
const iso = (...a: [number, number, number, number, number]) => new Date(...a).toISOString();

describe('dayClock', () => {
	it('liefert für leere oder ungültige Werte einen Leerstring', () => {
		expect(dayClock(null, NOW, LOCAL)).toBe('');
		expect(dayClock(undefined, NOW, LOCAL)).toBe('');
		expect(dayClock('', NOW, LOCAL)).toBe('');
		expect(dayClock('kein Datum', NOW, LOCAL)).toBe('');
		expect(dayClockParts('kein Datum', NOW, LOCAL)).toBeNull();
		expect(atDayClock(null, NOW, LOCAL)).toBe('');
	});

	it('zeigt „heute“ am selben Kalendertag', () => {
		expect(dayClock(iso(2026, 10, 25, 14, 30), NOW, LOCAL)).toBe('heute 14:30');
		expect(dayClock(iso(2026, 10, 25, 23, 59), NOW, LOCAL)).toBe('heute 23:59');
		expect(atDayClock(iso(2026, 10, 25, 14, 30), NOW, LOCAL)).toBe('heute um 14:30');
	});

	it('zeigt „morgen“ am nächsten Kalendertag, auch über Mitternacht', () => {
		expect(dayClock(iso(2026, 10, 26, 9, 0), NOW, LOCAL)).toBe('morgen 09:00');
		const lateNow = new Date(2026, 10, 25, 23, 50).getTime();
		expect(dayClock(iso(2026, 10, 26, 0, 10), lateNow, LOCAL)).toBe('morgen 00:10');
		expect(atDayClock(iso(2026, 10, 26, 9, 0), NOW, LOCAL)).toBe('morgen um 09:00');
	});

	it('zeigt sonst Wochentag und Datum ohne Jahr', () => {
		const p = dayClockParts(iso(2026, 11, 1, 9, 0), NOW, LOCAL);
		expect(p?.relative).toBe(false);
		expect(p?.time).toBe('09:00');
		expect(p?.day).toMatch(/^Di\.?,? /);
		expect(p?.day).toContain('01.12');
		expect(p?.day).not.toContain('2026');
		expect(dayClock(iso(2026, 11, 1, 9, 0), NOW, LOCAL)).toMatch(/01\.12\.? 09:00$/);
		expect(atDayClock(iso(2026, 11, 1, 9, 0), NOW, LOCAL)).toMatch(/^am Di.*01\.12.* um 09:00$/);
	});

	it('zeigt vergangene Tage ebenfalls mit Datum', () => {
		const p = dayClockParts(iso(2026, 10, 24, 9, 0), NOW, LOCAL);
		expect(p?.relative).toBe(false);
		expect(p?.day).toContain('24.11');
	});

	it('zeigt das Jahr nur, wenn es nicht das aktuelle ist', () => {
		const p = dayClockParts(iso(2027, 0, 4, 8, 15), NOW, LOCAL);
		expect(p?.day).toMatch(/^Mo/);
		expect(p?.day).toContain('04.01.2027');
		expect(p?.time).toBe('08:15');
	});

	it('akzeptiert `now` auch als Date', () => {
		expect(dayClock(iso(2026, 10, 25, 14, 30), new Date(NOW), LOCAL)).toBe('heute 14:30');
	});
});
