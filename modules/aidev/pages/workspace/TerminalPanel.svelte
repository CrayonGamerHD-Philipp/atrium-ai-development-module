<script lang="ts">
	// Terminals als Reiter (xterm.js): neues Terminal im gewählten Ziel öffnen, schließen, Dunkelmodus folgen
	import { onDestroy, tick } from 'svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import { TermSession } from './terminal.svelte';

	let {
		projectId,
		target,
		dark,
		targetLabel
	}: { projectId: string; target: string; dark: boolean; targetLabel: (t: string) => string } =
		$props();

	let sessions = $state<TermSession[]>([]);
	let active = $state<string | null>(null);
	const containers: Record<string, HTMLElement> = {};
	let opened = 0;

	async function add() {
		const s = new TermSession(projectId, target, ++opened);
		sessions = [...sessions, s];
		active = s.key;
		await tick();
		const el = containers[s.key];
		if (el) void s.start(el, dark);
	}

	function close(key: string) {
		const s = sessions.find((x) => x.key === key);
		s?.dispose();
		sessions = sessions.filter((x) => x.key !== key);
		delete containers[key];
		if (active === key) {
			active = sessions.at(-1)?.key ?? null;
			if (active) select(active);
		}
	}

	function select(key: string) {
		active = key;
		sessions.find((s) => s.key === key)?.refit();
	}

	$effect(() => {
		for (const s of sessions) s.setDark(dark);
	});

	/** Von außen nach Größenänderung des Panels aufrufen */
	export function refit() {
		sessions.find((s) => s.key === active)?.refit();
	}

	onDestroy(() => {
		for (const s of sessions) s.dispose();
	});
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
	<div
		class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-2"
		role="tablist"
		aria-label="Terminals"
	>
		{#each sessions as s (s.key)}
			<div
				class={cn(
					'group inline-flex h-7 shrink-0 items-center gap-1 rounded-md pr-1 pl-2 text-xs',
					active === s.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
				)}
			>
				<button
					type="button"
					role="tab"
					aria-selected={active === s.key}
					class="inline-flex items-center gap-1.5"
					onclick={() => select(s.key)}
				>
					<span
						class={cn(
							'size-1.5 rounded-full',
							s.status === 'live' && 'bg-success',
							s.status === 'opening' && 'animate-pulse bg-muted-foreground',
							s.status === 'exited' && 'bg-muted-foreground/50',
							s.status === 'error' && 'bg-destructive'
						)}
						aria-hidden="true"
					></span>
					{s.label}
					{#if s.target !== 'main'}<span class="text-muted-foreground"
							>· {targetLabel(s.target)}</span
						>{/if}
				</button>
				<button
					type="button"
					class="rounded-sm p-0.5 opacity-60 hover:bg-background hover:opacity-100"
					aria-label={`${s.label} schließen`}
					onclick={() => close(s.key)}><X class="size-3" /></button
				>
			</div>
		{/each}
		<Button variant="ghost" size="xs" onclick={add} class="shrink-0">
			<Plus /> Terminal
		</Button>
	</div>
	<div class="relative min-h-0 flex-1">
		{#if !sessions.length}
			<div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
				<SquareTerminal class="size-6 text-muted-foreground" aria-hidden="true" />
				<p class="text-sm text-muted-foreground">
					Öffne eine Shell auf dem Runner – in der Arbeitskopie „{targetLabel(target)}“.
				</p>
				<Button size="sm" variant="outline" onclick={add}><Plus /> Terminal öffnen</Button>
			</div>
		{/if}
		{#each sessions as s (s.key)}
			<div
				class={cn('absolute inset-0 p-1.5', active === s.key ? 'visible' : 'invisible')}
				role="tabpanel"
				aria-label={s.label}
			>
				<div bind:this={containers[s.key]} class="h-full w-full"></div>
				{#if s.status === 'error' && s.unavailable}
					<div
						class="absolute inset-x-4 bottom-4 rounded-md border border-warning-border bg-warning-muted p-2 text-xs text-warning"
					>
						{s.error} Starte einen Runner (mit PTY-Unterstützung) und öffne das Terminal erneut.
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
