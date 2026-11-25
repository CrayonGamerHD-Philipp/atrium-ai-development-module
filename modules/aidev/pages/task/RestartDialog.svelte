<script lang="ts">
	// Bestätigung für „Neu starten“: Versuche werden zurückgesetzt; bei Orchestrierungen optional auch erledigte
	// Teilaufträge neu starten
	import {
		AlertDialog,
		AlertDialogAction,
		AlertDialogCancel,
		AlertDialogContent,
		AlertDialogDescription,
		AlertDialogFooter,
		AlertDialogHeader,
		AlertDialogTitle
	} from '$lib/components/ui/alert-dialog';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import type { RetryTaskOptions } from '../api';

	let {
		open = $bindable(false),
		status,
		orchestrated = false,
		onconfirm
	}: {
		open?: boolean;
		/** Status des Auftrags, für den passenden Hinweis */
		status: string;
		/** Orchestrierung mit Teilaufträgen → Option für erledigte Teilaufträge anzeigen */
		orchestrated?: boolean;
		onconfirm: (subtasks: NonNullable<RetryTaskOptions['subtasks']>) => void | Promise<void>;
	} = $props();

	let includeDone = $state(false);

	// Beim Öffnen immer mit der vorsichtigen Variante beginnen
	$effect(() => {
		if (open) includeDone = false;
	});

	const onBranch = $derived(status === 'done' || status === 'review');

	async function confirm() {
		const subtasks = includeDone ? 'all' : 'failed';
		open = false;
		await onconfirm(subtasks);
	}
</script>

<AlertDialog bind:open>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Auftrag neu starten?</AlertDialogTitle>
			<AlertDialogDescription>
				Der Auftrag wird mit zurückgesetzten Versuchen neu eingeplant.
				{#if onBranch}
					Der Agent arbeitet erneut auf dem bestehenden Branch.
				{/if}
			</AlertDialogDescription>
		</AlertDialogHeader>
		{#if orchestrated}
			<div class="flex items-start gap-2">
				<Checkbox id="restart-include-done" class="mt-0.5" bind:checked={includeDone} />
				<div class="space-y-1">
					<Label for="restart-include-done" class="font-normal"
						>Auch erledigte Teilaufträge neu starten</Label
					>
					<p class="text-xs text-muted-foreground">
						Sonst werden nur fehlgeschlagene und abgebrochene Teilaufträge neu gestartet.
					</p>
				</div>
			</div>
		{/if}
		<AlertDialogFooter>
			<AlertDialogCancel>Abbrechen</AlertDialogCancel>
			<AlertDialogAction onclick={confirm}>Neu starten</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>
