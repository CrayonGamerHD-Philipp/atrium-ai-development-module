<script lang="ts">
	// Laufende Agent-Läufe aller Projekte: Projekt, Auftrag, Anbieter, Konto, Runner, Laufzeit (tickt jede Sekunde)
	import { onMount } from 'svelte';
	import type { OverviewDto } from '../../schemas';
	import { projectPath, taskPath } from '../api';
	import { elapsed } from '../format';
	import ProviderBadge from './ProviderBadge.svelte';
	import StatusBadge from './StatusBadge.svelte';

	let { runs, compact = false }: { runs: OverviewDto['activeRuns']; compact?: boolean } = $props();

	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});
</script>

<ul class="divide-y">
	{#each runs as r (r.id)}
		<li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
			<div class="min-w-0 flex-1 basis-56">
				<a
					href={taskPath(r.projectId, r.taskId)}
					class="block truncate text-sm font-medium hover:underline">{r.taskTitle || 'Auftrag'}</a
				>
				<div class="truncate text-xs text-muted-foreground">
					<a href={projectPath(r.projectId)} class="hover:underline">{r.projectName}</a>
					{#if !compact}
						· {r.accountLabel || 'Konto'} · {r.runnerName || 'Runner'}
					{/if}
					· Versuch {r.attempt}
				</div>
			</div>
			<ProviderBadge provider={r.provider} model={compact ? '' : r.model} />
			{#if r.status !== 'running'}<StatusBadge status={r.status} run />{/if}
			<span class="w-20 text-right text-xs text-muted-foreground tabular-nums">
				{elapsed(r.startedAt, r.finishedAt, now)}
			</span>
		</li>
	{/each}
</ul>
