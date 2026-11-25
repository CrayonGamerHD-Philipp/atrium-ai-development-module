<script lang="ts">
	// Steuerleiste der Projektübersicht: Suche, Statusfilter, Sortierung, Ansicht Kacheln/Liste
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import List from '@lucide/svelte/icons/list';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { cn } from '$lib/utils';
	import {
		isProjectSort,
		SORT_OPTIONS,
		STATUS_FILTERS,
		type ProjectSort,
		type ProjectStatusFilter,
		type ProjectView
	} from './filter';

	let {
		query = $bindable(''),
		input = $bindable(null),
		status,
		sort,
		view,
		counts,
		onstatus,
		onsort,
		onview,
		onquerykeydown
	}: {
		query?: string;
		input?: HTMLInputElement | null;
		status: ProjectStatusFilter;
		sort: ProjectSort;
		view: ProjectView;
		counts: Record<ProjectStatusFilter, number>;
		onstatus: (s: ProjectStatusFilter) => void;
		onsort: (s: ProjectSort) => void;
		onview: (v: ProjectView) => void;
		onquerykeydown?: (e: KeyboardEvent) => void;
	} = $props();

	// „Favoriten“ nur, wenn es welche gibt (oder der Filter gerade aktiv ist)
	const filters = $derived(
		STATUS_FILTERS.filter(
			(f) => f.value !== 'favorites' || counts.favorites > 0 || status === 'favorites'
		)
	);

	const VIEWS: { value: ProjectView; label: string; icon: typeof List }[] = [
		{ value: 'grid', label: 'Kacheln', icon: LayoutGrid },
		{ value: 'list', label: 'Liste', icon: List }
	];

	function clear() {
		query = '';
		input?.focus();
	}
</script>

<div class="space-y-2">
	<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
		<div class="relative min-w-0 flex-1">
			<Search
				class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<Input
				bind:ref={input}
				bind:value={query}
				type="search"
				aria-label="Projekte suchen"
				aria-keyshortcuts="/"
				placeholder="Projekte suchen – Name, Repo oder Branch …"
				autocomplete="off"
				spellcheck={false}
				class="pr-10 pl-8 [&::-webkit-search-cancel-button]:appearance-none"
				onkeydown={onquerykeydown}
			/>
			{#if query}
				<button
					type="button"
					class="absolute top-1/2 right-1 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					aria-label="Suche leeren"
					onclick={clear}
				>
					<X class="size-4" aria-hidden="true" />
				</button>
			{:else}
				<kbd
					class="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground sm:inline"
					aria-hidden="true">/</kbd
				>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<SelectField
				label="Sortierung"
				options={SORT_OPTIONS.map((o) => ({ value: o.value, label: `Sortieren: ${o.label}` }))}
				value={sort}
				onchange={(v) => isProjectSort(v) && onsort(v)}
				class="min-w-0 flex-1 sm:w-52 sm:flex-none"
			/>
			<div class="flex shrink-0 rounded-md border p-0.5" role="group" aria-label="Ansicht">
				{#each VIEWS as v (v.value)}
					<button
						type="button"
						class={cn(
							'inline-flex size-8 items-center justify-center rounded-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
							view === v.value && 'bg-accent text-foreground'
						)}
						aria-label={v.label}
						title={v.label}
						aria-pressed={view === v.value}
						onclick={() => onview(v.value)}
					>
						<v.icon class="size-4" aria-hidden="true" />
					</button>
				{/each}
			</div>
		</div>
	</div>
	<div
		class="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]"
		role="group"
		aria-label="Nach Status filtern"
	>
		{#each filters as f (f.value)}
			<button
				type="button"
				class={cn(
					'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm whitespace-nowrap transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
					status === f.value &&
						'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
				)}
				aria-pressed={status === f.value}
				onclick={() => onstatus(f.value)}
			>
				{f.label}
				<span
					class={cn(
						'text-xs tabular-nums',
						status === f.value ? 'text-primary-foreground/80' : 'text-muted-foreground'
					)}>{counts[f.value]}</span
				>
			</button>
		{/each}
	</div>
</div>
