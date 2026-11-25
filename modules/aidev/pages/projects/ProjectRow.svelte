<script lang="ts">
	// Kompakte, einzeilige Listenzeile eines Projekts (Listenansicht bei vielen Projekten)
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import { Badge } from '$lib/components/ui/badge';
	import type { ProjectDto } from '../../schemas';
	import { projectPath } from '../api';
	import TimeAgo from '../components/TimeAgo.svelte';
	import FavoriteButton from './FavoriteButton.svelte';
	import Highlight from './Highlight.svelte';

	let {
		project: p,
		tokens,
		favorite,
		ontogglefavorite
	}: {
		project: ProjectDto;
		tokens: string[];
		favorite: boolean;
		ontogglefavorite: () => void;
	} = $props();

	const counters = $derived([
		{ label: 'Wartet', value: p.counts.queued, tone: '' },
		{ label: 'Läuft', value: p.counts.running, tone: p.counts.running ? 'text-info' : '' },
		{ label: 'PR offen', value: p.counts.review, tone: '' },
		{ label: 'Fertig', value: p.counts.done, tone: '' }
	]);
</script>

<div class="flex items-center gap-1 pr-2 transition-colors hover:bg-accent/50">
	<a
		href={projectPath(p.id)}
		class="group flex min-w-0 flex-1 items-center gap-3 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
	>
		<FolderGit2 class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<div class="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3">
			<div class="truncate text-sm font-medium group-hover:underline sm:max-w-[40%] sm:shrink-0">
				<Highlight text={p.name} {tokens} />
			</div>
			<div class="truncate font-mono text-xs text-muted-foreground">
				<Highlight text={`${p.repoOwner}/${p.repoName}`} {tokens} /> ·
				<Highlight text={p.defaultBranch} {tokens} />
			</div>
		</div>
		{#if p.counts.needsInput}
			<Badge variant="warning" class="shrink-0"
				>{p.counts.needsInput}<span class="hidden sm:inline"
					>&nbsp;Rückfrage{p.counts.needsInput === 1 ? '' : 'n'}</span
				><span class="sr-only sm:hidden">&nbsp;Rückfragen</span></Badge
			>
		{/if}
		<dl class="hidden shrink-0 items-center gap-3 text-xs md:flex">
			{#each counters as c (c.label)}
				<div class="flex items-baseline gap-1" title={c.label}>
					<dt class="text-muted-foreground">{c.label}</dt>
					<dd class={`font-semibold tabular-nums ${c.tone}`}>{c.value}</dd>
				</div>
			{/each}
		</dl>
		<TimeAgo
			value={p.updatedAt}
			class="hidden w-24 shrink-0 text-right text-xs text-muted-foreground sm:block"
		/>
	</a>
	<FavoriteButton active={favorite} name={p.name} ontoggle={ontogglefavorite} />
</div>
