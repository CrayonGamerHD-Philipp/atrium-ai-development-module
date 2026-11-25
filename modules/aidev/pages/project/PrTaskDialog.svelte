<script lang="ts">
	// Offenen Pull Request mit einem Agent bearbeiten: Auftrag mit `targetPr` anlegen (arbeitet auf dem
	// Head-Branch des PR und aktualisiert ihn), danach zur Auftragsseite wechseln
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { PROVIDERS, type Provider, type Role } from '../../protocol';
	import { PROVIDER_LABELS, ROLE_LABELS, type PullRequestDto } from '../../schemas';
	import { createTask, taskPath } from '../api';
	import { errMsg } from '../format';
	import { serverErrors, type FieldErrors } from '../components/form-errors';

	let {
		open = $bindable(false),
		projectId,
		pr
	}: { open?: boolean; projectId: string; pr: PullRequestDto | null } = $props();

	const DEFAULT_PROMPT =
		'Bearbeite die offenen Review-Kommentare und behebe Merge-Konflikte mit dem Haupt-Branch.';
	/** Umsetzen/Korrektur ändern den PR-Branch, Review liest nur */
	const PR_ROLES: Role[] = ['implement', 'fix', 'review'];
	const roleOptions = PR_ROLES.map((r) => ({
		value: r,
		label: r === 'review' ? `${ROLE_LABELS[r]} (nur lesen)` : ROLE_LABELS[r]
	}));
	const providerOptions = PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }));

	let prompt = $state('');
	let role = $state<Role>('implement');
	let providerHint = $state<Provider | null>(null);
	let errors = $state<FieldErrors>({});
	let error = $state('');
	let busy = $state(false);

	$effect(() => {
		if (open) {
			prompt = DEFAULT_PROMPT;
			role = 'implement';
			providerHint = null;
			errors = {};
			error = '';
		}
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!pr) return;
		const text = prompt.trim();
		if (!text) {
			errors = { prompt: 'Bitte einen Auftragstext eingeben.' };
			return;
		}
		busy = true;
		errors = {};
		error = '';
		try {
			const task = await createTask(projectId, {
				prompt: text,
				role,
				providerHint,
				targetPr: pr.number
			});
			toast.success(`Auftrag für PR #${pr.number} eingeplant`);
			open = false;
			await goto(taskPath(projectId, task.id));
		} catch (err) {
			errors = serverErrors(err);
			// z. B. PR nicht synchronisiert, geschlossen oder ohne eigenen Branch (422)
			if (!errors.prompt) error = errMsg(err, 'Auftrag konnte nicht angelegt werden');
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{pr ? `PR #${pr.number} mit Agent bearbeiten` : 'PR bearbeiten'}</Dialog.Title>
			<Dialog.Description class="wrap-break-word">
				{#if pr}
					„{pr.title}“ – der Agent arbeitet auf dem Branch
					<span class="font-mono wrap-anywhere">{pr.branch}</span> und aktualisiert diesen Pull Request,
					statt einen neuen zu öffnen.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<form id="pr-task" class="grid grid-cols-1 gap-4 sm:grid-cols-2" onsubmit={submit} novalidate>
			<div class="sm:col-span-2">
				<FormField label="Auftrag" id="pr-task-prompt" required error={errors.prompt}>
					<Textarea
						id="pr-task-prompt"
						bind:value={prompt}
						rows={5}
						maxlength={20000}
						disabled={busy}
						class="resize-y"
					/>
				</FormField>
			</div>
			<FormField
				label="Rolle"
				id="pr-task-role"
				hint={role === 'review' ? 'Liest nur und ändert den PR nicht.' : undefined}
			>
				<SelectField
					id="pr-task-role"
					label="Rolle"
					options={roleOptions}
					value={role}
					onchange={(v) => v && (role = v as Role)}
					disabled={busy}
				/>
			</FormField>
			<FormField label="Anbieter erzwingen" id="pr-task-provider">
				<SelectField
					id="pr-task-provider"
					label="Anbieter erzwingen"
					options={providerOptions}
					emptyLabel="Automatisch (Verteilung)"
					value={providerHint}
					onchange={(v) => (providerHint = v as Provider | null)}
					disabled={busy}
				/>
			</FormField>
		</form>
		{#if error}
			<Alert.Root variant="destructive">
				<CircleAlert />
				<Alert.Title>Auftrag nicht angelegt</Alert.Title>
				<Alert.Description>{error}</Alert.Description>
			</Alert.Root>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={busy}>Abbrechen</Button>
			<Button type="submit" form="pr-task" disabled={busy || !pr || !prompt.trim()}
				>{busy ? BUSY_SAVE : 'Auftrag geben'}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
