<script lang="ts">
	// Auslastung je Anbieter-Konto: Balken 5 h / Woche, laufende Läufe, Wartezeit (Cooldown) bis Uhrzeit
	import Clock from '@lucide/svelte/icons/clock';
	import type { AccountDto } from '../../schemas';
	import { absolute, clock } from '../format';
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
