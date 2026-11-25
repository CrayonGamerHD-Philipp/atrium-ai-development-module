<script lang="ts">
	// Dialog „Projekt anlegen“ (Recht project.manage): GitHub-Repo, Branch, Commit-Policy, Befehle, Regeln.
	// Nach Eingabe des Repos: Name automatisch füllen, Repo über einen Runner prüfen (Haupt-Branch, Branch-Vorschläge).
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { ApiClientError } from '$lib/sdk/client';
	import { BUSY_SAVE } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { projectInput, type RepoProbeDto } from '../../schemas';
	import { createProject, probeRepo, projectPath } from '../api';
	import { errMsg, isUnavailable } from '../format';
	import { branchFromRef, parseRepoInput, repoKey } from '../projects/repo-input';
	import { serverErrors, zodErrors, type FieldErrors } from './form-errors';
	import ProjectFields, { type ProjectFormValues } from './ProjectFields.svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	/** Wartezeit nach der letzten Änderung am Repo-Feld, bevor geprüft wird */
	const PROBE_DELAY_MS = 400;
	const DEFAULT_BRANCH = 'main';

	type Probe =
		| { state: 'idle' }
		| { state: 'loading' }
		| { state: 'done'; result: RepoProbeDto }
		| { state: 'offline' }
		| { state: 'error'; message: string };

	const empty = (): ProjectFormValues => ({
		name: '',
		repo: '',
		defaultBranch: DEFAULT_BRANCH,
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
	let probe = $state<Probe>({ state: 'idle' });
	let branches = $state<string[]>([]);

	// Zuletzt automatisch gesetzte Werte: weicht das Feld davon ab (und ist nicht leer),
	// hat der Nutzer es selbst geändert → nicht mehr überschreiben
	let autoName = '';
	let autoBranch = DEFAULT_BRANCH;
	/** Laufende Nummer der Prüfung; ältere Antworten werden verworfen */
	let probeSeq = 0;

	$effect(() => {
		if (open) {
			values = empty();
			errors = {};
			autoName = '';
			autoBranch = DEFAULT_BRANCH;
		}
	});

	const repoRef = $derived(parseRepoInput(values.repo));
	const repoId = $derived(repoRef ? repoKey(repoRef) : '');

	// Name aus dem Repo übernehmen, solange der Nutzer ihn nicht selbst bearbeitet hat
	$effect(() => {
		const name = repoRef?.name;
		if (!name) return;
		untrack(() => {
			if (!values.name.trim() || values.name === autoName) {
				values.name = name;
				autoName = name;
			}
		});
	});

	// Repo prüfen (verzögert); neue Eingabe oder Schließen bricht die laufende Anfrage ab
	$effect(() => {
		const key = repoId;
		const seq = ++probeSeq;
		branches = [];
		if (!open || !key) {
			probe = { state: 'idle' };
			return;
		}
		probe = { state: 'loading' };
		const ctrl = new AbortController();
		const timer = setTimeout(() => void runProbe(key, seq, ctrl.signal), PROBE_DELAY_MS);
		return () => {
			clearTimeout(timer);
			ctrl.abort();
		};
	});

	async function runProbe(key: string, seq: number, signal: AbortSignal) {
		try {
			const result = await probeRepo(key, { signal });
			if (seq !== probeSeq || signal.aborted) return;
			probe = { state: 'done', result };
			branches = result.branches;
		} catch (err) {
			if (seq !== probeSeq || signal.aborted) return;
			if (isUnavailable(err)) probe = { state: 'offline' };
			// Ohne Recht (403) still bleiben – das Anlegen meldet es ohnehin
			else if (err instanceof ApiClientError && err.status === 403) probe = { state: 'idle' };
			else
				probe = { state: 'error', message: errMsg(err, 'Repository konnte nicht geprüft werden') };
		}
	}

	/** Vorschlag für den Haupt-Branch: Branch aus `/tree/<branch>` im Link, sonst Standard-Branch des Repos */
	const suggestedBranch = $derived(
		branchFromRef(repoRef?.ref ?? null, branches) ??
			(probe.state === 'done' ? probe.result.defaultBranch : null)
	);

	$effect(() => {
		const branch = suggestedBranch;
		if (!branch) return;
		untrack(() => {
			if (!values.defaultBranch.trim() || values.defaultBranch === autoBranch) {
				values.defaultBranch = branch;
				autoBranch = branch;
			}
		});
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const input = {
			...values,
			name: values.name.trim() || repoRef?.name || '',
			// Links mit Unterpfad (`/tree/…`) versteht der Server nicht → auf owner/repo kürzen
			repo: repoRef ? repoKey(repoRef) : values.repo
		};
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

{#snippet repoStatus()}
	<!-- Ergebnis der Repo-Prüfung; blockiert das Anlegen nicht -->
	<div class="space-y-1 text-xs" aria-live="polite">
		{#if probe.state === 'loading'}
			<p class="flex items-center gap-1.5 text-muted-foreground">
				<LoaderCircle class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
				Prüfe Repository …
			</p>
		{:else if probe.state === 'done'}
			{@const r = probe.result}
			{#if r.ok}
				<p class="flex items-center gap-1.5 text-success">
					<CircleCheck class="size-3.5 shrink-0" aria-hidden="true" />
					{r.canPush ? 'Zugriff ok' : 'Zugriff ok – nur lesen, Pushen nicht erlaubt'}
				</p>
			{:else}
				<p class="flex items-start gap-1.5 text-warning">
					<CircleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
					<span class="whitespace-pre-wrap wrap-anywhere"
						>{r.message || 'Repository nicht erreichbar'}</span
					>
				</p>
			{/if}
			{#if r.existingProjectId}
				<p class="flex items-start gap-1.5 text-warning">
					<CircleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
					<span>
						Dieses Repo ist bereits als Projekt angelegt.
						<a
							href={projectPath(r.existingProjectId)}
							class="font-medium underline underline-offset-2"
							onclick={() => (open = false)}>Zum Projekt</a
						>
					</span>
				</p>
			{/if}
		{:else if probe.state === 'offline'}
			<p class="flex items-start gap-1.5 text-muted-foreground">
				<CircleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
				Kein Runner erreichbar – Branches können nicht vorgeschlagen werden
			</p>
		{:else if probe.state === 'error'}
			<p class="flex items-start gap-1.5 text-muted-foreground">
				<CircleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
				<span class="wrap-anywhere">{probe.message}</span>
			</p>
		{/if}
	</div>
{/snippet}

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
			<ProjectFields
				bind:values
				{errors}
				{branches}
				{repoStatus}
				idPrefix="new-project"
				disabled={busy}
			/>
		</form>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={busy}>Abbrechen</Button>
			<Button type="submit" form="new-project-form" disabled={busy}>
				{busy ? BUSY_SAVE : 'Projekt anlegen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
