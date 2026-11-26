<script lang="ts">
	// Verwaltung: Runner (freigeben, sperren, bearbeiten: Art/Vorrang/Heartbeat-Zeitlimit, entfernen) mit Zustand
	// (aktiv, wird übergeben, Standby/offline, zurück), Version/Update-Hinweis und Übergaben; dazu die Anbieter-Konten
	// (Budgets, Wartezeit aufheben)
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
	import Ban from '@lucide/svelte/icons/ban';
	import Check from '@lucide/svelte/icons/check';
	import Clock from '@lucide/svelte/icons/clock';
	import Laptop from '@lucide/svelte/icons/laptop';
	import Server from '@lucide/svelte/icons/server';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import Pencil from '@lucide/svelte/icons/pencil';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { ConfirmDialog, DataTable, LoadingState, PageHeader } from '$lib/components/layout';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { cn } from '$lib/utils';
	import type { AccountDto, RunnerDto } from '../schemas';
	import { BASE, clearCooldown, deleteRunner, listRunners, updateRunner } from './api';
	import AccountDialog from './admin/AccountDialog.svelte';
	import RunnerDialog from './admin/RunnerDialog.svelte';
	import { RUNNER_RELEASES_URL } from '../runner-release';
	import { HANDOVER_REASON_LABEL, KIND_LABEL, STATE_LABEL } from './runner-state';
	import AccountLimits from './components/AccountLimits.svelte';
	import ProviderBadge from './components/ProviderBadge.svelte';
	import TimeAgo from './components/TimeAgo.svelte';
	import UsageBar from './components/UsageBar.svelte';
	import { absolute, clock, errMsg, units } from './format';
	import { has, PERM } from './perms';

	let runners = $state<RunnerDto[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let busy = $state<string | null>(null);
	let removeTarget = $state<RunnerDto | null>(null);
	let removeOpen = $state(false);
	let editRunner = $state<RunnerDto | null>(null);
	let editRunnerOpen = $state(false);
	let editAccount = $state<AccountDto | null>(null);
	let editOpen = $state(false);
	let guideOpen = $state(false);
	let now = $state(Date.now());

	const canAccounts = $derived(has(PERM.accountManage));

	async function load(quiet = false) {
		if (!quiet) loading = true;
		try {
			runners = await listRunners();
			loadError = '';
			if (!quiet && !runners.length) guideOpen = true;
		} catch (e) {
			if (!quiet) loadError = errMsg(e, 'Runner konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
		const t = setInterval(() => {
			now = Date.now();
			if (document.visibilityState === 'visible') void load(true);
		}, 15_000);
		return () => clearInterval(t);
	});

	async function setStatus(r: RunnerDto, status: 'approved' | 'disabled') {
		busy = r.id;
		try {
			const updated = await updateRunner(r.id, { status });
			runners = runners.map((x) => (x.id === r.id ? updated : x));
			toast.success(status === 'approved' ? `${r.name} freigegeben` : `${r.name} gesperrt`);
		} catch (e) {
			toast.error(errMsg(e, 'Änderung fehlgeschlagen'));
		} finally {
			busy = null;
		}
	}

	async function remove() {
		const r = removeTarget;
		if (!r) return;
		try {
			await deleteRunner(r.id);
			runners = runners.filter((x) => x.id !== r.id);
			toast.success(`${r.name} entfernt`);
		} catch (e) {
			toast.error(errMsg(e, 'Entfernen fehlgeschlagen'));
		}
	}

	async function clear(a: AccountDto) {
		busy = a.id;
		try {
			patchAccount(await clearCooldown(a.id));
			toast.success('Wartezeit aufgehoben');
		} catch (e) {
			toast.error(errMsg(e, 'Wartezeit konnte nicht aufgehoben werden'));
		} finally {
			busy = null;
		}
	}

	function patchAccount(a: AccountDto) {
		runners = runners.map((r) =>
			r.id === a.runnerId ? { ...r, accounts: r.accounts.map((x) => (x.id === a.id ? a : x)) } : r
		);
	}

	function patchRunner(r: RunnerDto) {
		runners = runners.map((x) => (x.id === r.id ? r : x));
	}

	const coolingDown = (a: AccountDto) => !!a.cooldownUntil && Date.parse(a.cooldownUntil) > now;
	const caps = (r: RunnerDto) =>
		[
			r.capabilities.git && 'git',
			r.capabilities.gh && 'gh',
			r.capabilities.pty && 'Terminal',
			r.capabilities.handoff && 'Übergabe',
			r.capabilities.fencing && 'Fencing',
			r.capabilities.os
		]
			.filter(Boolean)
			.join(' · ');
</script>

<a href={BASE} class="mb-3 inline-flex items-center gap-1 text-sm text-link hover:underline">
	<ArrowLeft class="size-4" /> KI-Entwicklung
</a>
<PageHeader
	title="Runner & Konten"
	description="Runner führen die Coding-Agents aus. Jeder Runner meldet seine Anbieter-Konten (Abos) mit."
>
	{#snippet actions()}
		<Button variant="outline" onclick={() => load()} disabled={loading}
			><RefreshCw /> Aktualisieren</Button
		>
	{/snippet}
</PageHeader>

<div class="space-y-6">
	<details bind:open={guideOpen} class="group rounded-lg border bg-card">
		<summary
			class="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-4 py-3"
		>
			<span class="text-sm font-medium">Runner einrichten</span>
			<span class="text-xs text-muted-foreground group-open:hidden">Anleitung zeigen</span>
		</summary>
		<ol class="min-w-0 list-decimal space-y-2 border-t px-4 py-3 pl-8 text-sm break-words">
			<li>
				Lege unter Administration → Benutzer einen <strong>technischen Benutzer</strong> an und gib
				ihm eine Rolle, die <strong>nur</strong> das Recht
				<code class="font-mono text-xs">aidev.runner.connect</code> enthält.
			</li>
			<li>
				Erstelle für diesen Benutzer einen <strong>API-Key</strong> mit genau diesem Scope (<code
					class="font-mono text-xs">aidev.runner.connect</code
				>).
			</li>
			<li>
				Starte den Runner per Docker auf einem Rechner mit den angemeldeten Agent-CLIs (Claude Code,
				Codex, Gemini) und GitHub-Zugang:
				<pre
					class="mt-2 overflow-x-auto rounded-md border bg-muted/60 p-2 font-mono text-xs">docker run -d --name atrium-runner \
  -e ATRIUM_URL=https://dein-atrium.example \
  -e ATRIUM_API_KEY=&lt;API-Key&gt; \
  …   # Details: runner/README.md</pre>
				<span class="text-xs text-muted-foreground">
					Volumes für Anmeldedaten und Arbeitskopien beschreibt <code class="font-mono"
						>runner/README.md</code
					>.
				</span>
			</li>
			<li>
				<strong>Oder auf dem eigenen PC</strong> (Windows, macOS, Linux – ohne Node und ohne
				Docker): Programm aus den
				<a href={RUNNER_RELEASES_URL} class="text-link underline" target="_blank" rel="noreferrer"
					>Runner-Releases</a
				>
				installieren, in der Konfiguration Atrium-Adresse und API-Key eintragen und
				<code class="font-mono text-xs">atrium-runner install</code> ausführen. PC-Runner bekommen Aufträge
				zuerst; vor Standby oder Herunterfahren übergeben sie laufende Aufträge an einen Server-Runner.
			</li>
			<li>
				Der Runner erscheint unten als „Wartet auf Freigabe“ – prüfe Name und Version und gib ihn
				frei.
			</li>
		</ol>
	</details>

	<DataTable
		caption="Runner"
		title="Runner"
		mobile="cards"
		{loading}
		error={loadError}
		onretry={() => load()}
		empty={!runners.length}
		emptyTitle="Noch kein Runner verbunden"
		emptyDescription="Richte einen Runner nach der Anleitung oben ein. Er meldet sich dann hier zur Freigabe."
	>
		{#snippet head()}
			<Table.Row>
				<Table.Head>Name</Table.Head>
				<Table.Head>Art</Table.Head>
				<Table.Head>Status</Table.Head>
				<Table.Head>Letzter Heartbeat</Table.Head>
				<Table.Head class="text-right">Slots</Table.Head>
				<Table.Head>Version</Table.Head>
				<Table.Head class="text-right">Übergaben (7 Tage)</Table.Head>
				<Table.Head>Fähigkeiten</Table.Head>
				<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
			</Table.Row>
		{/snippet}
		{#each runners as r (r.id)}
			<Table.Row>
				<Table.Cell>
					<span class="inline-flex min-w-0 items-center gap-2 font-medium break-all">
						<span
							class={cn(
								'size-2 shrink-0 rounded-full',
								r.online ? 'bg-success' : 'bg-muted-foreground/40'
							)}
							title={r.online ? 'Online' : 'Offline'}
						></span>
						<span class="sr-only">{r.online ? 'Online' : 'Offline'}</span>
						{r.name}
					</span>
				</Table.Cell>
				<Table.Cell>
					<span
						class="inline-flex items-center gap-1.5 text-sm"
						title={r.kindOverride
							? `Festgelegt (meldet sich als ${KIND_LABEL[r.reportedKind]})`
							: ''}
					>
						{#if r.kind === 'desktop'}<Laptop class="size-4" aria-hidden="true" />{:else}<Server
								class="size-4"
								aria-hidden="true"
							/>{/if}
						{KIND_LABEL[r.kind]}
					</span>
					<div class="text-xs text-muted-foreground tabular-nums">
						Vorrang {r.priority}{r.priorityOverride === null ? '' : ' (fest)'} · {r.leaseSec} s
					</div>
				</Table.Cell>
				<Table.Cell>
					<span class="inline-flex flex-wrap gap-1">
						<Badge
							variant={STATE_LABEL[r.state].tone}
							title={STATE_LABEL[r.state].hint +
								(r.handoverReason ? ` (Grund: ${HANDOVER_REASON_LABEL[r.handoverReason]})` : '')}
							>{STATE_LABEL[r.state].label}</Badge
						>
						{#if r.draining && r.online && r.state !== 'handover'}
							<Badge
								variant="warning"
								title="Der Runner wird beendet: laufende Läufe dürfen fertig werden, neue bekommt er nicht"
								>Wird beendet</Badge
							>
						{/if}
					</span>
				</Table.Cell>
				<Table.Cell class="text-xs text-muted-foreground">
					<TimeAgo value={r.lastSeenAt} empty="nie" />
				</Table.Cell>
				<Table.Cell class="text-right tabular-nums">{r.slotsUsed}/{r.maxSlots}</Table.Cell>
				<Table.Cell>
					<span class="font-mono text-xs">{r.version || '–'}</span>
					{#if r.protocolOutdated}
						<Badge
							variant="destructive"
							title="Der Runner spricht ein älteres Protokoll als Atrium – bitte aktualisieren"
							>Protokoll veraltet</Badge
						>
					{:else if r.updateAvailable}
						<a
							href={RUNNER_RELEASES_URL}
							target="_blank"
							rel="noreferrer"
							class="block text-xs text-link hover:underline"
							title={`Version ${r.latestVersion} ist verfügbar`}
							>Update verfügbar ({r.latestVersion})</a
						>
					{/if}
				</Table.Cell>
				<Table.Cell class="text-right text-xs tabular-nums">
					<span
						class="inline-flex items-center gap-1"
						title="übergeben an andere Runner / von anderen Runnern übernommen"
					>
						<ArrowRightLeft class="size-3.5" aria-hidden="true" />
						{r.handedOver} / {r.takenOver}
					</span>
				</Table.Cell>
				<Table.Cell class="text-xs text-muted-foreground">{caps(r) || '–'}</Table.Cell>
				<Table.Cell class="text-right">
					<div class="flex flex-wrap justify-end gap-1">
						{#if r.status !== 'approved'}
							<Button size="sm" onclick={() => setStatus(r, 'approved')} disabled={busy === r.id}>
								<Check /> Freigeben
							</Button>
						{:else}
							<Button
								size="sm"
								variant="outline"
								onclick={() => setStatus(r, 'disabled')}
								disabled={busy === r.id}
							>
								<Ban /> Sperren
							</Button>
						{/if}
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={`${r.name} bearbeiten`}
							title="Bearbeiten (Art, Vorrang, Heartbeat-Zeitlimit)"
							onclick={() => {
								editRunner = r;
								editRunnerOpen = true;
							}}><Settings2 /></Button
						>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={`${r.name} entfernen`}
							title="Entfernen"
							onclick={() => {
								removeTarget = r;
								removeOpen = true;
							}}><Trash2 /></Button
						>
					</div>
				</Table.Cell>
			</Table.Row>
		{/each}
	</DataTable>

	{#if !loading && runners.length}
		<section class="space-y-4" aria-labelledby="accounts-title">
			<div>
				<h2 id="accounts-title" class="text-section">Konten</h2>
				<p class="text-xs text-muted-foreground">
					Budgets in Einheiten ≈ Tokens; 0 = unbekannt, wird bei Limits automatisch gelernt.
				</p>
			</div>
			{#each runners as r (r.id)}
				<Card.Root>
					<Card.Header>
						<Card.Title level={3} class="break-all">{r.name}</Card.Title>
						<Card.Description
							>{r.accounts.length} {r.accounts.length === 1 ? 'Konto' : 'Konten'}</Card.Description
						>
					</Card.Header>
					<Card.Content>
						{#if !r.accounts.length}
							<p class="text-sm text-muted-foreground">Dieser Runner meldet keine Konten.</p>
						{:else}
							<ul class="divide-y">
								{#each r.accounts as a (a.id)}
									<li
										class="grid grid-cols-1 gap-3 py-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-center"
									>
										<div class="min-w-0 space-y-1 sm:col-span-2 lg:col-span-1">
											<div class="flex min-w-0 flex-wrap items-center gap-2">
												<span class="min-w-0 truncate font-medium">{a.label || a.key}</span>
												<ProviderBadge provider={a.provider} model={a.defaultModel} />
												{#if !a.enabled}<Badge variant="outline">Deaktiviert</Badge>{/if}
												{#if !a.loggedIn}<Badge variant="warning">Nicht angemeldet</Badge>{/if}
											</div>
											<div class="text-xs break-words text-muted-foreground">
												<span class="font-mono break-all">{a.key}</span> · {a.usage
													.running}/{a.maxConcurrency} gleichzeitig ·
												{a.contextK}k Kontext · {a.models.length} Modelle
											</div>
											{#if coolingDown(a)}
												<div
													class="inline-flex items-center gap-1 text-xs text-warning"
													title={absolute(a.cooldownUntil)}
												>
													<Clock class="size-3.5" aria-hidden="true" />
													Pause bis {clock(a.cooldownUntil)}{a.cooldownReason
														? ` – ${a.cooldownReason}`
														: ''}
												</div>
											{/if}
										</div>
										<UsageBar
											label={`5 h · Budget ${a.budget5hUnits ? units(a.budget5hUnits) : 'lernend'}`}
											util={a.usage.util5h}
											used={a.usage.used5h}
											budget={a.effective5hUnits}
										/>
										<UsageBar
											label={`Woche · Budget ${a.budgetWeekUnits ? units(a.budgetWeekUnits) : 'lernend'}`}
											util={a.usage.utilWeek}
											used={a.usage.usedWeek}
											budget={a.effectiveWeekUnits}
										/>
										{#if canAccounts}
											<div class="flex flex-wrap gap-1 sm:col-span-2 lg:col-span-1 lg:justify-end">
												{#if coolingDown(a)}
													<Button
														size="sm"
														variant="outline"
														onclick={() => clear(a)}
														disabled={busy === a.id}
													>
														Wartezeit aufheben
													</Button>
												{/if}
												<Button
													size="sm"
													variant="ghost"
													onclick={() => {
														editAccount = a;
														editOpen = true;
													}}><Pencil /> Bearbeiten</Button
												>
											</div>
										{/if}
										<div
											class="min-w-0 rounded-md border bg-muted/30 p-2.5 sm:col-span-2 lg:col-span-4"
										>
											<h4 class="mb-2 text-xs font-medium">Limits laut Anbieter</h4>
											<AccountLimits limits={a.limits} suggestion />
										</div>
									</li>
								{/each}
							</ul>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}
		</section>
	{:else if loading}
		<LoadingState rows={2} rowClass="h-24 w-full" label="Konten" />
	{/if}
</div>

<ConfirmDialog
	bind:open={removeOpen}
	title="Runner entfernen?"
	description={removeTarget
		? `„${removeTarget.name}“ und seine Konten werden entfernt. Meldet sich der Runner erneut, muss er neu freigegeben werden.`
		: ''}
	confirmLabel="Entfernen"
	destructive
	onconfirm={remove}
/>

{#if editRunner}
	<RunnerDialog bind:open={editRunnerOpen} runner={editRunner} onsaved={patchRunner} />
{/if}

{#if editAccount}
	<AccountDialog bind:open={editOpen} account={editAccount} onsaved={patchAccount} />
{/if}
