<script lang="ts">
	// Verteilung (Einstellungsseite): je Rolle Anbieter mit Gewicht/Modell/Reihenfolge, Grenzwerte für Läufe
	import { beforeNavigate } from '$app/navigation';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import X from '@lucide/svelte/icons/x';
	import {
		BUSY_SAVE,
		ConfirmDialog,
		ErrorState,
		FormField,
		LoadingState,
		NumberStepper,
		PageHeader
	} from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Slider } from '$lib/components/ui/slider';
	import { PROVIDERS, ROLES, type Provider, type Role } from '../protocol';
	import {
		DEFAULT_LIMITS,
		DEFAULT_ROUTING,
		PROVIDER_LABELS,
		ROLE_LABELS,
		routingPut,
		type Limits,
		type Routing
	} from '../schemas';
	import { BASE, getRouting, putRouting } from './api';
	import ProviderBadge from './components/ProviderBadge.svelte';
	import { errMsg } from './format';
	import { has, PERM } from './perms';

	const canEdit = $derived(has(PERM.settingsManage));

	let routing = $state<Routing | null>(null);
	let limits = $state<Limits | null>(null);
	let baseline = $state('');
	let loading = $state(true);
	let loadError = $state('');
	let busy = $state(false);
	let resetOpen = $state(false);

	function clone<T>(v: T): T {
		return JSON.parse(JSON.stringify(v)) as T;
	}
	const snapshot = () => JSON.stringify({ routing, limits });
	const dirty = $derived(!!routing && JSON.stringify({ routing, limits }) !== baseline);

	const ROLE_HINTS: Record<Role, string> = {
		orchestrate: 'Plant große Aufträge und zerlegt sie in Teilaufträge',
		research: 'Liest Code und Quellen, ändert nichts',
		implement: 'Schreibt Code, committet und öffnet Pull Requests',
		review: 'Prüft Änderungen anderer Agents, ändert nichts',
		fix: 'Behebt Fehler aus Review oder Tests',
		resolve: 'Löst Merge-Konflikte'
	};

	async function load() {
		loading = true;
		loadError = '';
		try {
			const res = await getRouting();
			routing = clone(res.routing);
			limits = clone(res.limits);
			baseline = snapshot();
		} catch (e) {
			loadError = errMsg(e, 'Verteilung konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	onMount(() => void load());

	beforeNavigate((nav) => {
		if (dirty && nav.type !== 'leave' && !confirm('Ungespeicherte Änderungen verwerfen?'))
			nav.cancel();
	});

	function available(role: Role): Provider[] {
		const used = new Set(routing?.[role].map((e) => e.provider));
		return PROVIDERS.filter((p) => !used.has(p) && p !== 'fake');
	}

	function add(role: Role, provider: Provider) {
		if (!routing) return;
		routing[role] = [...routing[role], { provider, weight: 5 }];
	}

	function remove(role: Role, i: number) {
		if (!routing) return;
		routing[role] = routing[role].filter((_, j) => j !== i);
	}

	function move(role: Role, i: number, dir: -1 | 1) {
		if (!routing) return;
		const list = [...routing[role]];
		const j = i + dir;
		if (j < 0 || j >= list.length) return;
		[list[i], list[j]] = [list[j]!, list[i]!];
		routing[role] = list;
	}

	function setModel(role: Role, i: number, model: string) {
		if (!routing) return;
		const entry = routing[role][i];
		if (!entry) return;
		const m = model.trim();
		if (m) entry.model = m;
		else delete entry.model;
	}

	async function save() {
		if (!routing || !limits) return;
		const parsed = routingPut.safeParse({ routing, limits });
		if (!parsed.success) {
			toast.error(parsed.error.issues[0]?.message ?? 'Eingaben prüfen');
			return;
		}
		busy = true;
		try {
			const res = await putRouting(parsed.data.routing, parsed.data.limits);
			routing = clone(res.routing);
			limits = clone(res.limits);
			baseline = snapshot();
			toast.success('Verteilung gespeichert');
		} catch (e) {
			toast.error(errMsg(e, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	function restoreDefaults() {
		routing = clone(DEFAULT_ROUTING);
		limits = clone(DEFAULT_LIMITS);
		toast.info('Standard übernommen – zum Übernehmen speichern');
	}

	const LIMIT_FIELDS: {
		key: keyof Limits;
		label: string;
		hint: string;
		min: number;
		max: number;
		step: number;
		unit?: string;
	}[] = [
		{
			key: 'runTimeoutMin',
			label: 'Höchstlaufzeit je Lauf',
			hint: 'Danach wird der Agent-Prozess beendet',
			min: 5,
			max: 24 * 60,
			step: 5,
			unit: 'min'
		},
		{
			key: 'eventRetentionDays',
			label: 'Aufbewahrung des Verlaufs',
			hint: '0 = unbegrenzt',
			min: 0,
			max: 3650,
			step: 1,
			unit: 'Tage'
		},
		{
			key: 'estimatedUnitsPerRun',
			label: 'Geschätzter Verbrauch je Lauf',
			hint: 'Einheiten ≈ Tokens, bis echte Werte gemessen sind',
			min: 0,
			max: 100_000_000,
			step: 50_000
		},
		{
			key: 'maxEventsPerRun',
			label: 'Max. Ereignisse je Lauf',
			hint: 'Schützt die Datenbank vor endlosen Logs',
			min: 100,
			max: 1_000_000,
			step: 1000
		},
		{
			key: 'coordinationRounds',
			label: 'Master-Agent: Koordinationsrunden',
			hint: '0 = aus: einmal planen, dann ausliefern. Sonst prüft der planende Agent nach jeder Runde die Ergebnisse, vermittelt sie an weitere Agents und legt Folgeaufträge an.',
			min: 0,
			max: 10,
			step: 1
		}
	];
</script>

<a href={BASE} class="mb-3 inline-flex items-center gap-1 text-sm text-link hover:underline">
	<ArrowLeft class="size-4" /> KI-Entwicklung
</a>
<PageHeader
	title="KI-Verteilung"
	description="Welche Anbieter welche Rollen übernehmen. Höheres Gewicht = bevorzugt; der Scheduler berücksichtigt zusätzlich freie Budgets und Wartezeiten."
>
	{#snippet actions()}
		{#if canEdit && routing}
			<Button onclick={save} disabled={busy || !dirty}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			<Button variant="outline" onclick={() => (resetOpen = true)} disabled={busy}>
				<RotateCcw /> Standard wiederherstellen
			</Button>
		{/if}
	{/snippet}
</PageHeader>

{#if loading}
	<LoadingState rows={4} rowClass="h-32 w-full" label="Verteilung" />
{:else if loadError || !routing || !limits}
	<ErrorState message={loadError} onretry={load} />
{:else}
	<div class="space-y-6 pb-20">
		{#if !canEdit}
			<p class="text-sm text-muted-foreground">
				Nur Ansicht – Ändern braucht das Recht „Verteilung einstellen“.
			</p>
		{/if}
		<div class="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
			{#each ROLES as role (role)}
				{@const entries = routing[role]}
				{@const total = entries.reduce((s, e) => s + e.weight, 0)}
				<Card.Root>
					<Card.Header>
						<Card.Title level={3}>{ROLE_LABELS[role]}</Card.Title>
						<Card.Description>{ROLE_HINTS[role]}</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-3">
						{#if !entries.length}
							<p
								class="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground"
							>
								Kein Anbieter – Aufträge dieser Rolle werden nicht verteilt.
							</p>
						{/if}
						<ol class="space-y-2">
							{#each entries as entry, i (entry.provider)}
								<li class="min-w-0 space-y-2 rounded-md border p-2">
									<div class="flex min-w-0 items-center gap-1 sm:gap-2">
										<span class="w-4 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
										<ProviderBadge provider={entry.provider} />
										<span class="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline"
											>{PROVIDER_LABELS[entry.provider]}</span
										>
										<span class="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
											{total ? Math.round((entry.weight / total) * 100) : 0} %
										</span>
										{#if canEdit}
											<Button
												size="icon-xs"
												class="pointer-coarse:size-10"
												variant="ghost"
												onclick={() => move(role, i, -1)}
												disabled={i === 0}
												aria-label={`${PROVIDER_LABELS[entry.provider]} nach oben`}
												><ArrowUp /></Button
											>
											<Button
												size="icon-xs"
												class="pointer-coarse:size-10"
												variant="ghost"
												onclick={() => move(role, i, 1)}
												disabled={i === entries.length - 1}
												aria-label={`${PROVIDER_LABELS[entry.provider]} nach unten`}
												><ArrowDown /></Button
											>
											<Button
												size="icon-xs"
												class="pointer-coarse:size-10"
												variant="ghost"
												onclick={() => remove(role, i)}
												aria-label={`${PROVIDER_LABELS[entry.provider]} entfernen`}><X /></Button
											>
										{/if}
									</div>
									<div
										class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[1fr_auto_minmax(0,10rem)]"
									>
										<Slider
											label={`Gewicht ${PROVIDER_LABELS[entry.provider]} für ${ROLE_LABELS[role]}`}
											min={0}
											max={10}
											step={1}
											bind:value={entry.weight}
											disabled={!canEdit}
										/>
										<span class="w-16 text-xs tabular-nums">
											{entry.weight === 0 ? 'nie' : `Gewicht ${entry.weight}`}
										</span>
										<Input
											value={entry.model ?? ''}
											oninput={(e) =>
												setModel(role, i, (e.currentTarget as HTMLInputElement).value)}
											placeholder="Modell (Standard)"
											aria-label={`Modell für ${PROVIDER_LABELS[entry.provider]}`}
											maxlength={120}
											class="col-span-2 h-9 text-xs sm:col-span-1 sm:h-7"
											disabled={!canEdit}
										/>
									</div>
								</li>
							{/each}
						</ol>
						{#if canEdit && available(role).length && entries.length < 10}
							<SelectField
								label={`Anbieter für ${ROLE_LABELS[role]} hinzufügen`}
								options={available(role).map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
								placeholder="Anbieter hinzufügen …"
								value={null}
								onchange={(v) => v && add(role, v as Provider)}
								size="sm"
								class="w-full sm:w-60"
							/>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}
		</div>

		<Card.Root>
			<Card.Header>
				<Card.Title>Grenzwerte</Card.Title>
				<Card.Description>Gelten für alle Läufe aller Projekte.</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
					{#each LIMIT_FIELDS as f (f.key)}
						<FormField label={f.label} id={`limit-${f.key}`} hint={f.hint}>
							<NumberStepper
								id={`limit-${f.key}`}
								label={f.label}
								bind:value={limits[f.key]}
								min={f.min}
								max={f.max}
								step={f.step}
								unit={f.unit}
								disabled={!canEdit}
							/>
						</FormField>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
	</div>

	{#if canEdit && dirty}
		<div
			class="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 p-3 backdrop-blur sm:hidden"
		>
			<Button class="w-full" onclick={save} disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button
			>
		</div>
	{/if}
{/if}

<ConfirmDialog
	bind:open={resetOpen}
	title="Standard wiederherstellen?"
	description="Verteilung und Grenzwerte werden auf die Vorgaben zurückgesetzt. Übernommen wird erst beim Speichern."
	confirmLabel="Zurücksetzen"
	onconfirm={restoreDefaults}
/>
