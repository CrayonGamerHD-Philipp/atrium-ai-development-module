<script lang="ts">
	// Ein Ereignis im Live-Log, gestaltet nach Art (Text, Denken, Tool-Aufruf/-Ergebnis, Status, Fehler, Git, System)
	import Brain from '@lucide/svelte/icons/brain';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import Wrench from '@lucide/svelte/icons/wrench';
	import { cn } from '$lib/utils';
	import type { RunEvent } from '../../protocol';
	import { asText, clock, shorten, toolSummary } from '../format';
	import Markdown from '../components/Markdown.svelte';

	let { event }: { event: RunEvent } = $props();

	const p = $derived(event.payload ?? {});
	const text = $derived(asText(p.text ?? p.message ?? ''));
	const time = $derived(clock(event.ts));
	const MAX_INLINE = 4000;
</script>

{#snippet stamp()}
	<span
		class="w-10 shrink-0 pt-0.5 text-right font-mono text-[11px] text-muted-foreground tabular-nums sm:w-12 sm:text-xs"
		>{time}</span
	>
{/snippet}

{#if event.kind === 'text'}
	<div class="flex gap-2 py-1.5 sm:gap-3">
		{@render stamp()}
		<Markdown {text} class="min-w-0 flex-1 overflow-x-auto" />
	</div>
{:else if event.kind === 'thinking'}
	<details class="group py-1">
		<summary
			class="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground pointer-coarse:min-h-10 sm:gap-3"
		>
			{@render stamp()}
			<span class="inline-flex min-w-0 items-center gap-1.5">
				<ChevronRight class="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
				<Brain class="size-3.5 shrink-0" aria-hidden="true" />
				<span class="truncate italic">Denkt: {shorten(text, 100)}</span>
			</span>
		</summary>
		<div class="mt-1 ml-0 min-w-0 sm:ml-15 text-xs text-muted-foreground italic">
			<p class="break-words whitespace-pre-wrap">{text}</p>
		</div>
	</details>
{:else if event.kind === 'tool'}
	{@const name = asText(p.name) || 'Werkzeug'}
	{@const input = asText(p.input)}
	<details class="group py-1">
		<summary
			class="flex cursor-pointer list-none items-center gap-2 text-xs pointer-coarse:min-h-10 sm:gap-3"
		>
			{@render stamp()}
			<span
				class="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1"
			>
				<ChevronRight
					class="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
				/>
				<Wrench class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span class="shrink-0 font-mono font-medium">{name}</span>
				<span class="truncate font-mono text-muted-foreground">{toolSummary(p.input)}</span>
			</span>
		</summary>
		<pre
			class="mt-1 ml-0 min-w-0 sm:ml-15 max-h-96 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-snug whitespace-pre-wrap">{input.length >
			MAX_INLINE
				? `${input.slice(0, MAX_INLINE)}\n… (${input.length - MAX_INLINE} Zeichen gekürzt)`
				: input}</pre>
	</details>
{:else if event.kind === 'tool-result'}
	{@const output = asText(p.output)}
	{@const isError = p.isError === true}
	<details class="group py-0.5">
		<summary
			class="flex cursor-pointer list-none items-center gap-2 text-xs pointer-coarse:min-h-10 sm:gap-3"
		>
			<span class="w-10 shrink-0 sm:w-12"></span>
			<span
				class={cn(
					'inline-flex min-w-0 flex-1 items-center gap-1.5 pl-2',
					isError ? 'text-destructive' : 'text-muted-foreground'
				)}
			>
				<ChevronRight class="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
				<span class="shrink-0"
					>{isError ? 'Fehler' : 'Ergebnis'}{p.name ? ` · ${asText(p.name)}` : ''}</span
				>
				<span class="truncate font-mono">{shorten(output, 100) || '(leer)'}</span>
			</span>
		</summary>
		<pre
			class={cn(
				'mt-1 ml-0 min-w-0 sm:ml-15 max-h-96 overflow-auto rounded-md border p-2 font-mono text-xs leading-snug whitespace-pre-wrap',
				isError ? 'border-destructive-border bg-destructive-muted text-destructive' : 'bg-muted/40'
			)}>{output.length > MAX_INLINE
				? `${output.slice(0, MAX_INLINE)}\n… (${output.length - MAX_INLINE} Zeichen gekürzt)`
				: output}</pre>
	</details>
{:else if event.kind === 'stderr' || event.kind === 'error'}
	<div class="flex gap-2 py-1 sm:gap-3">
		{@render stamp()}
		<div
			class={cn(
				'flex min-w-0 flex-1 gap-1.5 text-destructive',
				event.kind === 'error' &&
					'rounded-md border border-destructive-border bg-destructive-muted px-2 py-1'
			)}
		>
			{#if event.kind === 'error'}<CircleAlert
					class="mt-0.5 size-3.5 shrink-0"
					aria-hidden="true"
				/>{/if}
			<pre class="min-w-0 flex-1 font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>
		</div>
	</div>
{:else if event.kind === 'git'}
	<div class="flex gap-2 py-1 text-xs sm:gap-3">
		{@render stamp()}
		<span class="inline-flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
			<GitCommitHorizontal class="size-3.5 shrink-0" aria-hidden="true" />
			<span class="font-medium text-foreground">{asText(p.action)}</span>
			<span class="min-w-0 truncate font-mono">{shorten(asText(p.detail), 200)}</span>
		</span>
	</div>
{:else}
	<!-- status / system -->
	<div class="flex gap-2 py-0.5 text-xs text-muted-foreground sm:gap-3">
		{@render stamp()}
		<span class="min-w-0 flex-1 break-words whitespace-pre-wrap">{text || asText(p)}</span>
	</div>
{/if}
