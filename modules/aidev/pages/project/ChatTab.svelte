<script lang="ts">
	// Projekt-Chat: Verlauf (neueste unten, Nachrichten als Markdown), Eingabe (ChatComposer) mit automatischer
	// Erkennung Frage/Auftrag; Agent-Nachrichten verlinken den Auftrag
	import { onMount, tick } from 'svelte';
	import Bot from '@lucide/svelte/icons/bot';
	import ExternalLink from '@lucide/svelte/icons/arrow-up-right';
	import Info from '@lucide/svelte/icons/info';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import type { ChatMessageDto } from '../../schemas';
	import { taskPath } from '../api';
	import { taskTitle } from '../format';
	import { has, PERM } from '../perms';
	import Markdown from '../components/Markdown.svelte';
	import TimeAgo from '../components/TimeAgo.svelte';
	import StatusBadge from '../components/StatusBadge.svelte';
	import ChatComposer from './ChatComposer.svelte';
	import type { ProjectStore } from './store.svelte';

	let { store }: { store: ProjectStore } = $props();

	const canWrite = $derived(has(PERM.taskCreate));

	let scroller = $state<HTMLElement | null>(null);
	let stick = true;

	const tasksById = $derived(new Map(store.tasks.map((t) => [t.id, t])));

	onMount(() => {
		if (!store.chatLoaded) void store.loadChat().then(scrollToEnd);
		else void scrollToEnd();
	});

	// Neue Nachrichten: unten bleiben, wenn man unten war
	$effect(() => {
		void store.chat.length;
		if (stick) void scrollToEnd();
	});

	async function scrollToEnd() {
		await tick();
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	}

	function onscroll() {
		if (!scroller) return;
		stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
	}

	async function loadOlder() {
		if (!scroller) return void store.loadOlderChat();
		const before = scroller.scrollHeight;
		await store.loadOlderChat();
		await tick();
		scroller.scrollTop += scroller.scrollHeight - before;
	}

	function onsent() {
		stick = true;
		void scrollToEnd();
	}

	/** Gleicher Tag wie die vorige Nachricht? (für Tagestrenner) */
	function dayKey(m: ChatMessageDto) {
		return m.createdAt.slice(0, 10);
	}
	function dayLabel(iso: string) {
		return new Date(iso).toLocaleDateString('de-DE', {
			weekday: 'long',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric'
		});
	}
</script>

<div
	class="flex h-[calc(100dvh-14rem)] min-h-[24rem] flex-col overflow-hidden rounded-lg border bg-card lg:h-[calc(100dvh-12rem)] lg:min-h-[36rem]"
>
	<div
		bind:this={scroller}
		{onscroll}
		class="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto p-3 sm:p-4"
		aria-live="polite"
		aria-label="Chatverlauf"
		role="log"
	>
		{#if store.chatLoading && !store.chatLoaded}
			<LoadingState rows={4} rowClass="h-12 w-3/4" label="Chat" />
		{:else if store.chatError && !store.chatLoaded}
			<ErrorState message={store.chatError} onretry={() => store.loadChat()} />
		{:else}
			{#if store.chatHasMore}
				<div class="text-center">
					<Button variant="ghost" size="sm" onclick={loadOlder} disabled={store.chatLoading}>
						Ältere Nachrichten laden
					</Button>
				</div>
			{/if}
			{#if !store.chat.length}
				<div class="flex h-full flex-col items-center justify-center gap-2 py-12 text-center">
					<Bot class="size-8 text-muted-foreground" aria-hidden="true" />
					<p class="font-medium">Noch keine Nachrichten</p>
					<p class="max-w-sm text-sm text-muted-foreground">
						Schreib einfach los – der Chat erkennt automatisch, ob es eine Frage oder ein Auftrag
						ist. Fragen werden lesend beantwortet, Aufträge übernimmt ein Agent; Antworten
						erscheinen hier.
					</p>
				</div>
			{/if}
			{#each store.chat as m, i (m.id)}
				{@const task = m.taskId ? tasksById.get(m.taskId) : undefined}
				{#if i === 0 || dayKey(store.chat[i - 1]!) !== dayKey(m)}
					<div class="flex items-center gap-2 py-1 text-xs text-muted-foreground">
						<span class="h-px flex-1 bg-border"></span>{dayLabel(m.createdAt)}<span
							class="h-px flex-1 bg-border"
						></span>
					</div>
				{/if}
				{#if m.kind === 'system'}
					<div
						class="flex min-w-0 items-start justify-center gap-1.5 text-center text-xs text-muted-foreground"
					>
						<Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						<span class="min-w-0 break-words whitespace-pre-wrap">{m.body}</span>
						<TimeAgo value={m.createdAt} class="shrink-0" />
					</div>
				{:else}
					<article class={cn('flex min-w-0 gap-2', m.kind === 'user' && 'flex-row-reverse')}>
						<div
							class={cn(
								'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium',
								m.kind === 'agent' ? 'bg-info-muted text-info' : 'bg-muted text-muted-foreground'
							)}
							aria-hidden="true"
						>
							{#if m.kind === 'agent'}<Bot class="size-4" />{:else}{(m.author?.name ?? '?')
									.slice(0, 1)
									.toUpperCase()}{/if}
						</div>
						<div
							class={cn(
								'max-w-[90%] min-w-0 rounded-lg px-3 py-2 break-words sm:max-w-[80%] lg:max-w-[min(80%,52rem)]',
								m.kind === 'user' ? 'bg-muted' : 'border bg-background'
							)}
						>
							<div
								class={cn(
									'mb-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground',
									m.kind === 'user' && 'justify-end'
								)}
							>
								<span class="font-medium text-foreground"
									>{m.kind === 'agent' ? 'Agent' : (m.author?.name ?? 'Unbekannt')}</span
								>
								<TimeAgo value={m.createdAt} />
							</div>
							<Markdown text={m.body} />
							{#if m.taskId}
								<a
									href={taskPath(store.id, m.taskId)}
									class="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs hover:bg-muted"
								>
									<ExternalLink class="size-3.5 shrink-0" aria-hidden="true" />
									<span class="truncate">{task ? taskTitle(task) : 'Zum Auftrag'}</span>
									{#if task}<StatusBadge status={task.status} />{/if}
								</a>
							{/if}
						</div>
					</article>
				{/if}
			{/each}
		{/if}
	</div>

	{#if canWrite}
		<ChatComposer {store} {onsent} />
	{:else}
		<p
			class="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground"
		>
			Nur Ansicht – zum Schreiben fehlt dir das Recht, Aufträge zu geben.
		</p>
	{/if}
</div>
