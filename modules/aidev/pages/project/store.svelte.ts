/**
 * Zustand eines Projekts im Browser: Projekt, Aufträge, Chat, Pull Requests – live über `/projects/:id/live`.
 * Nach einem Wiederverbinden wird alles Geladene neu geholt (Ereignisse dazwischen sind verloren).
 */
import { ApiClientError } from '$lib/sdk/client';
import type { RunEvent } from '../../protocol';
import type {
	ChatMessageDto,
	ProjectDto,
	ProjectLiveEvent,
	PullRequestDto,
	RunSummaryDto,
	TaskDto
} from '../../schemas';
import { getProject, listChat, listPulls, listTasks } from '../api';
import { errMsg } from '../format';
import { LiveStream } from '../live.svelte';

export interface ProjectStoreHooks {
	/** Lauf-Ereignisse (Live-Log) */
	onRunEvents?(runId: string, taskId: string, events: RunEvent[]): void;
	onTask?(task: TaskDto): void;
	onRun?(run: RunSummaryDto & { taskId: string }): void;
	onTaskDeleted?(taskId: string): void;
	/** Nach Wiederverbinden (zusätzlich zum eigenen Nachladen) */
	onReconnect?(): void;
}

const CHAT_PAGE = 50;

export class ProjectStore {
	project = $state<ProjectDto | null>(null);
	tasks = $state<TaskDto[]>([]);
	loading = $state(true);
	error = $state('');
	notFound = $state(false);
	revoked = $state(false);

	chat = $state<ChatMessageDto[]>([]);
	chatLoaded = $state(false);
	chatLoading = $state(false);
	chatError = $state('');
	chatHasMore = $state(false);

	pulls = $state<PullRequestDto[]>([]);
	pullsLoaded = $state(false);
	pullsLoading = $state(false);
	pullsError = $state('');

	readonly live: LiveStream<ProjectLiveEvent>;
	private hooks: ProjectStoreHooks = {};

	constructor(readonly id: string) {
		this.live = new LiveStream<ProjectLiveEvent>({
			path: `/projects/${id}/live`,
			withClient: true,
			onEvent: (e) => this.handle(e),
			onReconnect: () => {
				void this.reload();
				this.hooks.onReconnect?.();
			},
			onRevoked: () => (this.revoked = true)
		});
	}

	setHooks(hooks: ProjectStoreHooks) {
		this.hooks = hooks;
	}

	start() {
		void this.load();
		this.live.connect();
	}

	stop() {
		this.live.close();
	}

	async load() {
		this.loading = true;
		this.error = '';
		this.notFound = false;
		try {
			const [project, tasks] = await Promise.all([getProject(this.id), listTasks(this.id)]);
			this.project = project;
			this.tasks = tasks;
		} catch (e) {
			if (e instanceof ApiClientError && [400, 404, 422].includes(e.status)) this.notFound = true;
			else this.error = errMsg(e, 'Projekt konnte nicht geladen werden');
		} finally {
			this.loading = false;
		}
	}

	async reloadTasks() {
		try {
			this.tasks = await listTasks(this.id);
		} catch {
			// nächster Versuch beim nächsten Ereignis/Wiederverbinden
		}
	}

	private async reload() {
		await Promise.all([
			this.load(),
			this.chatLoaded ? this.loadChat() : Promise.resolve(),
			this.pullsLoaded ? this.loadPulls() : Promise.resolve()
		]);
	}

	async loadChat() {
		this.chatLoading = true;
		this.chatError = '';
		try {
			const page = await listChat(this.id, { limit: CHAT_PAGE });
			this.chat = [...page].reverse();
			this.chatHasMore = page.length >= CHAT_PAGE;
			this.chatLoaded = true;
		} catch (e) {
			this.chatError = errMsg(e, 'Chat konnte nicht geladen werden');
		} finally {
			this.chatLoading = false;
		}
	}

	async loadOlderChat() {
		const oldest = this.chat[0];
		if (!oldest) return;
		this.chatLoading = true;
		try {
			const page = await listChat(this.id, { before: oldest.createdAt, limit: CHAT_PAGE });
			const known = new Set(this.chat.map((m) => m.id));
			this.chat = [...[...page].reverse().filter((m) => !known.has(m.id)), ...this.chat];
			this.chatHasMore = page.length >= CHAT_PAGE;
		} catch (e) {
			this.chatError = errMsg(e, 'Ältere Nachrichten konnten nicht geladen werden');
		} finally {
			this.chatLoading = false;
		}
	}

	addChat(message: ChatMessageDto) {
		if (this.chat.some((m) => m.id === message.id)) return;
		this.chat = [...this.chat, message].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	async loadPulls() {
		this.pullsLoading = true;
		this.pullsError = '';
		try {
			this.pulls = await listPulls(this.id);
			this.pullsLoaded = true;
		} catch (e) {
			this.pullsError = errMsg(e, 'Pull Requests konnten nicht geladen werden');
		} finally {
			this.pullsLoading = false;
		}
	}

	setPulls(pulls: PullRequestDto[]) {
		this.pulls = pulls;
		this.pullsLoaded = true;
	}

	upsertPull(pr: PullRequestDto) {
		const i = this.pulls.findIndex((p) => p.number === pr.number);
		this.pulls = i >= 0 ? this.pulls.map((p, j) => (j === i ? pr : p)) : [pr, ...this.pulls];
	}

	upsertTask(task: TaskDto) {
		const i = this.tasks.findIndex((t) => t.id === task.id);
		this.tasks = i >= 0 ? this.tasks.map((t, j) => (j === i ? task : t)) : [task, ...this.tasks];
	}

	private applyRun(run: RunSummaryDto & { taskId: string }) {
		const { taskId, ...summary } = run;
		this.tasks = this.tasks.map((t) => {
			if (t.id !== taskId) return t;
			if (t.lastRun && t.lastRun.id !== summary.id && t.lastRun.attempt > summary.attempt) return t;
			return { ...t, lastRun: summary };
		});
	}

	private handle(e: ProjectLiveEvent) {
		switch (e.type) {
			case 'task':
				this.upsertTask(e.task);
				this.hooks.onTask?.(e.task);
				break;
			case 'task-deleted':
				this.tasks = this.tasks.filter((t) => t.id !== e.taskId);
				this.hooks.onTaskDeleted?.(e.taskId);
				break;
			case 'run':
				this.applyRun(e.run);
				this.hooks.onRun?.(e.run);
				break;
			case 'run-events':
				this.hooks.onRunEvents?.(e.runId, e.taskId, e.events);
				break;
			case 'chat':
				if (this.chatLoaded) this.addChat(e.message);
				break;
			case 'pr':
				if (this.pullsLoaded) this.upsertPull(e.pr);
				break;
			case 'project':
				this.project = e.project;
				break;
			case 'access':
				// Rechte geändert → neu laden (Server filtert)
				void this.reload();
				break;
			default:
				break;
		}
	}
}
