<script lang="ts">
	// Auftrag bearbeiten (solange Entwurf oder wartend): Titel, Prompt, Priorität, Anbieter, Versuche
	import { toast } from 'svelte-sonner';
	import { BUSY_SAVE, FormField, NumberStepper } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { PROVIDERS, type Provider } from '../../protocol';
	import { PROVIDER_LABELS, taskPatch, type TaskDto } from '../../schemas';
	import { updateTask } from '../api';
	import { errMsg } from '../format';
	import { serverErrors, zodErrors, type FieldErrors } from '../components/form-errors';

	let {
		open = $bindable(false),
		task,
		onsaved
	}: { open?: boolean; task: TaskDto; onsaved?: (t: TaskDto) => void } = $props();

	let title = $state('');
	let prompt = $state('');
	let priority = $state(0);
	let providerHint = $state<Provider | null>(null);
	let maxAttempts = $state(3);
	let errors = $state<FieldErrors>({});
	let busy = $state(false);

	$effect(() => {
		if (open) {
			title = task.title;
			prompt = task.prompt;
			priority = task.priority;
			providerHint = task.providerHint;
			maxAttempts = task.maxAttempts;
			errors = {};
		}
	});

	const providerOptions = PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }));

	async function save(e: SubmitEvent) {
		e.preventDefault();
		const parsed = taskPatch.safeParse({
			title: title.trim() || undefined,
			prompt,
			priority,
			providerHint,
			maxAttempts
		});
		if (!parsed.success) {
			errors = zodErrors(parsed.error);
			return;
		}
		busy = true;
		try {
			const t = await updateTask(task.id, parsed.data);
			toast.success('Auftrag gespeichert');
			onsaved?.(t);
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
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Auftrag bearbeiten</Dialog.Title>
			<Dialog.Description>Änderungen wirken beim nächsten Start eines Laufs.</Dialog.Description>
		</Dialog.Header>
		<form id="task-edit" class="grid gap-4 sm:grid-cols-3" onsubmit={save} novalidate>
			<div class="sm:col-span-3">
				<FormField label="Titel" id="task-edit-title" error={errors.title}>
					<Input id="task-edit-title" bind:value={title} maxlength={200} disabled={busy} />
				</FormField>
			</div>
			<div class="sm:col-span-3">
				<FormField label="Auftrag (Prompt)" id="task-edit-prompt" required error={errors.prompt}>
					<Textarea
						id="task-edit-prompt"
						bind:value={prompt}
						rows={10}
						maxlength={20000}
						disabled={busy}
						class="font-mono text-xs"
					/>
				</FormField>
			</div>
			<FormField label="Priorität" id="task-edit-priority" hint="−10 bis 10, höher = früher">
				<NumberStepper
					id="task-edit-priority"
					label="Priorität"
					bind:value={priority}
					min={-10}
					max={10}
					disabled={busy}
				/>
			</FormField>
			<FormField label="Max. Versuche" id="task-edit-attempts">
				<NumberStepper
					id="task-edit-attempts"
					label="Max. Versuche"
					bind:value={maxAttempts}
					min={1}
					max={10}
					disabled={busy}
				/>
			</FormField>
			<FormField label="Anbieter" id="task-edit-provider">
				<SelectField
					id="task-edit-provider"
					label="Anbieter"
					options={providerOptions}
					emptyLabel="Automatisch"
					value={providerHint}
					onchange={(v) => (providerHint = v as Provider | null)}
					disabled={busy}
				/>
			</FormField>
		</form>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={busy}>Abbrechen</Button>
			<Button type="submit" form="task-edit" disabled={busy}
				>{busy ? BUSY_SAVE : 'Speichern'}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
