<script lang="ts">
	// Dialog „Projekt anlegen“ (Recht project.manage): GitHub-Repo, Branch, Commit-Policy, Befehle, Regeln
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { BUSY_SAVE } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { projectInput } from '../../schemas';
	import { createProject, projectPath } from '../api';
	import { errMsg } from '../format';
	import { serverErrors, zodErrors, type FieldErrors } from './form-errors';
	import ProjectFields, { type ProjectFormValues } from './ProjectFields.svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const empty = (): ProjectFormValues => ({
		name: '',
		repo: '',
		defaultBranch: 'main',
		commitPolicy: 'pr',
		maxParallel: 2,
		setupCmd: '',
		testCmd: '',
		instructions: '',
		preferredRunnerId: null
	});

	let values = $state<ProjectFormValues>(empty());
	let errors = $state<FieldErrors>({});
	let busy = $state(false);

	$effect(() => {
		if (open) {
			values = empty();
			errors = {};
		}
	});

	/** Name aus dem Repo vorschlagen, solange keiner eingegeben ist */
	const suggestedName = $derived.by(() => {
		const m = /([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(values.repo.trim());
		return m?.[1] ?? '';
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const input = { ...values, name: values.name.trim() || suggestedName };
		const parsed = projectInput.safeParse(input);
		if (!parsed.success) {
			errors = zodErrors(parsed.error);
			const first = Object.keys(errors)[0];
			document.getElementById(`new-project-${fieldId(first)}`)?.focus();
			return;
		}
		busy = true;
		errors = {};
		try {
			const project = await createProject(parsed.data);
			toast.success('Projekt angelegt');
			open = false;
			await goto(projectPath(project.id));
		} catch (err) {
			errors = serverErrors(err);
			if (!Object.keys(errors).length)
				toast.error(errMsg(err, 'Projekt konnte nicht angelegt werden'));
		} finally {
			busy = false;
		}
	}

	function fieldId(key: string | undefined): string {
		switch (key) {
			case 'defaultBranch':
				return 'branch';
			case 'maxParallel':
				return 'parallel';
			case 'commitPolicy':
				return 'policy';
			case 'setupCmd':
				return 'setup';
			case 'testCmd':
				return 'test';
			case 'instructions':
				return 'rules';
			default:
				return key ?? 'name';
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Projekt anlegen</Dialog.Title>
			<Dialog.Description>
				Verbinde ein GitHub-Repository. Die Runner brauchen Zugriff darauf (gh-Anmeldung oder
				Token).
			</Dialog.Description>
		</Dialog.Header>
		<form id="new-project-form" onsubmit={submit} class="space-y-4" novalidate>
			<ProjectFields bind:values {errors} idPrefix="new-project" disabled={busy} />
			{#if !values.name.trim() && suggestedName}
				<p class="text-xs wrap-break-word text-muted-foreground">
					Ohne Namen wird „{suggestedName}“ verwendet.
				</p>
			{/if}
		</form>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={busy}>Abbrechen</Button>
			<Button type="submit" form="new-project-form" disabled={busy}>
				{busy ? BUSY_SAVE : 'Projekt anlegen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
