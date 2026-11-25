<script lang="ts">
	// Live-Log eines Laufs: Ereignisse nach Art, Autoscroll mit „Zum Ende“-Knopf, ältere Einträge nachladbar (Fenster)
	import { tick } from 'svelte';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import { LoadingState } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import type { RunEvent } from '../../protocol';
	import EventItem from './EventItem.svelte';

	let {
		events,
		loading = false,
		running = false
	}: { events: RunEvent[]; loading?: boolean; running?: boolean } = $props();

	const WINDOW = 600;
	let limit = $state(WINDOW);
	let scroller = $state<HTMLElement | null>(null);
	let atEnd = $state(true);
	let showSystem = $state(true);

	const filtered = $derived(
		showSystem ? events : events.filter((e) => e.kind !== 'status' && e.kind !== 'system')
	);
	const shown = $derived(filtered.length > limit ? filtered.slice(-limit) : filtered);
	const hidden = $derived(filtered.length - shown.length);

	$effect(() => {
		void shown.length;
		if (atEnd) void toEnd();
	});

	async function toEnd() {
		await tick();
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	}

	function onscroll() {
		if (!scroller) return;
		atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
	}

	async function showOlder() {
		const before = scroller?.scrollHeight ?? 0;
		limit += WINDOW;
		await tick();
		if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
	}
</script>

<div class="relative min-w-0">
	<div class="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
		<span class="tabular-nums">{events.length} Ereignisse</span>
		<Button
			variant="ghost"
			size="xs"
			aria-pressed={!showSystem}
			onclick={() => (showSystem = !showSystem)}
		>
			Statusmeldungen {showSystem ? 'ausblenden' : 'zeigen'}
		</Button>
	</div>
	<div
		bind:this={scroller}
		{onscroll}
		class="h-[calc(100dvh-22rem)] min-h-80 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border bg-card px-2 py-2 sm:px-3"
		role="log"
		aria-label="Verlauf des Laufs"
		aria-busy={loading}
	>
		{#if loading && !events.length}
			<LoadingState rows={6} rowClass="h-5 w-full" label="Verlauf" />
		{:else if !events.length}
			<p class="py-10 text-center text-sm text-muted-foreground">
				{running ? 'Der Agent startet gerade …' : 'Für diesen Lauf gibt es keine Ereignisse.'}
			</p>
		{:else}
			{#if hidden > 0}
				<div class="pb-2 text-center">
					<Button variant="ghost" size="sm" onclick={showOlder}>
						{hidden} ältere Ereignisse zeigen
					</Button>
				</div>
			{/if}
			{#each shown as e (e.seq)}
				<EventItem event={e} />
			{/each}
			{#if running}
				<div
					class="flex items-center gap-2 py-2 pl-12 text-xs text-muted-foreground sm:pl-15"
					aria-hidden="true"
				>
					<span class="size-1.5 animate-pulse rounded-full bg-info"></span>
					<span class="size-1.5 animate-pulse rounded-full bg-info [animation-delay:150ms]"></span>
					<span class="size-1.5 animate-pulse rounded-full bg-info [animation-delay:300ms]"></span>
					arbeitet
				</div>
			{/if}
		{/if}
	</div>
	{#if !atEnd && events.length}
		<Button
			size="sm"
			variant="secondary"
			class="absolute right-4 bottom-4 shadow-md"
			onclick={() => {
				atEnd = true;
				void toEnd();
			}}
		>
			<ArrowDown /> Zum Ende
		</Button>
	{/if}
</div>
