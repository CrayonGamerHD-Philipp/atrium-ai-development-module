/**
 * Protokoll Runner ↔ Atrium (Modul `aidev`). Reine Zod-Schemas ohne Atrium-Importe: der Runner (`runner/`) bündelt
 * diese Datei mit (nur `zod`). Änderungen hier betreffen BEIDE Seiten – abwärtskompatibel halten (`PROTOCOL_VERSION`).
 *
 * Transport (alle Pfade relativ zu `/api/v1/modules/aidev`, Authentifizierung `Authorization: Bearer <API-Key>` eines
 * technischen Kontos mit Recht `aidev.runner.connect`):
 * - Runner → Atrium: JSON-POSTs (`/runner/...`), Antwort `{ data: … }` wie jede Atrium-API.
 * - Atrium → Runner: Server-Sent Events `GET /runner/stream` mit `RunnerCommand`-Ereignissen (`data: <json>`).
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const PROVIDERS = ['claude', 'codex', 'gemini', 'openai-api', 'fake'] as const;
export const providerSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof providerSchema>;

export const ROLES = ['orchestrate', 'research', 'implement', 'review', 'fix', 'resolve'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/** Rollen ohne Schreibzugriff auf das Repo (keine Commits, kein Push) */
export const READ_ONLY_ROLES: readonly Role[] = ['orchestrate', 'research', 'review'];

export const COMMIT_POLICIES = ['pr', 'pr-automerge', 'direct'] as const;
export const commitPolicySchema = z.enum(COMMIT_POLICIES);
export type CommitPolicy = z.infer<typeof commitPolicySchema>;

export const taskDeliverySchema = z.enum(['project', 'branch']);
export type TaskDelivery = z.infer<typeof taskDeliverySchema>;

const id = z.string().uuid();
const shortText = (max: number) => z.string().max(max);

// ---------------------------------------------------------------- Limit-Stand

/**
 * Limit-Fenster der Anbieter. Claude: `five_hour` → `5h`, `seven_day` → `week`, `seven_day_opus` → `week-opus`,
 * `seven_day_sonnet` → `week-sonnet`; Codex: primäres/sekundäres Fenster nach Dauer (`5h`/`week`); Tageskontingente
 * (z. B. Gemini) → `daily`; Overage und unbekannte Fenster → `other`.
 */
export const LIMIT_WINDOWS = ['5h', 'week', 'week-opus', 'week-sonnet', 'daily', 'other'] as const;

export const limitWindowSchema = z.object({
	window: z.enum(LIMIT_WINDOWS),
	/** Anzeigename bzw. Originalbezeichnung des Anbieters (z. B. `seven_day_sonnet`) */
	label: shortText(80).default(''),
	/** Auslastung in Prozent (0–100; über 100 bei genutztem Overage), `null` = unbekannt */
	usedPercent: z.number().min(0).max(1000).nullable().default(null),
	resetsAt: z.string().datetime({ offset: true }).nullable().default(null),
	status: z.enum(['allowed', 'warning', 'rejected', 'unknown']).default('unknown'),
	/**
	 * Beobachtungszeit dieses Fensters (Runner-Uhr), sofern es älter ist als der Schnappschuss (`observedAt`).
	 * Optional (ältere Runner senden es nicht) → es gilt `observedAt` des Schnappschusses.
	 */
	observedAt: z.string().datetime({ offset: true }).optional()
});
export type LimitWindow = z.infer<typeof limitWindowSchema>;

export const limitSnapshotSchema = z.object({
	/** Zeitpunkt der Beobachtung durch den Runner */
	observedAt: z.string().datetime({ offset: true }),
	/** `stream`: aus Ereignissen eines Laufs, `probe`: aktive Abfrage, `error`: aus einer Fehlermeldung abgeleitet */
	source: z.enum(['stream', 'probe', 'error']),
	windows: z.array(limitWindowSchema).max(10)
});
export type LimitSnapshot = z.infer<typeof limitSnapshotSchema>;

// ---------------------------------------------------------------- Registrierung / Heartbeat

export const runnerAccountSchema = z.object({
	/** Eindeutig je Runner, z. B. `claude-main` (Konfiguration des Runners) */
	key: z
		.string()
		.min(1)
		.max(60)
		.regex(/^[a-z0-9][a-z0-9-]*$/),
	provider: providerSchema,
	label: shortText(120).default(''),
	loggedIn: z.boolean(),
	models: z.array(shortText(120)).max(50).default([])
});
export type RunnerAccount = z.infer<typeof runnerAccountSchema>;

export const registerInput = z.object({
	protocol: z.number().int(),
	name: z.string().min(1).max(80),
	version: shortText(40),
	maxSlots: z.number().int().min(0).max(64),
	capabilities: z.object({
		question: z.boolean().optional(),
		/** Kann Anhänge für einen Lauf herunterladen und bereitstellen */
		attachments: z.boolean().optional(),
		/** Versteht `delivery.mode = 'branch'` (ältere Runner verwerfen solche Angebote) */
		branchDelivery: z.boolean().optional(),
		/** Versteht `delivery.mode = 'pr-update'` (ältere Runner verwerfen solche Angebote) */
		prUpdate: z.boolean().optional(),
		/** Meldet den Limit-Stand der Konten im Heartbeat (`accounts[].limits`) */
		limitReport: z.boolean().optional(),
		/** Versteht RPC `git.branch-delete` (Atrium sendet ihn nur an solche Runner) */
		branchCleanup: z.boolean().optional(),
		git: z.boolean(),
		gh: z.boolean(),
		pty: z.boolean(),
		os: shortText(40).default('')
	}),
	accounts: z.array(runnerAccountSchema).max(50),
	/**
	 * Läufe, die der Runner bei der Anmeldung ausführt (nach einem Neustart: keine). Laufende Läufe dieses Runners,
	 * die hier fehlen, gibt Atrium sofort frei, statt auf das Ende der Lease zu warten. Fehlt das Feld (ältere
	 * Runner), bleibt es beim Lease-Ablauf.
	 */
	runIds: z.array(id).max(64).optional()
});
export type RegisterInput = z.infer<typeof registerInput>;

export const registerResult = z.object({
	runnerId: id,
	status: z.enum(['pending', 'approved', 'disabled']),
	heartbeatSec: z.number().int()
});
export type RegisterResult = z.infer<typeof registerResult>;

export const heartbeatInput = z.object({
	slotsUsed: z.number().int().min(0),
	/** Läufe, die der Runner gerade ausführt (verlängert deren Lease) */
	runIds: z.array(id).max(64),
	/**
	 * Runner wird beendet und lässt laufende Läufe noch fertig werden (`DRAIN_SEC`): keine neuen Angebote.
	 * Fehlt das Feld (ältere Runner), gilt `false`.
	 */
	draining: z.boolean().optional(),
	accounts: z
		.array(
			z.object({
				key: runnerAccountSchema.shape.key,
				loggedIn: z.boolean(),
				/** Zuletzt beobachteter Limit-Stand (nur Runner mit `capabilities.limitReport`) */
				limits: limitSnapshotSchema.optional()
			})
		)
		.max(50)
		.default([])
});
export type HeartbeatInput = z.infer<typeof heartbeatInput>;

export const heartbeatResult = z.object({
	status: z.enum(['pending', 'approved', 'disabled']),
	/** Läufe, die der Runner abbrechen soll (unbekannt, abgebrochen oder anderem Runner zugeteilt) */
	cancel: z.array(id)
});
export type HeartbeatResult = z.infer<typeof heartbeatResult>;

// ---------------------------------------------------------------- Auftrag an den Runner

export const deliverySchema = z.discriminatedUnion('mode', [
	/** Nichts pushen (Nur-Lese-Rollen) */
	z.object({ mode: z.literal('none') }),
	/** Branch pushen und PR öffnen; `autoMerge` → `gh pr merge --auto --squash` */
	z.object({
		mode: z.literal('pr'),
		autoMerge: z.boolean(),
		title: shortText(200),
		body: shortText(20_000)
	}),
	/** Direkt auf den Haupt-Branch (rebase + push, wenige Wiederholungen) */
	z.object({ mode: z.literal('direct') }),
	/** Eigenen Branch pushen, ohne PR oder Push auf den Haupt-Branch */
	z.object({ mode: z.literal('branch') }),
	/**
	 * Teilauftrag: eigenen Branch in den Integrations-Branch des Elternauftrags mergen und pushen.
	 * `pullNumber`: Der Integrations-Branch ist der Head-Branch dieses bestehenden PR – der Runner prüft den PR
	 * (offen, kein Fork, passender Branch) und legt den Branch nie neu an (nur an Runner mit `prUpdate`).
	 */
	z.object({
		mode: z.literal('integrate'),
		integrationBranch: shortText(200),
		pullNumber: z.number().int().positive().optional()
	}),
	/**
	 * Bestehenden PR `number` bearbeiten: in dessen Head-Branch (= `offer.branch`) pushen,
	 * keinen neuen PR öffnen, kein Force-Push; Ergebnis als PR-Kommentar.
	 * `integrated`: Teilaufträge einer Orchestrierung haben bereits Änderungen in den PR-Branch gemergt – der PR
	 * gilt dann auch ohne neuen Commit als aktualisiert.
	 */
	z.object({
		mode: z.literal('pr-update'),
		number: z.number().int().positive(),
		integrated: z.boolean().optional()
	})
]);
export type Delivery = z.infer<typeof deliverySchema>;

/** Metadaten eines Anhangs; die Bytes werden für den Lauf binär heruntergeladen. */
export const attachmentOfferSchema = z.object({
	id,
	name: z.string().min(1).max(120),
	mime: z.string().min(1),
	size: z
		.number()
		.int()
		.positive()
		.max(10 * 1024 * 1024),
	sha256: z.string().regex(/^[0-9a-f]{64}$/)
});
export type AttachmentOffer = z.infer<typeof attachmentOfferSchema>;

export const runOfferSchema = z.object({
	runId: id,
	taskId: id,
	attempt: z.number().int(),
	role: roleSchema,
	title: shortText(200),
	/** Vollständiger Auftragstext inkl. Kontext (Ergebnisse von Vorgänger-Aufträgen, Rückfragen) */
	prompt: z.string(),
	/** Zusätzliche Systemanweisung (Rolle, Projektregeln, Ausgabeformat) */
	systemPrompt: z.string(),
	project: z.object({
		id,
		name: shortText(120),
		repoOwner: shortText(100),
		repoName: shortText(100),
		defaultBranch: shortText(200),
		setupCmd: shortText(2000),
		testCmd: shortText(2000)
	}),
	account: z.object({ key: runnerAccountSchema.shape.key, provider: providerSchema }),
	model: shortText(120).nullable(),
	/** Arbeits-Branch dieses Laufs */
	branch: shortText(200),
	/** Ausgangspunkt (`origin/<branch>`), z. B. Haupt-Branch oder Integrations-Branch */
	baseRef: shortText(200),
	readOnly: z.boolean(),
	question: z.boolean().optional(),
	/** Orchestrierung: Agent muss einen Plan als JSON (`planSchema`) ausgeben */
	expectPlan: z.boolean(),
	resumeSessionId: shortText(200).nullable(),
	/** Anhänge dieses Laufs; ältere Angebote enthalten das Feld nicht. */
	attachments: z.array(attachmentOfferSchema).max(10).optional(),
	delivery: deliverySchema,
	leaseSec: z.number().int(),
	/** Harte Obergrenze für die Laufzeit des Agent-Prozesses */
	timeoutSec: z.number().int()
});
export type RunOffer = z.infer<typeof runOfferSchema>;

/** Plan eines Orchestrierungs-Laufs: Teilaufträge mit Abhängigkeiten (über `key`) */
export const planSchema = z.object({
	summary: shortText(4000).default(''),
	/**
	 * Slug-Vorschlag für den Integrations-Branch (2–5 Wörter Kebab-Case, z. B. `branch-namen-aufraeumen`).
	 * Tolerant: ein ungültiger Wert wird verworfen, ohne den Plan ungültig zu machen.
	 */
	branch: z.string().max(80).optional().catch(undefined),
	subtasks: z
		.array(
			z.object({
				key: z
					.string()
					.min(1)
					.max(40)
					.regex(/^[A-Za-z0-9_-]+$/),
				title: z.string().min(1).max(200),
				prompt: z.string().min(1).max(20_000),
				role: z.enum(['research', 'implement', 'review', 'fix']),
				dependsOn: z.array(z.string().max(40)).max(20).default([]),
				provider: providerSchema.optional()
			})
		)
		.min(1)
		.max(20)
});
export type Plan = z.infer<typeof planSchema>;

// ---------------------------------------------------------------- Befehle Atrium → Runner (SSE)

export const workspaceTargetSchema = z
	.string()
	.max(80)
	.regex(/^(main|run:[0-9a-f-]{36})$/);
/** `main` = dauerhafte Arbeitskopie des Haupt-Branchs je Projekt, `run:<id>` = Worktree eines Laufs */
export type WorkspaceTarget = z.infer<typeof workspaceTargetSchema>;

export const RPC_OPS = [
	'fs.list',
	'fs.read',
	'fs.write',
	'fs.delete',
	'git.status',
	'git.diff',
	'git.log',
	'gh.pr-list',
	'gh.pr-merge',
	'repo.check',
	'git.branch-delete'
] as const;
export const rpcOpSchema = z.enum(RPC_OPS);
export type RpcOp = z.infer<typeof rpcOpSchema>;

export const rpcProjectSchema = z.object({
	id,
	repoOwner: shortText(100),
	repoName: shortText(100),
	defaultBranch: shortText(200)
});
export type RpcProject = z.infer<typeof rpcProjectSchema>;

export const rpcCommandSchema = z.object({
	type: z.literal('rpc'),
	reqId: id,
	op: rpcOpSchema,
	project: rpcProjectSchema,
	target: workspaceTargetSchema.default('main'),
	/** Je `op`: `fs.*` → `{ path, content? }`, `git.diff` → `{ base?, head? }`, `gh.pr-merge` → `{ number, method }`,
	 *  `git.branch-delete` → `{ branches: string[], expect?: Record<Branch, SHA> }` (höchstens `MAX_BRANCH_DELETE`,
	 *  Antwort `branchDeleteResult`; `expect` = erwarteter Remote-Stand, abweichend → `kept` mit `changed`),
	 *  `repo.check` → `{}` (Antwort `repoCheckResult` inkl. optionaler Branch-Liste `branches`) */
	args: z.record(z.string(), z.unknown()).default({})
});
export type RpcCommand = z.infer<typeof rpcCommandSchema>;

export const runnerCommandSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('hello'), runnerId: id, status: registerResult.shape.status }),
	z.object({ type: z.literal('offer'), offer: runOfferSchema }),
	z.object({ type: z.literal('cancel'), runId: id, reason: shortText(200).default('') }),
	rpcCommandSchema,
	z.object({
		type: z.literal('pty-open'),
		sid: id,
		project: rpcProjectSchema,
		target: workspaceTargetSchema,
		cols: z.number().int().min(10).max(500),
		rows: z.number().int().min(5).max(200)
	}),
	z.object({ type: z.literal('pty-input'), sid: id, data: z.string().max(65_536) }),
	z.object({
		type: z.literal('pty-resize'),
		sid: id,
		cols: z.number().int().min(10).max(500),
		rows: z.number().int().min(5).max(200)
	}),
	z.object({ type: z.literal('pty-close'), sid: id }),
	/** Freigabe entzogen o. Ä.: Runner beendet seine Verbindung und meldet sich neu an */
	z.object({ type: z.literal('revoked') })
]);
export type RunnerCommand = z.infer<typeof runnerCommandSchema>;

// ---------------------------------------------------------------- Rückmeldungen Runner → Atrium

export const RUN_EVENT_KINDS = [
	'text',
	'thinking',
	'tool',
	'tool-result',
	'status',
	'stderr',
	'git',
	'error',
	'system'
] as const;
export const runEventKindSchema = z.enum(RUN_EVENT_KINDS);
export type RunEventKind = z.infer<typeof runEventKindSchema>;

export const runEventSchema = z.object({
	seq: z.number().int().min(0),
	ts: z.string().datetime({ offset: true }),
	kind: runEventKindSchema,
	/** `text`/`thinking`/`stderr`/`status`/`error`: `{ text }`; `tool`: `{ name, input }`; `tool-result`: `{ name?, output, isError? }`; `git`: `{ action, detail }` */
	payload: z.record(z.string(), z.unknown())
});
export type RunEvent = z.infer<typeof runEventSchema>;

/** Höchstwerte je Batch (Body-Limit der Atrium-API: 1 MB) */
export const MAX_EVENTS_PER_BATCH = 200;
export const MAX_EVENT_TEXT = 16_000;

export const eventsInput = z.object({
	events: z.array(runEventSchema).min(1).max(MAX_EVENTS_PER_BATCH)
});
export type EventsInput = z.infer<typeof eventsInput>;

export const usageInput = z.object({
	model: shortText(120).default(''),
	inputTokens: z.number().int().min(0),
	outputTokens: z.number().int().min(0),
	cacheReadTokens: z.number().int().min(0).default(0),
	cacheWriteTokens: z.number().int().min(0).default(0),
	costUsd: z.number().min(0).nullable().default(null)
});
export type UsageInput = z.infer<typeof usageInput>;

export const LIMIT_KINDS = ['rate', '5h', 'week', 'auth', 'other'] as const;
export const limitInput = z.object({
	kind: z.enum(LIMIT_KINDS),
	resetsAt: z.string().datetime({ offset: true }).nullable().default(null),
	raw: shortText(2000).default(''),
	/** Limit-Fenster zum Zeitpunkt des Treffers (sofern bekannt) */
	windows: z.array(limitWindowSchema).max(10).optional()
});
export type LimitInput = z.infer<typeof limitInput>;

export const commitInfoSchema = z.object({
	sha: z.string().regex(/^[0-9a-f]{7,40}$/),
	message: shortText(4000),
	additions: z.number().int().min(0).default(0),
	deletions: z.number().int().min(0).default(0),
	files: z.array(shortText(500)).max(500).default([])
});
export type CommitInfo = z.infer<typeof commitInfoSchema>;

export const ERROR_KINDS = [
	'agent',
	'timeout',
	'limit',
	'auth',
	'git',
	'conflict',
	'tests',
	'setup',
	'cancelled',
	'internal'
] as const;

export const finishInput = z.object({
	status: z.enum(['succeeded', 'failed', 'limited', 'cancelled']),
	sessionId: shortText(200).nullable().default(null),
	headSha: z
		.string()
		.regex(/^[0-9a-f]{7,40}$/)
		.nullable()
		.default(null),
	branch: shortText(200).nullable().default(null),
	commits: z.array(commitInfoSchema).max(200).default([]),
	pr: z
		.object({ number: z.number().int().positive(), url: z.string().url().max(500) })
		.nullable()
		.default(null),
	/** Direkt gepusht (`direct`) bzw. sofort gemergt */
	merged: z.boolean().default(false),
	/** Der Ergebnis-Branch wurde erfolgreich gepusht. */
	branchPushed: z.boolean().default(false),
	/** Letzte Antwort des Agents (Zusammenfassung, bei Recherche das Ergebnis) */
	summary: shortText(40_000).nullable().default(null),
	/** Nur bei `expectPlan`: geparster Plan (Atrium prüft erneut gegen `planSchema`) */
	plan: z.unknown().optional(),
	errorKind: z.enum(ERROR_KINDS).nullable().default(null),
	errorMessage: shortText(4000).nullable().default(null),
	/** Konflikt-Dateien (bei `errorKind: 'conflict'`) */
	conflictFiles: z.array(shortText(500)).max(200).default([])
});
export type FinishInput = z.infer<typeof finishInput>;

export const rejectInput = z.object({ reason: shortText(500) });

export const rpcResponseInput = z.object({
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: shortText(4000).optional()
});
export type RpcResponseInput = z.infer<typeof rpcResponseInput>;

export const ptyOutputInput = z.object({
	seq: z.number().int().min(0),
	/** UTF-8-Text der Terminal-Ausgabe (Runner dekodiert mit `TextDecoder({ stream: true })`) */
	data: z.string().max(200_000)
});
export const ptyExitInput = z.object({ code: z.number().int().nullable() });

// ---------------------------------------------------------------- Ergebnisse der RPC-Operationen

export const fsEntrySchema = z.object({
	name: z.string(),
	path: z.string(),
	type: z.enum(['file', 'dir', 'symlink']),
	size: z.number().int()
});
export type FsEntry = z.infer<typeof fsEntrySchema>;

export const fsListResult = z.object({ path: z.string(), entries: z.array(fsEntrySchema) });
export const fsReadResult = z.object({
	path: z.string(),
	encoding: z.enum(['utf8', 'base64']),
	content: z.string(),
	size: z.number().int(),
	truncated: z.boolean()
});
export const gitStatusResult = z.object({
	branch: z.string(),
	head: z.string(),
	ahead: z.number().int(),
	behind: z.number().int(),
	files: z.array(z.object({ path: z.string(), status: z.string() }))
});
export const gitDiffResult = z.object({
	base: z.string(),
	head: z.string(),
	diff: z.string(),
	truncated: z.boolean(),
	files: z.array(
		z.object({ path: z.string(), additions: z.number().int(), deletions: z.number().int() })
	)
});
export const gitLogResult = z.object({
	commits: z.array(
		z.object({
			sha: z.string(),
			message: z.string(),
			author: z.string(),
			date: z.string()
		})
	)
});
export const prInfoSchema = z.object({
	number: z.number().int(),
	title: z.string(),
	branch: z.string(),
	state: z.enum(['open', 'merged', 'closed']),
	isDraft: z.boolean(),
	mergeable: z.string(),
	checks: z.string(),
	autoMerge: z.boolean(),
	url: z.string(),
	additions: z.number().int(),
	deletions: z.number().int(),
	createdAt: z.string(),
	updatedAt: z.string(),
	/** Letzter Head-Commit (`headRefOid`); fehlt bei älteren Runnern */
	headSha: z.string().max(64).optional(),
	/** Head-Branch liegt in einem anderen Repository (Fork); fehlt bei älteren Runnern (= unbekannt) */
	crossRepository: z.boolean().optional()
});
export type PrInfo = z.infer<typeof prInfoSchema>;
export const prListResult = z.object({ pulls: z.array(prInfoSchema) });
/** Höchstzahl an Branch-Namen in der Antwort auf `repo.check` (weitere werden abgeschnitten) */
export const MAX_REPO_BRANCHES = 500;
/**
 * Antwort auf `repo.check`. `branches` = Branch-Namen des Remotes (aus `git ls-remote --heads`), duplikatfrei,
 * Default-Branch zuerst, Rest alphabetisch, höchstens `MAX_REPO_BRANCHES`; nur bei `ok: true` gefüllt.
 * `branches` fehlt bei älteren Runnern.
 */
export const repoCheckResult = z.object({
	ok: z.boolean(),
	defaultBranch: z.string().nullable(),
	canPush: z.boolean(),
	message: z.string(),
	branches: z.array(z.string().max(255)).max(MAX_REPO_BRANCHES).optional()
});

/**
 * Antwort auf `git.branch-delete`: gelöschte, nicht (mehr) vorhandene, fehlgeschlagene und bewusst behaltene
 * Branches. `kept.reason`: `open-pr` = ein offener PR nutzt den Branch als Head oder Basis (später erneut
 * versuchen), `changed` = der Remote-Stand weicht von `expect` ab (nicht löschen).
 */
export const branchDeleteResult = z.object({
	deleted: z.array(z.string()),
	missing: z.array(z.string()),
	failed: z.array(z.object({ branch: z.string(), error: z.string() })),
	kept: z.array(z.object({ branch: z.string(), reason: z.enum(['open-pr', 'changed']) })).optional()
});
/** Höchstzahl an Branches je `git.branch-delete`-Aufruf */
export const MAX_BRANCH_DELETE = 50;

/** Höchstgröße einer Datei, die der Editor liest/schreibt (JSON-Body der Atrium-API ≤ 1 MB, Base64 +33 %) */
export const MAX_FILE_BYTES = 600_000;
/** Höchstgröße eines Diffs in einer Antwort */
export const MAX_DIFF_BYTES = 700_000;
