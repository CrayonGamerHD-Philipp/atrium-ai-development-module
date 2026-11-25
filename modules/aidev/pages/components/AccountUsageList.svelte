<script lang="ts">
	// Auslastung je Anbieter-Konto: echte Limits des Anbieters (falls gemeldet), sonst geschätzte Balken 5 h / Woche;
	// laufende Läufe, Wartezeit (Cooldown) bis Uhrzeit
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Clock from '@lucide/svelte/icons/clock';
	import type { AccountDto } from '../../schemas';
	import { absolute, clock } from '../format';
	import AccountLimits from './AccountLimits.svelte';
	import ProviderBadge from './ProviderBadge.svelte';
	import UsageBar from './UsageBar.svelte';

	let { accounts, now = Date.now() }: { accounts: AccountDto[]; now?: number } = $props();

	const sorted = $derived(
		[...accounts].sort(
			(a, b) =>
				Number(b.enabled) - Number(a.enabled) ||
				a.provider.localeCompare(b.provider) ||
				(a.label || a.key).localeCompare(b.label || b.key)
		)
	);
	const coolingDown = (a: AccountDto) => !!a.cooldownUntil && Date.parse(a.cooldownUntil) > now;
</script>

<ul class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
	{#each sorted as a (a.id)}
		<li class="space-y-3 rounded-lg border bg-card p-3" class:opacity-60={!a.enabled}>
			<div class="flex items-start justify-between gap-2">
				<div class="min-w-0">
					<div class="truncate text-sm font-medium">{a.label || a.key}</div>
					<div class="truncate text-xs text-muted-foreground">
						{a.runnerName}{a.enabled ? '' : ' · deaktiviert'}{a.loggedIn
							? ''
							: ' · nicht angemeldet'}
					</div>
				</div>
				<ProviderBadge provider={a.provider} />
			</div>
			{#snippet estimate()}
				<div class="grid grid-cols-2 gap-3">
					<UsageBar
						label="5 Stunden"
						util={a.usage.util5h}
						used={a.usage.used5h}
						budget={a.effective5hUnits}
					/>
					<UsageBar
						label="Woche"
						util={a.usage.utilWeek}
						used={a.usage.usedWeek}
						budget={a.effectiveWeekUnits}
					/>
				</div>
			{/snippet}
			{#if a.limits?.windows.length}
				<!-- echte Werte des Anbieters zuerst, eigene Schätzung aufklappbar -->
				<AccountLimits limits={a.limits} />
				<details class="group">
					<summary
						class="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground pointer-coarse:min-h-10"
					>
						<ChevronRight
							class="size-3.5 shrink-0 transition-transform group-open:rotate-90"
							aria-hidden="true"
						/>
						Eigene Schätzung nach Budget
					</summary>
					<div class="mt-2">{@render estimate()}</div>
				</details>
			{:else}
				{@render estimate()}
				<AccountLimits limits={a.limits} />
			{/if}
			<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span class="tabular-nums">
					{a.usage.running} von {a.maxConcurrency} gleichzeitig
				</span>
				{#if coolingDown(a)}
					<span
						class="inline-flex items-center gap-1 text-warning"
						title={`${a.cooldownReason ?? 'Limit erreicht'} – bis ${absolute(a.cooldownUntil)}`}
					>
						<Clock class="size-3.5" aria-hidden="true" />
						Pause bis {clock(a.cooldownUntil)}
					</span>
				{/if}
			</div>
		</li>
	{/each}
</ul>
