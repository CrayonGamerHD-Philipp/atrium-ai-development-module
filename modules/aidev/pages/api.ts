/**
 * Typisierte Client-Funktionen für alle Browser-Endpunkte des Moduls (Vertrag: Tabelle über `API_DOC` in
 * `../schemas.ts`). `apiFetch` setzt `/api/v1` selbst davor und liefert `data` aus `{ data }`.
 */
import { apiFetch } from '$lib/sdk/client';
import type { z } from 'zod';
import type { gitStatusResult, WorkspaceTarget } from '../protocol';
import type {
	AccountDto,
	AccountPatch,
	ChatActionDecision,
	ChatInput,
	ChatMessageDto,
	DiffDto,
	FileDto,
	FsListDto,
	Limits,
	OverviewDto,
	ProjectDto,
	ProjectInput,
	ProjectPatch,
	PullRequestDto,
	RunEventDto,
	RunnerDto,
	Routing,
	TaskDetailDto,
	TaskDto,
	TaskInput,
	TaskPatch,
	TerminalDto
} from '../schemas';

/** Pfad für `apiFetch` (ohne `/api/v1`) */
export const API = '/modules/aidev';
/** Voller Pfad für `EventSource` */
export const API_BASE = '/api/v1/modules/aidev';
/** Basis der Seiten */
export const BASE = '/modules/aidev';

export type GitStatus = z.infer<typeof gitStatusResult>;
export type Ok = { ok: boolean };
export type RepoCheck = {
	ok: boolean;
	message: string;
	defaultBranch: string | null;
	canPush: boolean;
};
export type MergeMethod = 'squash' | 'merge' | 'rebase';

const enc = encodeURIComponent;
const json = (body: unknown) => JSON.stringify(body);
const qs = (params: Record<string, string | number | undefined | null>) => {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params))
		if (v !== undefined && v !== null) q.set(k, String(v));
	const s = q.toString();
	return s ? `?${s}` : '';
};

// ---------------------------------------------------------------- Seiten-Links

export const projectPath = (id: string, tab?: string) =>
	`${BASE}/projects/${id}${tab ? `?tab=${tab}` : ''}`;
export const taskPath = (projectId: string, taskId: string) =>
	`${BASE}/projects/${projectId}/tasks/${taskId}`;
export const workspacePath = (projectId: string, target?: string) =>
	`${BASE}/projects/${projectId}/workspace${target && target !== 'main' ? `?target=${enc(target)}` : ''}`;

// ---------------------------------------------------------------- Übersicht

export const getOverview = () => apiFetch<OverviewDto>(`${API}/overview`);

// ---------------------------------------------------------------- Projekte

export const listProjects = () => apiFetch<ProjectDto[]>(`${API}/projects`);
export const getProject = (id: string) => apiFetch<ProjectDto>(`${API}/projects/${id}`);
export const createProject = (input: Partial<ProjectInput> & Pick<ProjectInput, 'name' | 'repo'>) =>
	apiFetch<ProjectDto>(`${API}/projects`, { method: 'POST', body: json(input) });
export const updateProject = (id: string, patch: ProjectPatch) =>
	apiFetch<ProjectDto>(`${API}/projects/${id}`, { method: 'PATCH', body: json(patch) });
export const archiveProject = (id: string) =>
	apiFetch<Ok>(`${API}/projects/${id}`, { method: 'DELETE' });
export const checkProject = (id: string) =>
	apiFetch<RepoCheck>(`${API}/projects/${id}/check`, { method: 'POST' });

// ---------------------------------------------------------------- Aufträge

export const listTasks = (
	projectId: string,
	opts: { status?: 'open' | 'all' | 'done'; limit?: number } = {}
) =>
	apiFetch<TaskDto[]>(
		`${API}/projects/${projectId}/tasks${qs({ status: opts.status ?? 'all', limit: opts.limit ?? 500 })}`
	);
/**
 * Eingabe für einen neuen Auftrag; nur `prompt` ist Pflicht. Mit `targetPr` (Nummer eines offenen, synchronisierten
 * Pull Requests) arbeitet der Auftrag auf dessen Head-Branch und aktualisiert den PR, statt einen neuen zu öffnen.
 */
export type NewTaskInput = Partial<TaskInput> & Pick<TaskInput, 'prompt'>;
export const createTask = (projectId: string, input: NewTaskInput) =>
	apiFetch<TaskDto>(`${API}/projects/${projectId}/tasks`, { method: 'POST', body: json(input) });
export const getTask = (id: string) => apiFetch<TaskDetailDto>(`${API}/tasks/${id}`);
export const updateTask = (id: string, patch: TaskPatch) =>
	apiFetch<TaskDto>(`${API}/tasks/${id}`, { method: 'PATCH', body: json(patch) });
export const queueTask = (id: string) =>
	apiFetch<TaskDto>(`${API}/tasks/${id}/queue`, { method: 'POST' });
export const cancelTask = (id: string) =>
	apiFetch<TaskDto>(`${API}/tasks/${id}/cancel`, { method: 'POST' });
export const retryTask = (id: string) =>
	apiFetch<TaskDto>(`${API}/tasks/${id}/retry`, { method: 'POST' });
export const replyTask = (id: string, message: string) =>
	apiFetch<TaskDto>(`${API}/tasks/${id}/reply`, { method: 'POST', body: json({ message }) });
export const deleteTask = (id: string) => apiFetch<Ok>(`${API}/tasks/${id}`, { method: 'DELETE' });
/** Eigenen, noch nicht verwendeten Upload löschen (verknüpft → 409, fremd/unbekannt → 404) */
export const deleteAttachment = (id: string) =>
	apiFetch<Ok>(`${API}/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const getTaskDiff = (id: string) => apiFetch<DiffDto>(`${API}/tasks/${id}/diff`);
export const getRunEvents = (runId: string, afterSeq = -1, limit = 2000) =>
	apiFetch<RunEventDto[]>(`${API}/runs/${runId}/events${qs({ afterSeq, limit })}`);

// ---------------------------------------------------------------- Chat

export const listChat = (projectId: string, opts: { before?: string; limit?: number } = {}) =>
	apiFetch<ChatMessageDto[]>(
		`${API}/projects/${projectId}/chat${qs({ before: opts.before, limit: opts.limit ?? 50 })}`
	);
export const postChat = (projectId: string, input: Partial<ChatInput> & Pick<ChatInput, 'body'>) =>
	apiFetch<{ message: ChatMessageDto; task: TaskDto | null; mode: 'task' | 'question' | 'note' }>(
		`${API}/projects/${projectId}/chat`,
		{
			method: 'POST',
			body: json(input)
		}
	);

/** Aktionsvorschlag `index` einer Agent-Nachricht übernehmen oder verwerfen (Fehler → Zustand `failed`) */
export const decideChatAction = (
	messageId: string,
	index: number,
	decision: ChatActionDecision['decision']
) =>
	apiFetch<{ message: ChatMessageDto; task: TaskDto | null }>(
		`${API}/chat/${messageId}/actions/${index}`,
		{ method: 'POST', body: json({ decision }) }
	);

// ---------------------------------------------------------------- Pull Requests

export const listPulls = (projectId: string) =>
	apiFetch<PullRequestDto[]>(`${API}/projects/${projectId}/pulls`);
export const syncPulls = (projectId: string) =>
	apiFetch<PullRequestDto[]>(`${API}/projects/${projectId}/pulls/sync`, { method: 'POST' });
export const mergePull = (projectId: string, number: number, method: MergeMethod) =>
	apiFetch<PullRequestDto>(`${API}/projects/${projectId}/pulls/${number}/merge`, {
		method: 'POST',
		body: json({ method })
	});

// ---------------------------------------------------------------- Workspace

export const listFiles = (projectId: string, target: WorkspaceTarget | string, path = '') =>
	apiFetch<FsListDto>(`${API}/projects/${projectId}/files${qs({ target, path })}`);
export const readFile = (projectId: string, target: WorkspaceTarget | string, path: string) =>
	apiFetch<FileDto>(`${API}/projects/${projectId}/file${qs({ target, path })}`);
export const writeFile = (
	projectId: string,
	target: WorkspaceTarget | string,
	path: string,
	content: string
) =>
	apiFetch<Ok>(`${API}/projects/${projectId}/file`, {
		method: 'PUT',
		body: json({ target, path, content })
	});
export const deleteFile = (projectId: string, target: WorkspaceTarget | string, path: string) =>
	apiFetch<Ok>(`${API}/projects/${projectId}/file${qs({ target, path })}`, { method: 'DELETE' });
export const getGitStatus = (projectId: string, target: WorkspaceTarget | string) =>
	apiFetch<GitStatus>(`${API}/projects/${projectId}/git/status${qs({ target })}`);

// ---------------------------------------------------------------- Terminal

export const openTerminal = (
	projectId: string,
	input: { target: WorkspaceTarget | string; cols: number; rows: number }
) =>
	apiFetch<TerminalDto>(`${API}/projects/${projectId}/terminal`, {
		method: 'POST',
		body: json(input)
	});
export const terminalInput = (sid: string, data: string) =>
	apiFetch<Ok>(`${API}/terminal/${sid}/input`, { method: 'POST', body: json({ data }) });
export const terminalResize = (sid: string, cols: number, rows: number) =>
	apiFetch<Ok>(`${API}/terminal/${sid}/resize`, { method: 'POST', body: json({ cols, rows }) });
export const closeTerminal = (sid: string) =>
	apiFetch<Ok>(`${API}/terminal/${sid}`, { method: 'DELETE' });

// ---------------------------------------------------------------- Runner, Konten, Verteilung

export const listRunners = () => apiFetch<RunnerDto[]>(`${API}/runners`);
export const updateRunner = (
	id: string,
	patch: { name?: string; status?: 'approved' | 'disabled'; maxSlots?: number }
) => apiFetch<RunnerDto>(`${API}/runners/${id}`, { method: 'PATCH', body: json(patch) });
export const deleteRunner = (id: string) =>
	apiFetch<Ok>(`${API}/runners/${id}`, { method: 'DELETE' });
export const listAccounts = () => apiFetch<AccountDto[]>(`${API}/accounts`);
export const updateAccount = (id: string, patch: AccountPatch) =>
	apiFetch<AccountDto>(`${API}/accounts/${id}`, { method: 'PATCH', body: json(patch) });
export const clearCooldown = (id: string) =>
	apiFetch<AccountDto>(`${API}/accounts/${id}/clear-cooldown`, { method: 'POST' });
export const getRouting = () => apiFetch<{ routing: Routing; limits: Limits }>(`${API}/routing`);
export const putRouting = (routing: Routing, limits: Limits) =>
	apiFetch<{ routing: Routing; limits: Limits }>(`${API}/routing`, {
		method: 'PUT',
		body: json({ routing, limits })
	});
