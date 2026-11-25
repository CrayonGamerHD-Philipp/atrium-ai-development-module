<script lang="ts">
	// Auslastungsbalken (0..1): grau bis 70 %, Warnung bis 100 %, darüber Fehler; ohne Budget gestrichelt „unbekannt“
	import { cn } from '$lib/utils';
	import { percent, units } from '../format';

	let { label, util, used, budget }: { label: string; util: number; used: number; budget: number } =
		$props();

	const pct = $derived(percent(util));
	const known = $derived(budget > 0);
</script>

<div class="min-w-0 space-y-1">
	<div class="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
		<span class="text-muted-foreground">{label}</span>
		<span class="tabular-nums" title={known ? `${units(used)} von ${units(budget)} Einheiten` : ''}>
			{#if known}{pct} %{:else}{units(used)} · Budget unbekannt{/if}
		</span>
	</div>
	<div
		class={cn(
			'h-1.5 w-full overflow-hidden rounded-full bg-muted',
			!known && 'border border-dashed border-border bg-transparent'
		)}
		role="meter"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={known ? Math.min(pct, 100) : 0}
		aria-valuetext={known ? `${pct} %` : 'unbekannt'}
	>
		{#if known}
			<div
				class={cn(
					'h-full rounded-full transition-[width] duration-500',
					pct >= 100 ? 'bg-destructive' : pct >= 70 ? 'bg-warning' : 'bg-foreground/60'
				)}
				style={`width:${Math.min(pct, 100)}%`}
			></div>
		{/if}
	</div>
</div>
