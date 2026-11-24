<script lang="ts">
	// Auftragsdetail: Kopf mit Aktionen, Reiter Verlauf (Live-Log) · Diff · Commits · Teilaufträge · Ergebnis,
	// Rückfrage beantworten, Prompt bearbeiten. Live über den Projekt-Stream (gefiltert auf diesen Auftrag).
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Ban from '@lucide/svelte/icons/ban';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import MessageCircleQuestion from '@lucide/svelte/icons/message-circle-question';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Play from '@lucide/svelte/icons/play';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ApiClientError } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import {
		BUSY_SEND,
		ConfirmDialog,
		EmptyState,
		ErrorState,
		LoadingState,
		PageTitle
	} from '$lib/components/layout';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import type { RunEvent } from '../protocol';
	import { FINAL_TASK_STATUSES, type DiffDto, type RunDto, type TaskDetailDto } from '../schemas';
	import {
		cancelTask,
		deleteTask,
		getProject,
		getRunEvents,
		getTask,
		getTaskDiff,
		projectPath,
		queueTask,
		replyTask,
		retryTask,
		taskPath,
		workspacePath
	} from './api';
	import LiveIndicator from './components/LiveIndicator.svelte';
	import ProviderBadge from './components/ProviderBadge.svelte';
	import StatusBadge from './components/StatusBadge.svelte';
	import TimeAgo from './components/TimeAgo.svelte';
	import {
		ERROR_KIND_LABELS,
		RUN_STATUS_LABELS,
		elapsed,
		errMsg,
		firstLine,
		isUnavailable,
		roleLabel,
		shortSha,
		taskTitle,
		units
	} from './format';
	import { has, PERM } from './perms';
	import { ProjectStore } from './project/store.svelte';
	import AgentText from './task/AgentText.svelte';
	import DiffView from './task/DiffView.svelte';
	import RunLog from './task/RunLog.svelte';
	import TaskEditDialog from './task/TaskEditDialog.svelte';

	let { params }: ModulePageProps = $props();
	const projectId = $derived(params.id ?? '');
	const taskId = $derived(params.taskId ?? '');

	let detail = $state<TaskDetailDto | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let notFound = $state(false);
	let deleted = $state(false);
	let store = $state<ProjectStore | null>(null);
	let current: ProjectStore | null = null;

	// Lauf-Ereignisse je Lauf (seq aufsteigend)
	let events = $state<Record<string, RunEvent[]>>({});
	let eventsLoading = $state<Record<string, boolean>>({});
	const fetching = new Set<string>();
	let selectedRunId = $state<string | null>(null);
	let followLatest = $state(true);

	let diff = $state<DiffDto | null>(null);
	let diffLoading = $state(false);
	let diffError = $state('');
	let diffUnavailable = $state(false);

	let busy = $state('');
	let reply = $state('');
	let editOpen = $state(false);
	let deleteOpen = $state(false);
	let cancelOpen = $state(false);
	let now = $state(Date.now());

	const TABS = ['log', 'diff', 'commits', 'children', 'result'] as const;
	type Tab = (typeof TABS)[number];
	const tab = $derived.by<Tab>(() => {
		const t = page.url.searchParams.get('tab');
		return (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'log';
	});
	function setTab(next: string) {
		const url = new URL(page.url);
		if (next === 'log') url.searchParams.delete('tab');
		else url.searchParams.set('tab', next);
		void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}

	const task = $derived(detail?.task ?? null);
	const runs = $derived(
		[...(detail?.runs ?? [])].sort(
			(a, b) => b.attempt - a.attempt || b.createdAt.localeCompare(a.createdAt)
		)
	);
	const selectedRun = $derived(runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null);
	const selectedEvents = $derived(selectedRun ? (events[selectedRun.id] ?? []) : []);
	const running = $derived(selectedRun?.status === 'running' || selectedRun?.status === 'offered');

	const canCreate = $derived(has(PERM.taskCreate));
	const canManage = $derived(has(PERM.taskManage));
	const canAct = $derived(canCreate || canManage);
	const canWorkspace = $derived(has(PERM.files) || has(PERM.terminal));
	const isFinal = $derived(!!task && FINAL_TASK_STATUSES.includes(task.status));

	const actions = $derived.by(() => {
		const s = task?.status;
		return {
			queue: canAct && s === 'draft',
			cancel: canAct && !!s && ['queued', 'blocked', 'running', 'needs-input'].includes(s),
			retry: canAct && !!s && ['failed', 'cancelled'].includes(s),
			edit: canAct && !!s && ['draft', 'queued'].includes(s),
			reply: canCreate && !!s && ['needs-input', 'failed'].includes(s),
			remove: canManage && !!s && (isFinal || s === 'draft')
		};
	});

	// ---------------------------------------------------------------- Laden

	async function load(id: string, quiet = false) {
		if (!quiet) {
			loading = true;
			loadError = '';
			notFound = false;
		}
		try {
			const d = await getTask(id);
			detail = d;
			const latest = [...d.runs].sort((a, b) => b.attempt - a.attempt)[0];
			if (latest && (followLatest || !selectedRunId)) selectedRunId = latest.id;
			if (selectedRunId) void loadEvents(selectedRunId);
		} catch (e) {
			if (quiet) return;
			if (e instanceof ApiClientError && [400, 404, 422].includes(e.status)) notFound = true;
			else loadError = errMsg(e, 'Auftrag konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	let reloadTimer: ReturnType<typeof setTimeout> | null = null;
	function reloadSoon() {
		if (reloadTimer) clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => void load(taskId, true), 400);
	}

	/** Ereignisse ab dem letzten bekannten `seq` holen (seitenweise) */
	async function loadEvents(runId: string) {
		if (fetching.has(runId)) return;
		fetching.add(runId);
		if (!events[runId]) eventsLoading[runId] = true;
		try {
			for (let i = 0; i < 50; i++) {
				const list = events[runId] ?? [];
				const after = list.length ? list[list.length - 1]!.seq : -1;
				const batch = await getRunEvents(runId, after, 2000);
				merge(runId, batch);
				if (batch.length < 2000) break;
			}
		} catch (e) {
			if (!events[runId]) toast.error(errMsg(e, 'Verlauf konnte nicht geladen werden'));
		} finally {
			fetching.delete(runId);
			eventsLoading[runId] = false;
		}
	}

	function merge(runId: string, incoming: RunEvent[]) {
		const list = events[runId] ?? [];
		const last = list.length ? list[list.length - 1]!.seq : -1;
		const fresh = incoming.filter((e) => e.seq > last).sort((a, b) => a.seq - b.seq);
		if (!fresh.length && events[runId]) return;
		// Ereignisse ggf. mit `runId` (RunEventDto) – nur die RunEvent-Felder behalten
		const clean = fresh.map(({ seq, ts, kind, payload }) => ({ seq, ts, kind, payload }));
		events[runId] = [...list, ...clean];
	}

	function onRunEvents(runId: string, tId: string, incoming: RunEvent[]) {
		if (tId !== taskId) return;
		const list = events[runId];
		if (!list) {
			if (runId === selectedRun?.id) void loadEvents(runId);
			return;
		}
		const last = list.length ? list[list.length - 1]!.seq : -1;
		const first = incoming.reduce((m, e) => Math.min(m, e.seq), Infinity);
		if (first > last + 1)
			void loadEvents(runId); // Lücke → nachladen
		else merge(runId, incoming);
	}

	$effect(() => {
		const pid = projectId;
		const tid = taskId;
		untrack(() => {
			current?.stop();
			detail = null;
			events = {};
			diff = null;
			diffError = '';
			selectedRunId = null;
			followLatest = true;
			deleted = false;
			const s = new ProjectStore(pid);
			s.setHooks({
				onRunEvents,
				onTask: (t) => {
					if (!detail) return;
					if (t.id === tid) {
						const changed = detail.task.status !== t.status;
						detail = { ...detail, task: t };
						if (changed) reloadSoon();
					} else if (t.parentId === tid) {
						const i = detail.children.findIndex((c) => c.id === t.id);
						const children =
							i >= 0 ? detail.children.map((c, j) => (j === i ? t : c)) : [...detail.children, t];
						detail = { ...detail, children };
					} else if (detail.dependencies.some((d) => d.id === t.id)) {
						detail = {
							...detail,
							dependencies: detail.dependencies.map((d) =>
								d.id === t.id ? { ...d, status: t.status } : d
							)
						};
					}
				},
				onRun: (run) => {
					if (run.taskId !== tid || !detail) return;
					const known = detail.runs.find((r) => r.id === run.id);
					if (!known) {
						reloadSoon();
						return;
					}
					const { taskId: _t, ...summary } = run;
					void _t;
					detail = {
						...detail,
						runs: detail.runs.map((r) => (r.id === run.id ? { ...r, ...summary } : r))
					};
					if (['succeeded', 'failed', 'limited', 'cancelled', 'lost'].includes(run.status))
						reloadSoon();
				},
				onTaskDeleted: (id) => {
					if (id === tid) deleted = true;
				},
				onReconnect: () => {
					void load(tid, true);
					for (const runId of Object.keys(events)) void loadEvents(runId);
				}
			});
			current = s;
			store = s;
			s.live.connect();
			void getProject(pid)
				.then((p) => (s.project = p))
				.catch(() => undefined);
			void load(tid);
		});
	});

	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	onDestroy(() => {
		current?.stop();
		if (reloadTimer) clearTimeout(reloadTimer);
	});

	// Auswahl eines anderen Laufs → dessen Ereignisse laden
	$effect(() => {
		const r = selectedRun;
		if (r && !untrack(() => events[r.id])) void loadEvents(r.id);
	});

	// Diff erst beim Öffnen des Reiters laden
	$effect(() => {
		if (tab === 'diff' && task && !untrack(() => diff || diffLoading || diffError)) void loadDiff();
	});

	async function loadDiff() {
		if (!task) return;
		diffLoading = true;
		diffError = '';
		diffUnavailable = false;
		try {
			diff = await getTaskDiff(task.id);
		} catch (e) {
			diffUnavailable = isUnavailable(e);
			diffError = errMsg(e, 'Diff konnte nicht geladen werden');
		} finally {
			diffLoading = false;
		}
	}

	// ---------------------------------------------------------------- Aktionen

	async function run(label: string, fn: () => Promise<unknown>, success: string) {
		busy = label;
		try {
			const res = await fn();
			if (res && typeof res === 'object' && 'id' in res && detail)
				detail = { ...detail, task: res as TaskDetailDto['task'] };
			toast.success(success);
			reloadSoon();
		} catch (e) {
			toast.error(errMsg(e, 'Aktion fehlgeschlagen'));
		} finally {
			busy = '';
		}
	}

	async function sendReply(e: SubmitEvent) {
		e.preventDefault();
		const text = reply.trim();
		if (!text || !task) return;
		await run('reply', () => replyTask(task.id, text), 'Antwort gesendet – der Agent macht weiter');
		reply = '';
		followLatest = true;
		setTab('log');
	}

	async function remove() {
		if (!task) return;
		try {
			await deleteTask(task.id);
			toast.success('Auftrag gelöscht');
			await goto(projectPath(projectId));
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	const runOptions = $derived(
		runs.map((r) => ({
			value: r.id,
			label: `Versuch ${r.attempt} · ${r.provider} · ${RUN_STATUS_LABELS[r.status]}`
		}))
	);
	const allCommits = $derived(runs.flatMap((r) => r.commits.map((c) => ({ ...c, run: r }))));
	const childTitles = $derived(new Map((detail?.children ?? []).map((c) => [c.id, taskTitle(c)])));
	const doneChildren = $derived(detail?.children.filter((c) => c.status === 'done').length ?? 0);
	const lastFailedRun = $derived(runs.find((r) => r.errorMessage || r.errorKind) ?? null);

	function runMeta(r: RunDto) {
		const parts = [r.accountLabel, r.runnerName].filter(Boolean);
		return parts.join(' · ');
	}
</script>

<a
	href={projectPath(projectId)}
	class="mb-3 inline-flex items-center gap-1 text-sm text-link hover:underline"
>
	<ArrowLeft class="size-4" />
	{store?.project?.name ?? 'Zum Projekt'}
</a>

{#if loading && !detail}
	<LoadingState rows={5} rowClass="h-14 w-full" label="Auftrag" />
{:else if notFound}
	<EmptyState
		title="Auftrag nicht gefunden"
		description="Er wurde gelöscht oder du hast keinen Zugriff."
	>
		<Button href={projectPath(projectId)} variant="outline">Zum Projekt</Button>
	</EmptyState>
{:else if loadError && !detail}
	<ErrorState message={loadError} onretry={() => load(taskId)} />
{:else if detail && task}
	<PageTitle title={taskTitle(task)} />

	<header class="mb-4 space-y-3">
		<div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
			<div class="min-w-0 space-y-2">
				<h1 class="text-title break-words">{taskTitle(task)}</h1>
				<div class="flex flex-wrap items-center gap-2 text-sm">
					<StatusBadge status={task.status} />
					<span class="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
						{roleLabel(task.role)}
					</span>
					{#if selectedRun}
						<ProviderBadge provider={selectedRun.provider} model={selectedRun.model} />
					{:else if task.providerHint}
						<ProviderBadge provider={task.providerHint} />
						<span class="text-xs text-muted-foreground">erzwungen</span>
					{/if}
					{#if task.branch}
						<span class="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
							<GitBranch class="size-3.5" aria-hidden="true" />{task.branch}
						</span>
					{/if}
					{#if task.prUrl}
						<a
							href={task.prUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1 text-xs text-link hover:underline"
						>
							<GitPullRequest class="size-3.5" aria-hidden="true" />PR #{task.prNumber}
							<ExternalLink class="size-3" aria-hidden="true" />
						</a>
					{/if}
					<span class="text-xs text-muted-foreground">
						Versuch {task.attempts}/{task.maxAttempts} · angelegt <TimeAgo value={task.createdAt} />
					</span>
					{#if store}<LiveIndicator status={store.live.status} />{/if}
				</div>
			</div>
			<div class="flex flex-wrap gap-2 lg:justify-end">
				{#if actions.queue}
					<Button
						onclick={() => run('queue', () => queueTask(task.id), 'Auftrag eingeplant')}
						disabled={!!busy}><Play /> Aus Entwurf starten</Button
					>
				{/if}
				{#if actions.retry}
					<Button
						onclick={() => run('retry', () => retryTask(task.id), 'Neuer Versuch eingeplant')}
						disabled={!!busy}><RotateCcw /> Wiederholen</Button
					>
				{/if}
				{#if actions.edit}
					<Button variant="outline" onclick={() => (editOpen = true)} disabled={!!busy}
						><Pencil /> Bearbeiten</Button
					>
				{/if}
				{#if canWorkspace && selectedRun && (task.status === 'running' || task.branch)}
					<Button variant="outline" href={workspacePath(projectId, `run:${selectedRun.id}`)}>
						<SquareTerminal /> Worktree
					</Button>
				{/if}
				{#if actions.cancel}
					<Button variant="destructive" onclick={() => (cancelOpen = true)} disabled={!!busy}
						><Ban /> Abbrechen</Button
					>
				{/if}
				{#if actions.remove}
					<Button
						variant="ghost"
						onclick={() => (deleteOpen = true)}
						disabled={!!busy}
						aria-label="Auftrag löschen"
						title="Löschen"><Trash2 /></Button
					>
				{/if}
			</div>
		</div>

		{#if deleted}
			<Alert.Root variant="warning">
				<Alert.Title>Auftrag gelöscht</Alert.Title>
				<Alert.Description>Dieser Auftrag wurde gerade gelöscht.</Alert.Description>
			</Alert.Root>
		{/if}

		{#if actions.reply}
			<form
				class="space-y-2 rounded-lg border border-warning-border bg-warning-muted p-3"
				onsubmit={sendReply}
			>
				<Label for="task-reply" class="flex items-center gap-1.5 text-warning">
					<MessageCircleQuestion class="size-4" aria-hidden="true" />
					{task.status === 'needs-input'
						? 'Der Agent hat eine Rückfrage'
						: 'Fehlgeschlagen – mit einer Anweisung fortsetzen'}
				</Label>
				{#if task.status === 'needs-input' && (task.resultSummary || selectedRun?.summary)}
					<div class="rounded-md bg-background p-2">
						<AgentText text={task.resultSummary || selectedRun?.summary || ''} />
					</div>
				{/if}
				<Textarea
					id="task-reply"
					bind:value={reply}
					rows={3}
					maxlength={20000}
					placeholder="Deine Antwort – der Agent setzt seine Sitzung damit fort."
					class="bg-background"
					disabled={busy === 'reply'}
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
							(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
					}}
				/>
				<div class="flex justify-end">
					<Button type="submit" size="sm" disabled={!reply.trim() || busy === 'reply'}>
						{busy === 'reply' ? BUSY_SEND : 'Antwort senden'}
					</Button>
				</div>
			</form>
		{/if}

		<details class="group rounded-lg border bg-card">
			<summary
				class="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm"
			>
				<span class="font-medium">Auftrag</span>
				<span class="truncate text-xs text-muted-foreground group-open:hidden">
					{task.prompt.slice(0, 140)}
				</span>
			</summary>
			<div class="border-t px-3 py-3">
				<AgentText text={task.prompt} />
				{#if detail.dependencies.length}
					<div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
						<span class="text-muted-foreground">Wartet auf:</span>
						{#each detail.dependencies as d (d.id)}
							<a
								href={taskPath(projectId, d.id)}
								class="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 hover:bg-muted"
							>
								{d.title}
								<StatusBadge status={d.status} />
							</a>
						{/each}
					</div>
				{/if}
				{#if task.parentId}
					<p class="mt-2 text-xs">
						<a href={taskPath(projectId, task.parentId)} class="text-link hover:underline"
							>Zum übergeordneten Auftrag</a
						>
					</p>
				{/if}
			</div>
		</details>
	</header>

	<Tabs.Root value={tab} onValueChange={setTab}>
		<Tabs.List variant="line" aria-label="Bereiche des Auftrags">
			<Tabs.Trigger value="log">Verlauf</Tabs.Trigger>
			<Tabs.Trigger value="diff">Diff</Tabs.Trigger>
			<Tabs.Trigger value="commits">
				Commits
				{#if allCommits.length}<span class="text-xs text-muted-foreground tabular-nums"
						>{allCommits.length}</span
					>{/if}
			</Tabs.Trigger>
			{#if detail.children.length || task.role === 'orchestrate'}
				<Tabs.Trigger value="children">
					Teilaufträge
					<span class="text-xs text-muted-foreground tabular-nums"
						>{doneChildren}/{detail.children.length}</span
					>
				</Tabs.Trigger>
			{/if}
			<Tabs.Trigger value="result">Ergebnis</Tabs.Trigger>
		</Tabs.List>

		<div class="pt-4">
			{#if tab === 'log'}
				{#if !runs.length}
					<EmptyState
						title="Noch kein Lauf"
						description={task.status === 'draft'
							? 'Der Auftrag ist ein Entwurf. Starte ihn, damit ein Agent loslegt.'
							: task.status === 'blocked'
								? 'Der Auftrag wartet auf andere Aufträge.'
								: 'Sobald ein Runner und ein Konto frei sind, startet ein Agent.'}
					/>
				{:else}
					<div class="mb-3 flex flex-wrap items-center gap-3">
						{#if runs.length > 1}
							<SelectField
								label="Lauf"
								options={runOptions}
								value={selectedRun?.id ?? null}
								onchange={(v) => {
									if (!v) return;
									selectedRunId = v;
									followLatest = v === runs[0]?.id;
								}}
								size="sm"
								class="w-72"
							/>
						{/if}
						{#if selectedRun}
							<StatusBadge status={selectedRun.status} run />
							<span class="text-xs text-muted-foreground">
								{runMeta(selectedRun)} · {elapsed(
									selectedRun.startedAt,
									selectedRun.finishedAt,
									now
								)}{selectedRun.units ? ` · ${units(selectedRun.units)} Einheiten` : ''}
							</span>
						{/if}
					</div>
					{#if selectedRun?.errorMessage && !running}
						<Alert.Root variant="destructive" class="mb-3">
							<Alert.Title>
								{ERROR_KIND_LABELS[selectedRun.errorKind ?? ''] ?? 'Fehler'}
							</Alert.Title>
							<Alert.Description class="whitespace-pre-wrap"
								>{selectedRun.errorMessage}</Alert.Description
							>
						</Alert.Root>
					{/if}
					<RunLog
						events={selectedEvents}
						loading={!!(selectedRun && eventsLoading[selectedRun.id])}
						{running}
					/>
				{/if}
			{:else if tab === 'diff'}
				{#if diffLoading}
					<LoadingState rows={6} rowClass="h-6 w-full" label="Diff" />
				{:else if diffError}
					{#if diffUnavailable}
						<Alert.Root variant="warning">
							<Alert.Title>Diff gerade nicht verfügbar</Alert.Title>
							<Alert.Description>
								Den Diff berechnet ein Runner. Gerade ist keiner erreichbar – versuch es gleich noch
								einmal.
								<Button variant="link" size="sm" onclick={loadDiff} class="px-0"
									>Erneut versuchen</Button
								>
							</Alert.Description>
						</Alert.Root>
					{:else}
						<ErrorState message={diffError} onretry={loadDiff} />
					{/if}
				{:else if diff}
					<div class="mb-3 flex justify-end">
						<Button variant="ghost" size="sm" onclick={loadDiff}>Aktualisieren</Button>
					</div>
					<DiffView {diff} />
				{:else if !task.branch}
					<EmptyState
						title="Noch kein Branch"
						description="Sobald der Agent Änderungen macht, siehst du hier den Diff."
					/>
				{/if}
			{:else if tab === 'commits'}
				{#if !allCommits.length}
					<EmptyState
						title="Keine Commits"
						description="Commits erscheinen, wenn ein Lauf Änderungen gepusht hat."
					/>
				{:else}
					<ul class="divide-y rounded-lg border bg-card">
						{#each allCommits as c (`${c.run.id}:${c.sha}`)}
							<li class="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
								<code class="shrink-0 font-mono text-xs text-muted-foreground"
									>{shortSha(c.sha)}</code
								>
								<div class="min-w-0 flex-1 basis-60">
									<div class="truncate text-sm font-medium">{firstLine(c.message)}</div>
									{#if c.files.length}
										<details class="text-xs text-muted-foreground">
											<summary class="cursor-pointer">{c.files.length} Dateien</summary>
											<ul class="mt-1 space-y-0.5 font-mono">
												{#each c.files as f (f)}<li class="truncate">{f}</li>{/each}
											</ul>
										</details>
									{/if}
								</div>
								<span class="font-mono text-xs tabular-nums">
									<span class="text-success">+{c.additions}</span>
									<span class="text-destructive">−{c.deletions}</span>
								</span>
								<Badge variant="outline">Versuch {c.run.attempt}</Badge>
							</li>
						{/each}
					</ul>
				{/if}
			{:else if tab === 'children'}
				{#if !detail.children.length}
					<EmptyState
						title="Noch keine Teilaufträge"
						description="Der planende Agent legt sie an, sobald sein Plan steht."
					/>
				{:else}
					<ul class="divide-y rounded-lg border bg-card">
						{#each [...detail.children].sort((a, b) => a.position - b.position) as c (c.id)}
							<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
								<span class="w-6 text-xs text-muted-foreground tabular-nums">{c.position + 1}.</span
								>
								<div class="min-w-0 flex-1 basis-60">
									<a
										href={taskPath(projectId, c.id)}
										class="block truncate text-sm font-medium hover:underline">{taskTitle(c)}</a
									>
									{#if c.dependsOn.length}
										<div class="truncate text-xs text-muted-foreground">
											wartet auf: {c.dependsOn
												.map((d) => childTitles.get(d) ?? 'anderer Auftrag')
												.join(', ')}
										</div>
									{/if}
								</div>
								<span class="text-xs text-muted-foreground">{roleLabel(c.role)}</span>
								{#if c.lastRun}<ProviderBadge provider={c.lastRun.provider} />{/if}
								<StatusBadge status={c.status} />
							</li>
						{/each}
					</ul>
				{/if}
			{:else}
				<div class="space-y-4">
					{#if task.errorMessage}
						<Alert.Root variant="destructive">
							<Alert.Title>Fehlermeldung</Alert.Title>
							<Alert.Description class="whitespace-pre-wrap">{task.errorMessage}</Alert.Description>
						</Alert.Root>
					{:else if lastFailedRun?.errorMessage && task.status === 'failed'}
						<Alert.Root variant="destructive">
							<Alert.Title
								>{ERROR_KIND_LABELS[lastFailedRun.errorKind ?? ''] ?? 'Fehler'}</Alert.Title
							>
							<Alert.Description class="whitespace-pre-wrap"
								>{lastFailedRun.errorMessage}</Alert.Description
							>
						</Alert.Root>
					{/if}
					{#if task.resultSummary}
						<div class="rounded-lg border bg-card p-4">
							<h2 class="mb-2 text-sm font-medium">Zusammenfassung des Agents</h2>
							<AgentText text={task.resultSummary} />
						</div>
					{:else if !task.errorMessage}
						<EmptyState
							title="Noch kein Ergebnis"
							description={isFinal
								? 'Der Agent hat keine Zusammenfassung hinterlassen.'
								: 'Die Zusammenfassung erscheint, wenn der Agent fertig ist.'}
						/>
					{/if}
					{#if detail.pullRequest}
						<div class="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 text-sm">
							<GitPullRequest class="size-4 text-muted-foreground" aria-hidden="true" />
							<span class="font-medium"
								>#{detail.pullRequest.number} {detail.pullRequest.title}</span
							>
							<Badge variant={detail.pullRequest.state === 'merged' ? 'success' : 'info'}>
								{detail.pullRequest.state === 'merged'
									? 'Gemergt'
									: detail.pullRequest.state === 'open'
										? 'Offen'
										: 'Geschlossen'}
							</Badge>
							<a
								href={detail.pullRequest.url}
								target="_blank"
								rel="noopener noreferrer"
								class="ml-auto inline-flex items-center gap-1 text-link hover:underline"
								>Auf GitHub <ExternalLink class="size-3.5" aria-hidden="true" /></a
							>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</Tabs.Root>

	<TaskEditDialog
		bind:open={editOpen}
		{task}
		onsaved={(t) => detail && (detail = { ...detail, task: t })}
	/>
	<ConfirmDialog
		bind:open={cancelOpen}
		title="Auftrag abbrechen?"
		description="Ein laufender Agent wird gestoppt. Bereits gepushte Commits bleiben erhalten."
		confirmLabel="Abbrechen"
		cancelLabel="Weiterlaufen lassen"
		destructive
		onconfirm={() => run('cancel', () => cancelTask(task.id), 'Auftrag abgebrochen')}
	/>
	<ConfirmDialog
		bind:open={deleteOpen}
		title="Auftrag löschen?"
		description="Auftrag, Läufe und Verlauf werden endgültig gelöscht. Branches und Pull Requests auf GitHub bleiben."
		confirmLabel="Löschen"
		destructive
		onconfirm={remove}
	/>
{/if}
