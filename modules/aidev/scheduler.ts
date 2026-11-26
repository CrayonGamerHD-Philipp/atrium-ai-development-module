/**
 * Scheduler (reine Logik, keine Server-Importe): verteilt wartende Aufträge auf Anbieter-Konten der Runner.
 * Ziel: Abos gleichmäßig auslasten (5-h-Fenster und Woche), Rollen-Vorlieben beachten (Routing), Limits respektieren,
 * je Projekt höchstens `maxParallel` gleichzeitig. Aufgerufen von `scheduler.service.ts` unter einer Advisory-Sperre.
 *
 * Vorrang der Runner (`AccountState.runnerPriority`, siehe `runnerPriorityOf`): Je Auftrag wird zuerst unter den
 * Konten der höchsten Vorrangstufe gewählt, die mindestens ein geeignetes Konto hat (`scoreAccount` ≠ null). Erst
 * wenn dort keines geeignet ist (voll, offline, draining, ausgeschlossen …), kommt die nächste Stufe dran. Innerhalb
 * einer Stufe entscheidet die Punktzahl (inkl. Sitzungs- und Projekt-Runner-Bonus). So entlasten PC-Runner
 * (`desktop`, automatisch 10) die Server-Runner (automatisch 0). Ein bereits eingeplanter Lauf auf einem Server-Runner
 * wird nicht verdrängt, wenn ein Runner höherer Stufe (wieder) online kommt (kein Hin- und Herspringen). Nach einem
 * Verbindungsverlust gemiedene Runner/Konten (`avoidRunnerIds`/`avoidAccountIds`) zählen zur niedrigsten Stufe.
 */
import type { Provider, Role } from './protocol';
import type { Routing } from './schemas';

export interface AccountState {
	id: string;
	runnerId: string;
	provider: Provider;
	enabled: boolean;
	loggedIn: boolean;
	/** Runner online, freigegeben und mit freiem Slot (Anzahl freier Slots) */
	runnerOnline: boolean;
	runnerFreeSlots: number;
	/** Läufe dieses Kontos im Zustand offered/running */
	running: number;
	maxConcurrency: number;
	/** ms seit Epoch oder null */
	cooldownUntil: number | null;
	/** wirksames Budget in Einheiten (0 = unbekannt → nur Gleichverteilung über `running`) */
	budget5h: number;
	budgetWeek: number;
	/** Verbrauch in Einheiten im gleitenden 5-h-Fenster bzw. seit Wochenbeginn (inkl. Reservierungen) */
	used5h: number;
	usedWeek: number;
	/** Beginn der aktuellen Abrechnungswoche (ms) */
	weekStart: number;
	contextK: number;
	defaultModel: string;
	/**
	 * Vom Anbieter gemeldete Auslastung (0..1, über 1 bei Overage) aus einem aktuellen Limit-Stand; fehlend/`null`
	 * = keine aktuelle Meldung (z. B. ältere Runner) → nur die eigene Schätzung zählt. Siehe `reportedUtil`.
	 */
	reported?: { u5h: number | null; uWeek: number | null };
	/** Ein Limit-Fenster meldet `rejected` bis zu dieser Zeit (ms) – wirkt wie eine Wartezeit */
	rejectedUntil?: number | null;
	/** Wirksamer Vorrang des Runners (höher = zuerst), siehe `runnerPriorityOf`; fehlend = 0 (Server) */
	runnerPriority?: number;
}

export interface TaskCandidate {
	id: string;
	projectId: string;
	role: Role;
	priority: number;
	/** ms seit Epoch */
	createdAt: number;
	requiredContextK: number;
	providerHint: Provider | null;
	/** Konten, die für diesen Auftrag nicht mehr gewählt werden sollen (z. B. nach Limit) */
	excludedAccountIds: string[];
	/** Sitzung fortsetzen: gleiches Konto bevorzugen, wenn verfügbar */
	sessionAccountId: string | null;
	estimatedUnits: number;
	/**
	 * Runner, auf denen Läufe dieses Auftrags wegen Verbindungsverlust verloren gingen.
	 * Nur meiden, wenn möglich (weicher Abzug, kein Ausschluss wie `excludedAccountIds`).
	 */
	avoidRunnerIds?: string[];
	/** Konten, auf denen Läufe dieses Auftrags wegen Verbindungsverlust verloren gingen – nur meiden, wenn möglich */
	avoidAccountIds?: string[];
}

export interface ProjectState {
	id: string;
	running: number;
	maxParallel: number;
	preferredRunnerId: string | null;
}

export interface Assignment {
	taskId: string;
	accountId: string;
	runnerId: string;
	provider: Provider;
	/** Modell aus dem Routing, sonst Standardmodell des Kontos, sonst null */
	model: string | null;
	score: number;
}

export interface PlanInput {
	tasks: TaskCandidate[];
	accounts: AccountState[];
	projects: ProjectState[];
	routing: Routing;
	now: number;
}

/** Hart ausgeschlossen ab dieser Auslastung */
export const HARD_LIMIT_5H = 0.95;
export const HARD_LIMIT_WEEK = 0.98;
export const WEEK_MS = 7 * 24 * 3600 * 1000;
export const DAY_MS = 24 * 3600 * 1000;

/** Gewicht eines per `providerHint` erzwungenen Anbieters, der im Routing der Rolle fehlt */
export const HINT_DEFAULT_WEIGHT = 5;
/** Bonus, wenn der Auftrag eine Sitzung auf genau diesem Konto fortsetzt */
export const SESSION_BONUS = 0.25;
/** Bonus für den bevorzugten Runner des Projekts */
export const PREFERRED_RUNNER_BONUS = 0.1;
/**
 * Abzug für Runner/Konten, auf denen ein Lauf des Auftrags die Verbindung verloren hat. Größer als die
 * gesamte mögliche Spanne der übrigen Punktzahl (Gewicht ≤ 1, Tempo ±0.5, Parallelität ≤ 0.3, Boni 0.35),
 * damit jedes andere geeignete Konto vorgeht; ohne Alternative wird das gemiedene trotzdem gewählt.
 */
export const LOST_CONNECTION_MALUS = 5;

/** Automatischer Vorrang je Runner-Art (ohne Vorgabe der Verwaltung) */
export const DESKTOP_PRIORITY = 10;
export const SERVER_PRIORITY = 0;

/** Wirksamer Vorrang: Vorgabe der Verwaltung, sonst nach Art (desktop 10, server/unbekannt 0) */
export function runnerPriorityOf(
	kind: string | null | undefined,
	priority: number | null | undefined
): number {
	if (priority != null && Number.isFinite(priority)) return priority;
	return kind === 'desktop' ? DESKTOP_PRIORITY : SERVER_PRIORITY;
}

/** Endliche Zahl oder 0 (NaN/±∞ → 0) */
function num(n: number): number {
	return Number.isFinite(n) ? n : 0;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/** Kann das Konto jetzt überhaupt einen Lauf übernehmen (unabhängig vom Auftrag)? */
export function accountAvailable(a: AccountState, now: number): boolean {
	if (!a.enabled || !a.loggedIn || !a.runnerOnline) return false;
	if (!(a.runnerFreeSlots > 0)) return false;
	if (!(a.running < a.maxConcurrency)) return false;
	if (a.cooldownUntil != null && now < a.cooldownUntil) return false;
	if (a.rejectedUntil != null && now < a.rejectedUntil) return false;
	// Hart ausgeschöpft? Unbekanntes Budget (0) ergibt Auslastung 0 und schließt daher nie aus.
	const { u5h, uWeek } = limitUtilization(a);
	if (u5h > HARD_LIMIT_5H || uWeek > HARD_LIMIT_WEEK) return false;
	return true;
}

/** Auslastung für die Ausschluss-Prüfung: Maximum aus eigener Schätzung und aktueller Meldung des Anbieters */
export function limitUtilization(a: AccountState): { u5h: number; uWeek: number } {
	const own = utilization(a);
	const pick = (estimate: number, reported: number | null | undefined) =>
		reported != null && Number.isFinite(reported) ? Math.max(estimate, reported) : estimate;
	return { u5h: pick(own.u5h, a.reported?.u5h), uWeek: pick(own.uWeek, a.reported?.uWeek) };
}

function ratio(used: number, budget: number): number {
	const b = num(budget);
	if (b <= 0) return 0;
	return Math.max(0, num(used) / b);
}

/** Auslastung 0..1 (0 bei unbekanntem Budget); Werte über 1 bleiben erhalten (für die Ausschluss-Prüfung). */
export function utilization(a: AccountState): { u5h: number; uWeek: number } {
	return { u5h: ratio(a.used5h, a.budget5h), uWeek: ratio(a.usedWeek, a.budgetWeek) };
}

/** Routing-Eintrag der Rolle für einen Anbieter (erster Treffer) */
function routingEntry(routing: Routing, role: Role, provider: Provider) {
	return (routing[role] ?? []).find((e) => e.provider === provider);
}

/**
 * Punktzahl eines Kontos für einen Auftrag; `null` = nicht geeignet.
 * weight_role(provider) · (1 − max(u5h, uWeek)) + 0.5 · pace − 0.3 · running/maxConcurrency (+ Boni)
 * − LOST_CONNECTION_MALUS (höchstens einmal), wenn Runner oder Konto nach Verbindungsverlust gemieden werden
 * sollen – weicher Abzug: das Konto bleibt geeignet, landet aber hinter allen anderen.
 */
export function scoreAccount(
	task: TaskCandidate,
	account: AccountState,
	routing: Routing,
	now: number,
	preferredRunnerId?: string | null
): { score: number; model: string | null } | null {
	if (!accountAvailable(account, now)) return null;
	if (task.excludedAccountIds.includes(account.id)) return null;
	if (account.contextK < task.requiredContextK) return null;

	const entry = routingEntry(routing, task.role, account.provider);
	let weight: number;
	if (task.providerHint) {
		// Ausdrücklicher Wunsch (z. B. aus dem Plan): nur dieser Anbieter. Das Routing liefert nur das Gewicht;
		// fehlt der Anbieter dort (oder steht er auf 0), gilt ein neutrales Gewicht – der Wunsch hat Vorrang.
		if (account.provider !== task.providerHint) return null;
		weight = entry && entry.weight > 0 ? entry.weight : HINT_DEFAULT_WEIGHT;
	} else {
		if (!entry || !(entry.weight > 0)) return null;
		weight = entry.weight;
	}

	const { u5h, uWeek } = utilization(account);
	const load = Math.max(u5h, uWeek);

	// Tempo: liegt der Wochenverbrauch hinter der verstrichenen Wochenzeit, ist noch „Luft“ → bevorzugen.
	let pace = 0;
	if (account.budgetWeek > 0) {
		const elapsed = clamp((now - account.weekStart) / WEEK_MS, 0, 1);
		pace = clamp(elapsed - uWeek, -1, 1);
	}

	const concurrency = account.maxConcurrency > 0 ? account.running / account.maxConcurrency : 1;
	let score = (weight / 10) * (1 - load) + 0.5 * pace - 0.3 * concurrency;
	if (task.sessionAccountId != null && task.sessionAccountId === account.id) score += SESSION_BONUS;
	if (preferredRunnerId != null && account.runnerId === preferredRunnerId) {
		score += PREFERRED_RUNNER_BONUS;
	}
	if (
		task.avoidRunnerIds?.includes(account.runnerId) ||
		task.avoidAccountIds?.includes(account.id)
	) {
		score -= LOST_CONNECTION_MALUS;
	}

	const model = entry?.model || account.defaultModel || null;
	return { score, model };
}

/** Soll das Konto für den Auftrag nach einem Verbindungsverlust gemieden werden? */
function avoided(task: TaskCandidate, account: AccountState): boolean {
	return !!(
		task.avoidRunnerIds?.includes(account.runnerId) || task.avoidAccountIds?.includes(account.id)
	);
}

/** Sortierung der Aufgaben: Priorität absteigend, dann älteste zuerst, dann id (deterministisch). */
function compareTasks(a: TaskCandidate, b: TaskCandidate): number {
	if (a.priority !== b.priority) return b.priority - a.priority;
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Gierige Zuteilung (Priorität, dann Alter); bucht Schätzungen sofort vor, verändert die Eingaben nicht. */
export function planAssignments(input: PlanInput): Assignment[] {
	const { routing, now } = input;
	// Lokale Kopien, die während der Planung fortgeschrieben werden
	const accounts = input.accounts.map((a) => ({ ...a }));
	const projects = new Map(input.projects.map((p) => [p.id, { ...p }]));
	const tasks = [...input.tasks].sort(compareTasks);
	const assigned = new Set<string>();
	const result: Assignment[] = [];

	for (const task of tasks) {
		if (assigned.has(task.id)) continue; // doppelte Einträge nur einmal zuteilen
		const project = projects.get(task.projectId);
		if (project && project.running >= project.maxParallel) continue;

		// höchste Vorrangstufe mit geeignetem Konto; innerhalb der Stufe Punktzahl, dann Auslastung, dann id
		let best: {
			account: AccountState;
			score: number;
			model: string | null;
			load: number;
			tier: number;
		} | null = null;
		for (const account of accounts) {
			const s = scoreAccount(task, account, routing, now, project?.preferredRunnerId ?? null);
			if (!s) continue;
			// nach Verbindungsverlust gemiedene Runner/Konten fallen hinter jede Vorrangstufe zurück (bleiben Ausweg)
			const tier = avoided(task, account) ? -Infinity : num(account.runnerPriority ?? 0);
			const { u5h, uWeek } = utilization(account);
			const load = Math.max(u5h, uWeek);
			const better =
				!best ||
				tier > best.tier ||
				(tier === best.tier &&
					(s.score > best.score ||
						(s.score === best.score &&
							(load < best.load || (load === best.load && account.id < best.account.id)))));
			if (better) best = { account, score: s.score, model: s.model, load, tier };
		}
		if (!best) continue;

		const chosen = best.account;
		result.push({
			taskId: task.id,
			accountId: chosen.id,
			runnerId: chosen.runnerId,
			provider: chosen.provider,
			model: best.model,
			score: best.score
		});
		assigned.add(task.id);

		// Vorbuchen: Konto, Runner-Slots (alle Konten des Runners) und Verbrauchsschätzung
		const units = Math.max(0, num(task.estimatedUnits));
		chosen.running += 1;
		chosen.used5h += units;
		chosen.usedWeek += units;
		for (const a of accounts) {
			if (a.runnerId === chosen.runnerId) a.runnerFreeSlots -= 1;
		}
		if (project) project.running += 1;
	}
	return result;
}

/** Neues Budget nach einem Limit-Treffer (EWMA aus Verbrauch beim Treffer), gerundet auf ganze Einheiten. */
export function calibrateBudget(previous: number | null, unitsAtHit: number, alpha = 0.3): number {
	if (!(unitsAtHit > 0)) return previous ?? 0;
	if (previous == null || !(previous > 0)) return Math.round(unitsAtHit);
	return Math.round(previous * (1 - alpha) + unitsAtHit * alpha);
}

/** Wartezeit nach Limit ohne bekannte Rücksetzzeit: 15 → 30 → 60 → 120 min (Obergrenze). */
export function backoffMs(strikes: number): number {
	const s = Number.isFinite(strikes) ? Math.max(0, Math.floor(strikes)) : 3;
	const minutes = 15 * 2 ** Math.min(s, 3);
	return minutes * 60 * 1000;
}

/** Verbrauchseinheiten aus Tokens (normiertes Maß über alle Anbieter). */
export function unitsOf(u: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}): number {
	const pos = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
	return Math.round(
		pos(u.inputTokens) +
			pos(u.outputTokens) +
			Math.round(0.1 * pos(u.cacheReadTokens)) +
			pos(u.cacheWriteTokens)
	);
}

/** Beginn der aktuellen Woche relativ zum Anker (Anker null → Montag 00:00 UTC). */
export function weekStartOf(anchor: number | null, now: number): number {
	if (anchor == null) {
		const day = Math.floor(now / DAY_MS);
		// 1970-01-01 war ein Donnerstag → Montag = 0 über (Tag + 3) mod 7
		const dow = (((day + 3) % 7) + 7) % 7;
		return (day - dow) * DAY_MS;
	}
	// größtes anchor + k·WEEK_MS ≤ now (k darf negativ sein, z. B. bei Anker in der Zukunft)
	const k = Math.floor((now - anchor) / WEEK_MS);
	return anchor + k * WEEK_MS;
}

/** Prüft einen Abhängigkeitsgraphen (Knoten → Vorgänger) auf Zyklen; liefert einen Zyklus oder null. */
export function findCycle(graph: Map<string, string[]>): string[] | null {
	// 1 = in Bearbeitung (auf dem Pfad), 2 = fertig
	const state = new Map<string, 1 | 2>();
	const path: string[] = [];

	const visit = (node: string): string[] | null => {
		state.set(node, 1);
		path.push(node);
		for (const dep of graph.get(node) ?? []) {
			if (!graph.has(dep)) continue; // unbekannte Vorgänger ignorieren
			const st = state.get(dep);
			if (st === 1) return [...path.slice(path.indexOf(dep)), dep];
			if (st === undefined) {
				const found = visit(dep);
				if (found) return found;
			}
		}
		path.pop();
		state.set(node, 2);
		return null;
	};

	for (const node of graph.keys()) {
		if (state.has(node)) continue;
		const found = visit(node);
		if (found) return found;
	}
	return null;
}
