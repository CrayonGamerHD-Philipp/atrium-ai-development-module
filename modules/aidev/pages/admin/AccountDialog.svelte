<script lang="ts">
	// Anbieter-Konto bearbeiten (accountPatch): Label, aktiv, gleichzeitige Läufe, Budgets, Wochenanker, Kontext, Standardmodell;
	// Budgetvorschlag der Limit-Analyse ins Formular übernehmen
	import { toast } from 'svelte-sonner';
	import { BUSY_SAVE, FormField, NumberStepper } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { accountPatch, type AccountDto } from '../../schemas';
	import { updateAccount } from '../api';
	import { errMsg, providerLabel, units } from '../format';
	import { serverErrors, zodErrors, type FieldErrors } from '../components/form-errors';

	let {
		open = $bindable(false),
		account,
		onsaved
	}: { open?: boolean; account: AccountDto; onsaved?: (a: AccountDto) => void } = $props();

	let label = $state('');
	let enabled = $state(true);
	let maxConcurrency = $state(1);
	let budget5h = $state(0);
	let budgetWeek = $state(0);
	let weekAnchor = $state('');
	let contextK = $state(200);
	let defaultModel = $state<string | null>(null);
	let errors = $state<FieldErrors>({});
	let busy = $state(false);

	/** ISO → Wert für `datetime-local` (lokale Zeit) */
	function toLocal(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	$effect(() => {
		if (open) {
			label = account.label;
			enabled = account.enabled;
			maxConcurrency = account.maxConcurrency;
			budget5h = account.budget5hUnits;
			budgetWeek = account.budgetWeekUnits;
			weekAnchor = toLocal(account.weekAnchor);
			contextK = account.contextK;
			defaultModel = account.defaultModel || null;
			errors = {};
		}
	});

	const modelOptions = $derived(
		[...new Set([...account.models, ...(account.defaultModel ? [account.defaultModel] : [])])].map(
			(m) => ({ value: m, label: m })
		)
	);

	// Budgetvorschlag der Limit-Analyse; „übernehmen“ füllt nur das Formular, gespeichert wird mit „Speichern“
	const suggest5h = $derived(account.limits?.suggestedBudget5hUnits ?? null);
	const suggestWeek = $derived(account.limits?.suggestedBudgetWeekUnits ?? null);
	const hasSuggestion = $derived(suggest5h !== null || suggestWeek !== null);
	function applySuggestion() {
		if (suggest5h !== null) budget5h = Math.max(0, Math.round(suggest5h));
		if (suggestWeek !== null) budgetWeek = Math.max(0, Math.round(suggestWeek));
		toast.info('Vorschlag eingetragen – mit „Speichern“ übernehmen');
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		const anchor = weekAnchor ? new Date(weekAnchor) : null;
		const parsed = accountPatch.safeParse({
			label: label.trim(),
			enabled,
			maxConcurrency,
			budget5hUnits: budget5h,
			budgetWeekUnits: budgetWeek,
			weekAnchor: anchor && !Number.isNaN(anchor.getTime()) ? anchor.toISOString() : null,
			contextK,
			defaultModel: defaultModel ?? ''
		});
		if (!parsed.success) {
			errors = zodErrors(parsed.error);
			return;
		}
		busy = true;
		try {
			const a = await updateAccount(account.id, parsed.data);
			toast.success('Konto gespeichert');
			onsaved?.(a);
			open = false;
		} catch (err) {
			errors = serverErrors(err);
			if (!Object.keys(errors).length) toast.error(errMsg(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Konto bearbeiten</Dialog.Title>
			<Dialog.Description>
				{providerLabel(account.provider)} · {account.key} auf {account.runnerName}
			</Dialog.Description>
		</Dialog.Header>
		<form
			id="account-edit"
			class="grid grid-cols-1 gap-4 sm:grid-cols-2"
			onsubmit={save}
			novalidate
		>
			<div class="sm:col-span-2">
				<FormField
					label="Bezeichnung"
					id="acc-label"
					hint="z. B. „Claude Max Philipp“"
					error={errors.label}
				>
					<Input
						id="acc-label"
						bind:value={label}
						maxlength={120}
						disabled={busy}
						placeholder={account.key}
					/>
				</FormField>
			</div>
			<div
				class="flex min-w-0 items-center justify-between gap-3 rounded-lg border p-3 sm:col-span-2"
			>
				<div>
					<label for="acc-enabled" class="text-sm font-medium">Aktiv</label>
					<p class="text-xs text-muted-foreground">
						Deaktivierte Konten bekommen keine neuen Läufe.
					</p>
				</div>
				<Switch id="acc-enabled" bind:checked={enabled} disabled={busy} />
			</div>
			<FormField
				label="Gleichzeitige Läufe"
				id="acc-conc"
				hint="0 = keine Läufe auf diesem Konto"
				error={errors.maxConcurrency}
			>
				<NumberStepper
					id="acc-conc"
					label="Gleichzeitige Läufe"
					bind:value={maxConcurrency}
					min={0}
					max={32}
					disabled={busy}
				/>
			</FormField>
			<FormField label="Kontextfenster" id="acc-ctx" hint="Tausend Tokens" error={errors.contextK}>
				<NumberStepper
					id="acc-ctx"
					label="Kontextfenster"
					bind:value={contextK}
					min={8}
					max={10000}
					step={8}
					unit="k"
					disabled={busy}
				/>
			</FormField>
			<div class="space-y-2 sm:col-span-2">
				<p class="text-xs text-muted-foreground">
					Budgets in Einheiten ≈ Tokens; 0 = unbekannt, wird bei Limits automatisch gelernt. Wirksam
					gerade: 5 h {account.effective5hUnits ? units(account.effective5hUnits) : 'unbekannt'},
					Woche
					{account.effectiveWeekUnits ? units(account.effectiveWeekUnits) : 'unbekannt'}.
				</p>
				{#if hasSuggestion}
					<div class="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5">
						<p class="text-xs tabular-nums">
							<span class="text-muted-foreground">Vorschlag aus der Limit-Analyse:</span>
							{suggest5h === null ? 'unbekannt' : units(suggest5h)} Einheiten / 5 h,
							{suggestWeek === null ? 'unbekannt' : units(suggestWeek)} / Woche
						</p>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onclick={applySuggestion}
							disabled={busy}
						>
							Vorschlag übernehmen
						</Button>
					</div>
				{/if}
			</div>
			<FormField label="Budget 5 Stunden" id="acc-b5" error={errors.budget5hUnits}>
				<Input
					id="acc-b5"
					type="number"
					inputmode="numeric"
					min={0}
					step={1000}
					value={budget5h}
					oninput={(e) =>
						(budget5h = Math.max(
							0,
							Math.floor(Number((e.currentTarget as HTMLInputElement).value) || 0)
						))}
					disabled={busy}
					class="tabular-nums"
				/>
			</FormField>
			<FormField label="Budget Woche" id="acc-bw" error={errors.budgetWeekUnits}>
				<Input
					id="acc-bw"
					type="number"
					inputmode="numeric"
					min={0}
					step={10000}
					value={budgetWeek}
					oninput={(e) =>
						(budgetWeek = Math.max(
							0,
							Math.floor(Number((e.currentTarget as HTMLInputElement).value) || 0)
						))}
					disabled={busy}
					class="tabular-nums"
				/>
			</FormField>
			<FormField
				label="Wochenanker"
				id="acc-anchor"
				hint="Beginn der Abo-Woche (leer = rollierend 7 Tage)"
				error={errors.weekAnchor}
			>
				<Input
					id="acc-anchor"
					type="datetime-local"
					bind:value={weekAnchor}
					disabled={busy}
					class="w-full min-w-0"
				/>
			</FormField>
			<FormField label="Standardmodell" id="acc-model" error={errors.defaultModel}>
				<SelectField
					id="acc-model"
					label="Standardmodell"
					options={modelOptions}
					emptyLabel="Vorgabe des Anbieters"
					value={defaultModel}
					onchange={(v) => (defaultModel = v)}
					disabled={busy || !modelOptions.length}
				/>
			</FormField>
		</form>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={busy}>Abbrechen</Button>
			<Button type="submit" form="account-edit" disabled={busy}
				>{busy ? BUSY_SAVE : 'Speichern'}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
