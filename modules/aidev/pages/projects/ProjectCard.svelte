<script lang="ts">
	// Projektkachel der Übersicht: Name, Repo, Zähler, Commit-Richtlinie, letzte Änderung, Favorit
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import { Badge } from '$lib/components/ui/badge';
	import type { ProjectDto } from '../../schemas';
	import { POLICY_LABELS } from '../../schemas';
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
</script>

<div class="relative h-full">
	<a
		href={projectPath(p.id)}
		class="group block h-full rounded-lg border bg-card p-4 transition-colors outline-none hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring"
	>
		<div class="flex min-w-0 items-start gap-3 pr-8">
			<FolderGit2 class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
			<div class="min-w-0 flex-1">
				<div class="truncate font-medium group-hover:underline">
					<Highlight text={p.name} {tokens} />
				</div>
				<div class="truncate font-mono text-xs text-muted-foreground">
					<Highlight text={`${p.repoOwner}/${p.repoName}`} {tokens} /> ·
					<Highlight text={p.defaultBranch} {tokens} />
				</div>
			</div>
			{#if p.counts.needsInput}
				<Badge variant="warning" class="shrink-0"
					>{p.counts.needsInput} Rückfrage{p.counts.needsInput === 1 ? '' : 'n'}</Badge
				>
			{/if}
		</div>
		<dl class="mt-4 grid grid-cols-4 gap-1 text-center sm:gap-2">
			<div>
				<dt class="text-xs text-muted-foreground">Wartet</dt>
				<dd class="text-sm font-semibold tabular-nums">{p.counts.queued}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Läuft</dt>
				<dd class="text-sm font-semibold tabular-nums" class:text-info={p.counts.running > 0}>
					{p.counts.running}
				</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">PR offen</dt>
				<dd class="text-sm font-semibold tabular-nums">{p.counts.review}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Fertig</dt>
				<dd class="text-sm font-semibold tabular-nums">{p.counts.done}</dd>
			</div>
		</dl>
		<div
			class="mt-3 flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground"
		>
			<span class="inline-flex min-w-0 items-center gap-1">
				<GitPullRequest class="size-3.5 shrink-0" aria-hidden="true" />
				<span class="truncate">{POLICY_LABELS[p.commitPolicy]}</span>
			</span>
			<TimeAgo value={p.updatedAt} />
		</div>
	</a>
	<FavoriteButton
		class="absolute top-2.5 right-2.5"
		active={favorite}
		name={p.name}
		ontoggle={ontogglefavorite}
	/>
</div>
