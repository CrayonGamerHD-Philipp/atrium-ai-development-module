<script lang="ts">
	// Limit-Analyse je Konto: echte Auslastung der Anbieter-Fenster (5 h, Woche …) mit eigener Schätzung als Marker,
	// Reset-/Erschöpfungszeit, Status (Text + Farbe), Stand/Quelle und optional der Budgetvorschlag
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { cn } from '$lib/utils';
	import type { AccountLimitsDto, AccountLimitWindowDto } from '../../schemas';
	import { absolute, clock, units } from '../format';
	import TimeAgo from './TimeAgo.svelte';

	let {
		limits,
		suggestion = false,
		class: className
	}: {
		limits: AccountLimitsDto | null;
		/** Budgetvorschlag („Vorschlag: X Einheiten / 5 h, Y / Woche“) anzeigen */
		suggestion?: boolean;
		class?: string;
	} = $props();

	const WINDOW_LABELS: Record<AccountLimitWindowDto['window'], string> = {
		'5h': '5 Stunden',
		week: 'Woche',
		'week-opus': 'Woche (Opus)',
		'week-sonnet': 'Woche (Sonnet)',
		daily: 'Täglich',
		other: ''
	};
	const SOURCE_LABELS: Record<AccountLimitsDto['source'], string> = {
		stream: 'aus Lauf',
		probe: 'Abfrage',
		error: 'Fehler'
	};
	const STATUS_LABELS: Partial<Record<AccountLimitWindowDto['status'], string>> = {
		warning: 'Warnung',
		rejected: 'Limit erreicht'
	};
	/** Ab dieser Abweichung (Prozentpunkte) zwischen Anbieter und Schätzung gibt es einen Hinweis */
	const DRIFT_POINTS = 15;

	const windowLabel = (w: AccountLimitWindowDto) =>
		WINDOW_LABELS[w.window] || w.label || 'Sonstiges Limit';
	const clamp = (x: number) => Math.min(Math.max(x, 0), 100);
	const round = (x: number) => Math.round(x);

	function view(w: AccountLimitWindowDto) {
		const real = w.usedPercent;
		const est = w.estimatedUtil === null ? null : w.estimatedUtil * 100;
		const drift = real !== null && est !== null ? round(Math.abs(real - est)) : 0;
		const tone =
			w.status === 'rejected' || (real !== null && real >= 100)
				? 'destructive'
				: w.status === 'warning' || (real !== null && real >= 80)
					? 'warning'
					: 'normal';
		return { label: windowLabel(w), real, est, drift: drift > DRIFT_POINTS ? drift : 0, tone };
	}

	const windows = $derived((limits?.windows ?? []).map((w) => ({ w, ...view(w) })));
	const hasSuggestion = $derived(
		!!limits && (limits.suggestedBudget5hUnits !== null || limits.suggestedBudgetWeekUnits !== null)
	);
	const fmtSuggestion = (n: number | null) => (n === null ? 'unbekannt' : units(n));
</script>

{#if !limits}
	<p class={cn('text-xs text-muted-foreground', className)}>
		Keine Limit-Daten vom Runner (Runner aktualisieren bzw. Konto noch nicht genutzt)
	</p>
{:else}
	<div class={cn('min-w-0 space-y-2', className)}>
		{#if windows.length}
			<ul class="space-y-2.5" aria-label="Limits des Anbieters">
				{#each windows as v, i (`${v.w.window}-${i}`)}
					{@const statusText = STATUS_LABELS[v.w.status]}
					<li class="min-w-0 space-y-1">
						<div class="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
							<span class="min-w-0 truncate text-muted-foreground">
								{v.label}{#if statusText}
									<span
										class={cn(
											'ml-1 font-medium',
											v.tone === 'destructive' ? 'text-destructive' : 'text-warning'
										)}>· {statusText}</span
									>{/if}{#if v.w.stale && !limits.stale}
									<span class="ml-1 font-medium text-warning">· veraltet</span>{/if}
							</span>
							<span
								class={cn(
									'tabular-nums',
									v.tone === 'destructive' && 'text-destructive',
									v.tone === 'warning' && 'text-warning'
								)}
							>
								{v.real === null ? 'unbekannt' : `${round(v.real)} %`}
							</span>
						</div>
						<div
							class={cn(
								'relative h-1.5 w-full rounded-full bg-muted',
								v.real === null && 'border border-dashed border-border bg-transparent'
							)}
							role="meter"
							aria-label={`${v.label}${statusText ? ` – ${statusText}` : ''}`}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={v.real === null ? 0 : clamp(v.real)}
							aria-valuetext={`${v.real === null ? 'unbekannt' : `${round(v.real)} %`}${
								v.est !== null ? `, Schätzung ${round(v.est)} %` : ''
							}`}
						>
							{#if v.real !== null}
								<div
									class={cn(
										'h-full rounded-full transition-[width] duration-500',
										v.tone === 'destructive'
											? 'bg-destructive'
											: v.tone === 'warning'
												? 'bg-warning'
												: 'bg-foreground/60'
									)}
									style={`width:${clamp(v.real)}%`}
								></div>
							{/if}
							{#if v.est !== null}
								<!-- Marker der eigenen Schätzung -->
								<div
									class="absolute -top-0.5 -bottom-0.5 w-0.5 -translate-x-1/2 rounded-full bg-link"
									style={`left:${clamp(v.est)}%`}
									aria-hidden="true"
								></div>
							{/if}
						</div>
						<div
							class="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums"
						>
							{#if v.est !== null}
								<span class="inline-flex items-center gap-1">
									<span class="inline-block h-2.5 w-0.5 rounded-full bg-link" aria-hidden="true"
									></span>
									Schätzung {round(v.est)} %
								</span>
							{/if}
							{#if v.w.resetsAt}
								<span title={absolute(v.w.resetsAt)}>zurückgesetzt um {clock(v.w.resetsAt)}</span>
							{/if}
							{#if v.w.exhaustsAt}
								<span class="text-warning" title={absolute(v.w.exhaustsAt)}>
									voraussichtlich erschöpft um {clock(v.w.exhaustsAt)}
								</span>
							{/if}
						</div>
						{#if v.drift}
							<p class="inline-flex items-start gap-1 text-[11px] text-warning">
								<TriangleAlert class="mt-px size-3 shrink-0" aria-hidden="true" />
								Schätzung weicht um {v.drift} Prozentpunkte vom Anbieterwert ab
							</p>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-xs text-muted-foreground">Der Runner meldet keine Limit-Fenster.</p>
		{/if}
		{#if suggestion && hasSuggestion}
			<p class="text-xs tabular-nums">
				<span class="text-muted-foreground">Vorschlag:</span>
				{fmtSuggestion(limits.suggestedBudget5hUnits)} Einheiten / 5 h, {fmtSuggestion(
					limits.suggestedBudgetWeekUnits
				)} / Woche
			</p>
		{/if}
		<p class="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
			<span>Stand: <TimeAgo value={limits.observedAt} /></span>
			{#if limits.stale}
				<span class="font-medium text-warning">· veraltet</span>
			{/if}
			<span class={cn(limits.source === 'error' && 'text-destructive')}>
				· Quelle: {SOURCE_LABELS[limits.source] ?? limits.source}
			</span>
		</p>
	</div>
{/if}
