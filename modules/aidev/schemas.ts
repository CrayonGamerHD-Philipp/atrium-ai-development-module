/**
 * Vertrag des Moduls `aidev` zwischen Server (Endpoints) und Oberfläche (Seiten): Rechte, Eingabe-Schemas, DTOs,
 * Live-Ereignisse. Reine Datei ohne Server-Importe (Client + Server). Endpunkte: siehe `API` unten.
 */
import { z } from 'zod';
import type { StoredChatAction } from './actions';
import {
	commitPolicySchema,
	taskDeliverySchema,
	providerSchema,
	roleSchema,
	workspaceTargetSchema,
	type CommitPolicy,
	type FsEntry,
	type LimitSnapshot,
	type LimitWindow,
	type Provider,
	type Role,
	type RunEvent
} from './protocol';

export const MODULE_ID = 'aidev';

export const PERM = {
	projectView: 'aidev.project.view',
	projectManage: 'aidev.project.manage',
	taskCreate: 'aidev.task.create',
	taskManage: 'aidev.task.manage',
	terminal: 'aidev.workspace.terminal',
	files: 'aidev.workspace.files',
	runnerManage: 'aidev.runner.manage',
	runnerConnect: 'aidev.runner.connect',
	accountManage: 'aidev.account.manage',
	settingsManage: 'aidev.settings.manage'
} as const;

export const SETTING_ROUTING = 'aidev.routing';
export const SETTING_LIMITS = 'aidev.limits';

export const TASK_STATUSES = [
	'draft',
	'queued',
	'blocked',
	'running',
	'review',
	'done',
	'failed',
	'cancelled',
	'needs-input'
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Endzustände (kein Lauf mehr geplant) */
export const FINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];

export const RUN_STATUSES = [
	'offered',
	'running',
	'succeeded',
	'failed',
	'limited',
	'cancelled',
	'lost'
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ROLE_LABELS: Record<Role, string> = {
	orchestrate: 'Planen & aufteilen',
	research: 'Recherche',
	implement: 'Umsetzen',
	review: 'Review',
	fix: 'Korrektur',
	resolve: 'Konflikt lösen'
};
export const PROVIDER_LABELS: Record<Provider, string> = {
	claude: 'Claude Code',
	codex: 'Codex CLI',
	gemini: 'Gemini CLI',
	'openai-api': 'OpenAI-kompatible API',
	fake: 'Test-Agent'
};
export const STATUS_LABELS: Record<TaskStatus, string> = {
	draft: 'Entwurf',
	queued: 'Wartet',
	blocked: 'Blockiert',
	running: 'Läuft',
	review: 'PR offen',
	done: 'Fertig',
	failed: 'Fehlgeschlagen',
	cancelled: 'Abgebrochen',
	'needs-input': 'Rückfrage'
};
export const POLICY_LABELS: Record<CommitPolicy, string> = {
	pr: 'Pull Request',
	'pr-automerge': 'Pull Request mit Auto-Merge',
	direct: 'Direkt auf den Haupt-Branch'
};

// ---------------------------------------------------------------- Einstellungen

export const routingEntrySchema = z.object({
	provider: providerSchema,
	/** Vorliebe 0–10 (0 = nie) */
	weight: z.number().min(0).max(10),
	model: z.string().max(120).optional()
});
export const routingSchema = z.object({
	orchestrate: z.array(routingEntrySchema).max(10),
	research: z.array(routingEntrySchema).max(10),
	implement: z.array(routingEntrySchema).max(10),
	review: z.array(routingEntrySchema).max(10),
	fix: z.array(routingEntrySchema).max(10),
	resolve: z.array(routingEntrySchema).max(10)
});
export type Routing = z.infer<typeof routingSchema>;
export type RoutingEntry = z.infer<typeof routingEntrySchema>;

export const DEFAULT_ROUTING: Routing = {
	orchestrate: [
		{ provider: 'claude', weight: 8 },
		{ provider: 'codex', weight: 5 },
		{ provider: 'gemini', weight: 4 }
	],
	research: [
		{ provider: 'codex', weight: 9 },
		{ provider: 'gemini', weight: 7 },
		{ provider: 'claude', weight: 3 }
	],
	implement: [
		{ provider: 'claude', weight: 9 },
		{ provider: 'codex', weight: 7 },
		{ provider: 'gemini', weight: 4 },
		{ provider: 'openai-api', weight: 2 }
	],
	review: [
		{ provider: 'gemini', weight: 8 },
		{ provider: 'codex', weight: 6 },
		{ provider: 'claude', weight: 5 }
	],
	fix: [
		{ provider: 'claude', weight: 8 },
		{ provider: 'codex', weight: 7 },
		{ provider: 'gemini', weight: 4 }
	],
	resolve: [
		{ provider: 'claude', weight: 8 },
		{ provider: 'codex', weight: 6 }
	]
};

export const limitsSchema = z.object({
	/** Laufzeit eines Agent-Prozesses in Minuten */
	runTimeoutMin: z
		.number()
		.int()
		.min(5)
		.max(24 * 60),
	/** Aufbewahrung der Lauf-Ereignisse in Tagen (0 = unbegrenzt) */
	eventRetentionDays: z.number().int().min(0).max(3650),
	/** Geschätzter Verbrauch je Lauf (Einheiten), bis echte Werte da sind */
	estimatedUnitsPerRun: z.number().int().min(0).max(100_000_000),
	/** Höchstzahl Ereignisse je Lauf */
	maxEventsPerRun: z.number().int().min(100).max(1_000_000)
});
export type Limits = z.infer<typeof limitsSchema>;
export const DEFAULT_LIMITS: Limits = {
	runTimeoutMin: 90,
	eventRetentionDays: 30,
	estimatedUnitsPerRun: 400_000,
	maxEventsPerRun: 20_000
};

// ---------------------------------------------------------------- Eingaben (Browser → Server)

export const idParams = z.object({ id: z.string().uuid() });
export const repoSlug = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9._-]+$/, 'Nur Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich');
export const branchName = z
	.string()
	.min(1)
	.max(200)
	.regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/, 'Ungültiger Branch-Name');

export const projectInput = z.object({
	name: z.string().trim().min(1).max(120),
	/** GitHub-Link oder `owner/repo` (Server zerlegt in `repoOwner`/`repoName`) */
	repo: z.string().trim().min(3).max(300),
	defaultBranch: branchName.default('main'),
	commitPolicy: commitPolicySchema.default('pr'),
	maxParallel: z.number().int().min(1).max(20).default(2),
	setupCmd: z.string().max(2000).default(''),
	testCmd: z.string().max(2000).default(''),
	instructions: z.string().max(20_000).default(''),
	preferredRunnerId: z.string().uuid().nullable().default(null)
});
export type ProjectInput = z.infer<typeof projectInput>;
/** Ohne `.default()` (Zod 4 füllt Defaults auch in `.partial()` ein – ein PATCH würde sonst Felder zurücksetzen) */
export const projectPatch = z
	.object({
		name: z.string().trim().min(1).max(120),
		defaultBranch: branchName,
		commitPolicy: commitPolicySchema,
		maxParallel: z.number().int().min(1).max(20),
		setupCmd: z.string().max(2000),
		testCmd: z.string().max(2000),
		instructions: z.string().max(20_000),
		preferredRunnerId: z.string().uuid().nullable()
	})
	.partial();
export type ProjectPatch = z.infer<typeof projectPatch>;

/** Höchstzahl und maximale Größe der Anhänge je Auftrag oder Nachricht. */
export const ATTACHMENT_MAX_FILES = 10;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Metadaten der einzelnen Multipart-Datei nach dem Einlesen; kein JSON-Body. */
export const attachmentUploadInput = z.object({
	name: z.string().min(1).max(120),
	mime: z.string().min(1),
	size: z.number().int().positive().max(ATTACHMENT_MAX_BYTES)
});
export type AttachmentUploadInput = z.infer<typeof attachmentUploadInput>;

export const taskInput = z.object({
	delivery: taskDeliverySchema.default('project'),
	/** Bestehenden PR bearbeiten statt neuen Branch/PR anzulegen (Nummer des Pull Requests) */
	targetPr: z.number().int().positive().nullable().default(null),
	title: z.string().trim().max(200).optional(),
	prompt: z.string().trim().min(1).max(20_000),
	role: roleSchema.default('implement'),
	/** Großer Auftrag: zuerst planen & in Teilaufträge zerlegen (Rolle `orchestrate`) */
	decompose: z.boolean().default(false),
	priority: z.number().int().min(-10).max(10).default(0),
	providerHint: providerSchema.nullable().default(null),
	dependsOn: z.array(z.string().uuid()).max(20).default([]),
	attachmentIds: z.array(z.string().uuid()).max(ATTACHMENT_MAX_FILES).default([]),
	/** Als Entwurf anlegen statt sofort einzuplanen */
	draft: z.boolean().default(false),
	maxAttempts: z.number().int().min(1).max(10).default(3)
});
export type TaskInput = z.infer<typeof taskInput>;
export const taskPatch = z.object({
	title: z.string().trim().min(1).max(200).optional(),
	prompt: z.string().trim().min(1).max(20_000).optional(),
	priority: z.number().int().min(-10).max(10).optional(),
	providerHint: providerSchema.nullable().optional(),
	maxAttempts: z.number().int().min(1).max(10).optional()
});
export type TaskPatch = z.infer<typeof taskPatch>;
export const replyInput = z.object({ message: z.string().trim().min(1).max(20_000) });

export const chatInput = z.object({
	delivery: taskDeliverySchema.default('project'),
	/** Bestehenden PR bearbeiten statt neuen Branch/PR anzulegen (Nummer des Pull Requests) */
	targetPr: z.number().int().positive().nullable().default(null),
	body: z.string().trim().min(1).max(20_000),
	attachmentIds: z.array(z.string().uuid()).max(ATTACHMENT_MAX_FILES).default([]),
	/**
	 * `task` = Nachricht wird ein Auftrag, `question` = Frage an einen lesenden Agenten, `note` = nur Notiz im Verlauf,
	 * `auto` = Frage/Auftrag regelbasiert erkennen (`classifyChatIntent` in `intent.ts`). Ohne Angabe bleibt es `task`.
	 */
	mode: z.enum(['task', 'note', 'question', 'auto']).default('task'),
	role: roleSchema.default('implement'),
	decompose: z.boolean().default(false),
	providerHint: providerSchema.nullable().default(null),
	/**
	 * „Umsetzen“: ID einer `agent`-Nachricht desselben Projekts, auf die sich die Nachricht bezieht. Nur im
	 * Modus `task` wirksam – Frage und Antwort kommen als Kontext in den neuen Auftrag.
	 */
	replyTo: z.string().uuid().nullable().default(null)
});
export type ChatInput = z.infer<typeof chatInput>;
/** Aktionsvorschlag einer Chatnachricht übernehmen oder verwerfen */
export const chatActionDecision = z.object({ decision: z.enum(['apply', 'reject']) });
export type ChatActionDecision = z.infer<typeof chatActionDecision>;
export const chatActionParams = z.object({
	id: z.string().uuid(),
	index: z.coerce.number().int().min(0)
});
export const chatQuery = z.object({
	before: z.string().datetime({ offset: true }).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50)
});

export const tasksQuery = z.object({
	status: z.enum(['open', 'all', 'done']).default('all'),
	limit: z.coerce.number().int().min(1).max(500).default(200)
});
export const runEventsQuery = z.object({
	afterSeq: z.coerce.number().int().min(-1).default(-1),
	limit: z.coerce.number().int().min(1).max(2000).default(500)
});
export const liveQuery = z.object({
	client: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
});

export const runnerPatch = z.object({
	name: z.string().trim().min(1).max(80).optional(),
	status: z.enum(['approved', 'disabled']).optional(),
	maxSlots: z.number().int().min(0).max(64).optional()
});
export const accountPatch = z.object({
	label: z.string().trim().max(120).optional(),
	enabled: z.boolean().optional(),
	maxConcurrency: z.number().int().min(0).max(32).optional(),
	budget5hUnits: z.number().int().min(0).optional(),
	budgetWeekUnits: z.number().int().min(0).optional(),
	weekAnchor: z.string().datetime({ offset: true }).nullable().optional(),
	contextK: z.number().int().min(8).max(10_000).optional(),
	defaultModel: z.string().max(120).optional()
});
export type AccountPatch = z.infer<typeof accountPatch>;

export const workspaceQuery = z.object({
	target: workspaceTargetSchema.default('main'),
	path: z.string().max(1000).default('')
});
export const fileWriteInput = z.object({
	target: workspaceTargetSchema.default('main'),
	path: z.string().min(1).max(1000),
	content: z.string().max(600_000)
});
export const fileDeleteInput = z.object({
	target: workspaceTargetSchema.default('main'),
	path: z.string().min(1).max(1000)
});
export const terminalOpenInput = z.object({
	target: workspaceTargetSchema.default('main'),
	cols: z.number().int().min(10).max(500).default(120),
	rows: z.number().int().min(5).max(200).default(32)
});
export const terminalInput = z.object({ data: z.string().min(1).max(16_384) });
export const terminalResize = z.object({
	cols: z.number().int().min(10).max(500),
	rows: z.number().int().min(5).max(200)
});
export const mergeInput = z.object({
	method: z.enum(['squash', 'merge', 'rebase']).default('squash')
});
export const prParams = z.object({
	id: z.string().uuid(),
	number: z.coerce.number().int().positive()
});
export const sidParams = z.object({ sid: z.string().uuid() });

// ---------------------------------------------------------------- DTOs (Server → Browser)

export interface ProjectDto {
	id: string;
	name: string;
	repoOwner: string;
	repoName: string;
	repoUrl: string;
	defaultBranch: string;
	commitPolicy: CommitPolicy;
	maxParallel: number;
	setupCmd: string;
	testCmd: string;
	instructions: string;
	preferredRunnerId: string | null;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
	counts: { queued: number; running: number; review: number; needsInput: number; done: number };
}

export interface AttachmentDto {
	id: string;
	name: string;
	mime: string;
	size: number;
	createdAt: string;
}

export interface TaskDto {
	delivery: 'project' | 'branch';
	/** Bearbeiteter bestehender Pull Request (sonst `null`) */
	targetPr: number | null;
	branchPushed: boolean;
	id: string;
	projectId: string;
	parentId: string | null;
	position: number;
	title: string;
	prompt: string;
	role: Role;
	status: TaskStatus;
	priority: number;
	attempts: number;
	maxAttempts: number;
	providerHint: Provider | null;
	branch: string | null;
	resultSummary: string | null;
	errorMessage: string | null;
	prNumber: number | null;
	prUrl: string | null;
	dependsOn: string[];
	attachments?: AttachmentDto[];
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	/** Laufender bzw. letzter Lauf (Kurzform) */
	lastRun: RunSummaryDto | null;
}

export interface RunSummaryDto {
	id: string;
	attempt: number;
	status: RunStatus;
	provider: Provider;
	model: string;
	accountLabel: string;
	runnerName: string;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface RunDto extends RunSummaryDto {
	taskId: string;
	projectId: string;
	runnerId: string | null;
	accountId: string | null;
	branch: string | null;
	headSha: string | null;
	sessionId: string | null;
	errorKind: string | null;
	errorMessage: string | null;
	summary: string | null;
	eventCount: number;
	units: number;
	createdAt: string;
	commits: CommitDto[];
}

export interface CommitDto {
	sha: string;
	message: string;
	additions: number;
	deletions: number;
	files: string[];
}

export interface TaskDetailDto {
	task: TaskDto;
	runs: RunDto[];
	children: TaskDto[];
	/** Titel der Abhängigkeiten (für Anzeige) */
	dependencies: { id: string; title: string; status: TaskStatus }[];
	pullRequest: PullRequestDto | null;
}

export interface RunEventDto extends RunEvent {
	runId: string;
}

export interface ChatMessageDto {
	id: string;
	projectId: string;
	taskId: string | null;
	kind: 'user' | 'agent' | 'system';
	body: string;
	author: { id: string; name: string } | null;
	createdAt: string;
	attachments?: AttachmentDto[];
	/** Aktionsvorschläge des Agents (nur `agent`-Nachrichten, sonst leer) */
	actions: ChatActionDto[];
}

/** Gespeicherter Aktionsvorschlag mit seiner Position (`index` für `POST /chat/:id/actions/:index`) */
export type ChatActionDto = StoredChatAction & { index: number };

export interface PullRequestDto {
	projectId: string;
	number: number;
	taskId: string | null;
	title: string;
	branch: string;
	state: 'open' | 'merged' | 'closed';
	isDraft: boolean;
	mergeable: string;
	checks: string;
	autoMerge: boolean;
	url: string;
	additions: number;
	deletions: number;
	updatedAt: string;
	syncedAt: string;
}

export interface RunnerDto {
	id: string;
	name: string;
	status: 'pending' | 'approved' | 'disabled';
	version: string;
	online: boolean;
	lastSeenAt: string | null;
	maxSlots: number;
	slotsUsed: number;
	/** Runner wird beendet und lässt laufende Läufe fertig werden (bekommt keine neuen) */
	draining: boolean;
	capabilities: {
		question?: boolean;
		attachments?: boolean;
		branchDelivery?: boolean;
		prUpdate?: boolean;
		git?: boolean;
		gh?: boolean;
		pty?: boolean;
		os?: string;
	};
	createdAt: string;
	accounts: AccountDto[];
}

export interface AccountDto {
	id: string;
	runnerId: string;
	runnerName: string;
	key: string;
	provider: Provider;
	label: string;
	loggedIn: boolean;
	models: string[];
	enabled: boolean;
	maxConcurrency: number;
	budget5hUnits: number;
	budgetWeekUnits: number;
	/** wirksames Budget (kalibriert, sonst eingestellt; 0 = unbekannt) */
	effective5hUnits: number;
	effectiveWeekUnits: number;
	weekAnchor: string | null;
	contextK: number;
	defaultModel: string;
	cooldownUntil: string | null;
	cooldownReason: string | null;
	usage: { used5h: number; usedWeek: number; util5h: number; utilWeek: number; running: number };
	/** Zuletzt gemeldeter Limit-Stand mit Atrium-Analyse (`null` = nie gemeldet) */
	limits: AccountLimitsDto | null;
}

export interface AccountLimitWindowDto {
	window: LimitWindow['window'];
	label: string;
	/** vom Anbieter gemeldete Auslastung in Prozent (0–100, über 100 bei Overage) */
	usedPercent: number | null;
	resetsAt: string | null;
	status: LimitWindow['status'];
	/** Stand dieses Fensters älter als 30 min (fließt nicht in Scheduler-Entscheidungen ein) */
	stale: boolean;
	/** eigene Schätzung Atriums aus dem Verbrauch (0..1), nur für `5h` und `week` */
	estimatedUtil: number | null;
	/** Prognose, wann 100 % erreicht werden (`null` = nicht vor dem Reset bzw. unbekannt) */
	exhaustsAt: string | null;
}

export interface AccountLimitsDto {
	observedAt: string;
	source: LimitSnapshot['source'];
	/** Daten älter als 30 Minuten */
	stale: boolean;
	windows: AccountLimitWindowDto[];
	/** aus Auslastung und Verbrauch abgeleitete Budgetvorschläge (Einheiten), `null` = zu wenig Daten */
	suggestedBudget5hUnits: number | null;
	suggestedBudgetWeekUnits: number | null;
}

export interface OverviewDto {
	runners: { total: number; online: number; pendingApproval: number };
	accounts: AccountDto[];
	tasks: { queued: number; running: number; review: number; needsInput: number; failed: number };
	activeRuns: (RunSummaryDto & {
		taskId: string;
		taskTitle: string;
		projectId: string;
		projectName: string;
	})[];
}

export interface FsListDto {
	path: string;
	entries: FsEntry[];
}
export interface FileDto {
	path: string;
	encoding: 'utf8' | 'base64';
	content: string;
	size: number;
	truncated: boolean;
}
export interface DiffDto {
	base: string;
	head: string;
	diff: string;
	truncated: boolean;
	files: { path: string; additions: number; deletions: number }[];
}
export interface TerminalDto {
	sid: string;
	runnerId: string;
	target: string;
}

// ---------------------------------------------------------------- Live-Ereignisse (SSE, Browser)

/** `GET /projects/:id/live` */
export type ProjectLiveEvent =
	| { type: 'hello'; projectId: string }
	| { type: 'task'; task: TaskDto }
	| { type: 'task-deleted'; taskId: string }
	| { type: 'run'; run: RunSummaryDto & { taskId: string } }
	| { type: 'run-events'; runId: string; taskId: string; events: RunEvent[] }
	| { type: 'chat'; message: ChatMessageDto }
	| { type: 'pr'; pr: PullRequestDto }
	| { type: 'project'; project: ProjectDto }
	| { type: 'revoked' }
	| { type: 'access'; level: string };

/** `GET /overview/live` (Runner, Konten, aktive Läufe aller Projekte) */
export type OverviewLiveEvent =
	{ type: 'hello' } | { type: 'overview'; overview: OverviewDto } | { type: 'revoked' };

/** `GET /terminal/:sid/live` */
export type TerminalLiveEvent =
	| { type: 'hello'; sid: string }
	| { type: 'output'; seq: number; data: string }
	| { type: 'exit'; code: number | null }
	| { type: 'error'; message: string }
	| { type: 'revoked' };

// ---------------------------------------------------------------- Endpunkte (Pfad relativ zu /api/v1/modules/aidev)

/**
 * Übersicht der Browser-Endpunkte (Vertrag für die Seiten). Runner-Endpunkte (`/runner/...`): siehe `protocol.ts`.
 *
 * | Methode | Pfad | Recht | Body/Query | Antwort |
 * |---|---|---|---|---|
 * | GET | /overview | project.view | – | OverviewDto |
 * | GET | /overview/live | project.view | liveQuery | SSE OverviewLiveEvent |
 * | GET | /projects | project.view | – | ProjectDto[] |
 * | POST | /projects | project.manage | projectInput | ProjectDto |
 * | GET | /projects/:id | project.view | – | ProjectDto |
 * | PATCH | /projects/:id | project.manage | projectPatch | ProjectDto |
 * | DELETE | /projects/:id | project.manage | – | { ok } (archiviert) |
 * | POST | /projects/:id/check | project.manage | – | { ok, message, defaultBranch, canPush } (über Runner) |
 * | GET | /projects/:id/live | project.view | liveQuery | SSE ProjectLiveEvent |
 * | POST | /projects/:id/attachments | task.create | Multipart: eine Datei `file` | AttachmentDto (201) |
 * | GET | /projects/:id/tasks | project.view | tasksQuery | TaskDto[] |
 * | POST | /projects/:id/tasks | task.create | taskInput | TaskDto |
 * | GET | /tasks/:id | project.view | – | TaskDetailDto |
 * | PATCH | /tasks/:id | task.create (eigene) / task.manage | taskPatch | TaskDto |
 * | POST | /tasks/:id/queue | task.create | – | TaskDto (Entwurf → Wartet) |
 * | POST | /tasks/:id/cancel | task.create (eigene) / task.manage | – | TaskDto |
 * | POST | /tasks/:id/retry | task.create (eigene) / task.manage | – | TaskDto |
 * | POST | /tasks/:id/reply | task.create | replyInput | TaskDto (Rückfrage beantworten, Sitzung fortsetzen) |
 * | DELETE | /tasks/:id | task.manage | – | { ok } (nur Endzustand/Entwurf) |
 * | GET | /tasks/:id/diff | project.view | – | DiffDto (Branch gegen Basis, über Runner) |
 * | GET | /runs/:id/events | project.view | runEventsQuery | RunEventDto[] |
 * | GET | /projects/:id/chat | project.view | chatQuery | ChatMessageDto[] (neueste zuerst) |
 * | POST | /projects/:id/chat | task.create | chatInput | { message: ChatMessageDto, task: TaskDto \| null, mode: 'task' \| 'question' \| 'note' } (wirksamer Modus; `replyTo` → Frage/Antwort als Kontext) |
 * | POST | /chat/:id/actions/:index | task.create (ändern/abbrechen: eigene, fremde mit task.manage) | chatActionDecision | { message: ChatMessageDto, task: TaskDto \| null } (Vorschlag übernehmen/verwerfen; Fehler → Zustand `failed`) |
 * | GET | /projects/:id/pulls | project.view | – | PullRequestDto[] |
 * | POST | /projects/:id/pulls/sync | project.view | – | PullRequestDto[] |
 * | POST | /projects/:id/pulls/:number/merge | project.manage | mergeInput | PullRequestDto |
 * | GET | /projects/:id/files | workspace.files | workspaceQuery | FsListDto |
 * | GET | /projects/:id/file | workspace.files | workspaceQuery | FileDto |
 * | PUT | /projects/:id/file | workspace.files | fileWriteInput | { ok } |
 * | DELETE | /projects/:id/file | workspace.files | fileDeleteInput (Query) | { ok } |
 * | GET | /projects/:id/git/status | workspace.files | workspaceQuery | gitStatusResult |
 * | POST | /projects/:id/terminal | workspace.terminal | terminalOpenInput | TerminalDto |
 * | GET | /terminal/:sid/live | workspace.terminal | – | SSE TerminalLiveEvent |
 * | POST | /terminal/:sid/input | workspace.terminal | terminalInput | { ok } |
 * | POST | /terminal/:sid/resize | workspace.terminal | terminalResize | { ok } |
 * | DELETE | /terminal/:sid | workspace.terminal | – | { ok } |
 * | GET | /runners | runner.manage | – | RunnerDto[] |
 * | PATCH | /runners/:id | runner.manage | runnerPatch | RunnerDto |
 * | DELETE | /runners/:id | runner.manage | – | { ok } |
 * | GET | /accounts | project.view | – | AccountDto[] |
 * | PATCH | /accounts/:id | account.manage | accountPatch | AccountDto |
 * | POST | /accounts/:id/clear-cooldown | account.manage | – | AccountDto |
 * | GET | /routing | project.view | – | { routing: Routing, limits: Limits } |
 * | PUT | /routing | settings.manage | { routing, limits } | { routing, limits } |
 */
export const API_DOC = true;

export const routingPut = z.object({ routing: routingSchema, limits: limitsSchema });
export type RoutingPut = z.infer<typeof routingPut>;
