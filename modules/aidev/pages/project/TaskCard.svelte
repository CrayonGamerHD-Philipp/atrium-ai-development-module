<script lang="ts">
	// Karte auf dem Auftragsboard: Titel, Rolle, Anbieter, Versuch, Fortschritt der Teilaufträge
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import Lock from '@lucide/svelte/icons/lock';
	import MessageCircleQuestion from '@lucide/svelte/icons/message-circle-question';
	import Network from '@lucide/svelte/icons/network';
	import { cn } from '$lib/utils';
	import type { TaskDto } from '../../schemas';
	import { taskPath } from '../api';
	import { roleLabel, taskTitle } from '../format';
	import ProviderBadge from '../components/ProviderBadge.svelte';
	import StatusBadge from '../components/StatusBadge.svelte';
	import TimeAgo from '../components/TimeAgo.svelte';

	let {
		task,
		children = [],
		parentTitle = ''
	}: { task: TaskDto; children?: TaskDto[]; parentTitle?: string } = $props();

	const doneChildren = $derived(children.filter((c) => c.status === 'done').length);
	const provider = $derived(task.lastRun?.provider ?? task.providerHint);
	const showStatus = $derived(['draft', 'blocked', 'cancelled'].includes(task.status));
</script>

<a
	href={taskPath(task.projectId, task.id)}
	class={cn(
		'block min-w-0 space-y-2 rounded-md border bg-card p-3 text-left shadow-xs transition-colors outline-none hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring',
		task.status === 'needs-input' && 'border-warning-border',
		task.status === 'draft' && 'border-dashed'
	)}
>
	{#if parentTitle}
		<div class="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
			<Network class="size-3 shrink-0" aria-hidden="true" />
			<span class="min-w-0 truncate">{parentTitle}</span>
		</div>
	{/if}
	<div class="line-clamp-3 text-sm leading-snug font-medium wrap-break-word">{taskTitle(task)}</div>
	<div class="flex flex-wrap items-center gap-1.5">
		<span class="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
			{roleLabel(task.role)}
		</span>
		{#if provider}
			<ProviderBadge {provider} />
		{/if}
		{#if showStatus}<StatusBadge status={task.status} />{/if}
		{#if task.priority > 0}
			<span class="text-xs font-medium text-warning" title="Priorität">↑{task.priority}</span>
		{:else if task.priority < 0}
			<span class="text-xs text-muted-foreground" title="Priorität">↓{-task.priority}</span>
		{/if}
	</div>
	{#if children.length}
		<div class="space-y-1">
			<div class="flex justify-between text-xs text-muted-foreground">
				<span>Teilaufträge</span>
				<span class="tabular-nums">{doneChildren}/{children.length}</span>
			</div>
			<div class="h-1 overflow-hidden rounded-full bg-muted">
				<div
					class="h-full rounded-full bg-success"
					style={`width:${Math.round((doneChildren / children.length) * 100)}%`}
				></div>
			</div>
		</div>
	{/if}
	<div class="flex items-end justify-between gap-2 text-xs text-muted-foreground">
		<span class="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
			{#if task.attempts > 0}
				<span class="tabular-nums" title="Versuche">Versuch {task.attempts}/{task.maxAttempts}</span
				>
			{/if}
			{#if task.targetPr}
				<!-- Karte ist selbst ein Link – daher hier kein Link zur PR-URL -->
				<span
					class="inline-flex items-center gap-0.5 text-info"
					title="Bearbeitet einen bestehenden PR"
					><GitPullRequest class="size-3" aria-hidden="true" />PR #{task.targetPr} bearbeiten</span
				>
			{:else if task.prNumber}
				<span class="inline-flex items-center gap-0.5"
					><GitPullRequest class="size-3" aria-hidden="true" />#{task.prNumber}</span
				>
			{/if}
			{#if task.status === 'needs-input'}
				<span class="inline-flex items-center gap-0.5 text-warning"
					><MessageCircleQuestion class="size-3" aria-hidden="true" />Antwort nötig</span
				>
			{/if}
			{#if task.dependsOn.length && task.status === 'blocked'}
				<span class="inline-flex items-center gap-0.5"
					><Lock class="size-3" aria-hidden="true" />wartet</span
				>
			{/if}
		</span>
		<span class="shrink-0"><TimeAgo value={task.updatedAt} /></span>
	</div>
</a>
