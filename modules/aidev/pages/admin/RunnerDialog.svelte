<script lang="ts">
	// Runner bearbeiten (runnerPatch): Name, Slots, Art (PC/Server), Vorrang und Heartbeat-Zeitlimit.
	// Leere Felder bzw. „Automatisch“ setzen die Vorgabe der Verwaltung zurück (null).
	import { toast } from 'svelte-sonner';
	import { BUSY_SAVE, FormField, NumberStepper } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { runnerPatch, type RunnerDto } from '../../schemas';
	import { updateRunner } from '../api';
	import { errMsg } from '../format';
	import { serverErrors, zodErrors, type FieldErrors } from '../components/form-errors';
	import { KIND_LABEL } from '../runner-state';

	let {
		open = $bindable(false),
		runner,
		onsaved
	}: { open?: boolean; runner: RunnerDto; onsaved?: (r: RunnerDto) => void } = $props();

	let name = $state('');
	let maxSlots = $state(0);
	let kind = $state<string | null>(null);
	let priority = $state<number | null>(null);
	let leaseSec = $state<number | null>(null);
	let errors = $state<FieldErrors>({});
	let busy = $state(false);

	$effect(() => {
		if (open) {
			name = runner.name;
			maxSlots = runner.maxSlots;
			kind = runner.kindOverride;
			priority = runner.priorityOverride;
			leaseSec = runner.leaseSecOverride;
			errors = {};
		}
	});

	const kindOptions = [
		{ value: 'desktop', label: KIND_LABEL.desktop },
		{ value: 'server', label: KIND_LABEL.server }
	];
	const effectiveKind = $derived((kind ?? runner.reportedKind) as 'server' | 'desktop');
	const autoPriority = $derived(effectiveKind === 'desktop' ? 10 : 0);
	const autoLease = $derived(effectiveKind === 'desktop' ? 60 : 90);

	/** Leeres bzw. ungültiges Zahlenfeld → `null` (= automatisch) */
	const optInt = (v: number | null | undefined) =>
		v === null || v === undefined || Number.isNaN(v) ? null : v;

	async function save(e: SubmitEvent) {
		e.preventDefault();
		const parsed = runnerPatch.safeParse({
			name: name.trim(),
			maxSlots,
			kind: kind === 'desktop' || kind === 'server' ? kind : null,
			priority: optInt(priority),
			leaseSec: optInt(leaseSec)
		});
		if (!parsed.success) {
			errors = zodErrors(parsed.error);
			return;
		}
		busy = true;
		try {
			const r = await updateRunner(runner.id, parsed.data);
			toast.success('Runner gespeichert');
			onsaved?.(r);
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
			<Dialog.Title>Runner bearbeiten</Dialog.Title>
			<Dialog.Description>
				{runner.name} · meldet sich als {KIND_LABEL[runner.reportedKind]}
			</Dialog.Description>
		</Dialog.Header>
		<form id="runner-edit" class="grid grid-cols-1 gap-4 sm:grid-cols-2" onsubmit={save} novalidate>
			<div class="sm:col-span-2">
				<FormField label="Name" id="rn-name" error={errors.name}>
					<Input id="rn-name" bind:value={name} maxlength={80} disabled={busy} />
				</FormField>
			</div>
			<FormField
				label="Art"
				id="rn-kind"
				hint="PC-Runner bekommen Aufträge zuerst und übergeben sie vor Standby an Server-Runner"
				error={errors.kind}
			>
				<SelectField
					id="rn-kind"
					label="Art"
					options={kindOptions}
					emptyLabel={`Wie gemeldet (${KIND_LABEL[runner.reportedKind]})`}
					value={kind}
					onchange={(v) => (kind = v)}
					disabled={busy}
				/>
			</FormField>
			<FormField
				label="Gleichzeitige Läufe"
				id="rn-slots"
				hint="Ändert der Runner seinen Wert, gilt wieder der gemeldete"
				error={errors.maxSlots}
			>
				<NumberStepper
					id="rn-slots"
					label="Gleichzeitige Läufe"
					bind:value={maxSlots}
					min={0}
					max={64}
					disabled={busy}
				/>
			</FormField>
			<FormField
				label="Vorrang"
				id="rn-prio"
				hint={`Höher = zuerst; leer = automatisch (${autoPriority})`}
				error={errors.priority}
			>
				<Input
					id="rn-prio"
					type="number"
					inputmode="numeric"
					min={-100}
					max={100}
					step={1}
					bind:value={priority}
					placeholder={`automatisch (${autoPriority})`}
					disabled={busy}
					class="tabular-nums"
				/>
			</FormField>
			<FormField
				label="Heartbeat-Zeitlimit"
				id="rn-lease"
				hint={`Sekunden ohne Lebenszeichen, bis ein anderer Runner übernimmt (30–900); leer = ${autoLease} s`}
				error={errors.leaseSec}
			>
				<Input
					id="rn-lease"
					type="number"
					inputmode="numeric"
					min={30}
					max={900}
					step={5}
					bind:value={leaseSec}
					placeholder={`Standard (${autoLease} s)`}
					disabled={busy}
					class="tabular-nums"
				/>
			</FormField>
		</form>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={busy}>Abbrechen</Button>
			<Button type="submit" form="runner-edit" disabled={busy}
				>{busy ? BUSY_SAVE : 'Speichern'}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
