<script lang="ts">
	// Projekteinstellungen: Formular (projectPatch), „Repo prüfen“ über einen Runner, Archivieren
	import { goto } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Archive from '@lucide/svelte/icons/archive';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import { BUSY_SAVE, ConfirmDialog } from '$lib/components/layout';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { projectPatch, type ProjectDto } from '../../schemas';
	import {
		archiveProject,
		BASE,
		checkProject,
		listRunners,
		updateProject,
		type RepoCheck
	} from '../api';
	import { errMsg } from '../format';
	import { has, PERM } from '../perms';
	import { serverErrors, zodErrors, type FieldErrors } from '../components/form-errors';
	import ProjectFields, { type ProjectFormValues } from '../components/ProjectFields.svelte';
	import type { ProjectStore } from './store.svelte';

	let { store }: { store: ProjectStore } = $props();

	const canManage = $derived(has(PERM.projectManage));
	const canRunners = $derived(has(PERM.runnerManage));

	const fromProject = (p: ProjectDto): ProjectFormValues => ({
		name: p.name,
		repo: `${p.repoOwner}/${p.repoName}`,
		defaultBranch: p.defaultBranch,
		commitPolicy: p.commitPolicy,
		maxParallel: p.maxParallel,
		setupCmd: p.setupCmd,
		testCmd: p.testCmd,
		instructions: p.instructions,
		preferredRunnerId: p.preferredRunnerId
	});

	// Entwurf: einmal aus dem Projekt übernehmen; Live-Änderungen überschreiben keine laufende Eingabe
	const initial = untrack(() => fromProject(store.project!));
	let values = $state<ProjectFormValues>(initial);
	let baseline = $state(JSON.stringify(initial));
	let errors = $state<FieldErrors>({});
	let busy = $state(false);
	let checking = $state(false);
	let check = $state<RepoCheck | null>(null);
	let checkError = $state('');
	let archiveOpen = $state(false);
	let runners = $state<{ id: string; name: string }[] | null>(null);

	const dirty = $derived(JSON.stringify(values) !== baseline);

	$effect(() => {
		const p = store.project;
		if (p && !dirty) {
			const next = fromProject(p);
			const s = JSON.stringify(next);
			if (s !== baseline) {
				values = next;
				baseline = s;
			}
		}
	});

	onMount(() => {
		if (canRunners)
			listRunners()
				.then((list) => (runners = list.map((r) => ({ id: r.id, name: r.name }))))
				.catch(() => (runners = null));
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		const { repo: _repo, ...rest } = values;
		void _repo;
		const parsed = projectPatch.safeParse(rest);
		if (!parsed.success) {
			errors = zodErrors(parsed.error);
			return;
		}
		busy = true;
		errors = {};
		try {
			const p = await updateProject(store.id, parsed.data);
			store.project = p;
			values = fromProject(p);
			baseline = JSON.stringify(values);
			toast.success('Einstellungen gespeichert');
		} catch (err) {
			errors = serverErrors(err);
			if (!Object.keys(errors).length) toast.error(errMsg(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}

	async function runCheck() {
		checking = true;
		check = null;
		checkError = '';
		try {
			check = await checkProject(store.id);
		} catch (e) {
			checkError = errMsg(e, 'Prüfung fehlgeschlagen');
		} finally {
			checking = false;
		}
	}

	async function archive() {
		try {
			await archiveProject(store.id);
			toast.success('Projekt archiviert');
			await goto(BASE);
		} catch (e) {
			toast.error(errMsg(e, 'Archivieren fehlgeschlagen'));
		}
	}
</script>

<div class="space-y-6">
	<Card.Root>
		<Card.Header>
			<Card.Title>Projekt</Card.Title>
			<Card.Description class="wrap-anywhere">
				Repository {store.project?.repoOwner}/{store.project?.repoName} – das Repository selbst lässt
				sich nicht ändern.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form id="project-settings" onsubmit={save} class="space-y-4" novalidate>
				<ProjectFields
					bind:values
					{errors}
					showRepo={false}
					branches={check?.branches ?? []}
					runners={canRunners ? runners : null}
					disabled={!canManage || busy}
					idPrefix="project-settings"
				/>
				{#if !canManage}
					<p class="text-xs text-muted-foreground">
						Nur Ansicht – Ändern braucht das Recht „Projekte verwalten“.
					</p>
				{/if}
			</form>
		</Card.Content>
		{#if canManage}
			<Card.Footer class="flex-wrap justify-end gap-2">
				{#if dirty}
					<Button
						variant="ghost"
						onclick={() => store.project && (values = fromProject(store.project))}
						disabled={busy}>Verwerfen</Button
					>
				{/if}
				<Button type="submit" form="project-settings" disabled={busy || !dirty}>
					{busy ? BUSY_SAVE : 'Speichern'}
				</Button>
			</Card.Footer>
		{/if}
	</Card.Root>

	{#if canManage}
		<Card.Root>
			<Card.Header>
				<Card.Title>Repository prüfen</Card.Title>
				<Card.Description>
					Ein Runner klont das Repository und prüft, ob er pushen darf.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3">
				<Button variant="outline" onclick={runCheck} disabled={checking}>
					<ShieldCheck />
					{checking ? 'Prüft …' : 'Repo prüfen'}
				</Button>
				{#if check}
					<Alert.Root variant={check.ok && check.canPush ? 'success' : 'warning'}>
						<Alert.Title>
							{check.ok
								? check.canPush
									? 'Alles in Ordnung'
									: 'Lesen ja, pushen nein'
								: 'Repository nicht erreichbar'}
						</Alert.Title>
						<Alert.Description>
							<p class="whitespace-pre-wrap wrap-anywhere">{check.message}</p>
							{#if check.defaultBranch && check.defaultBranch !== store.project?.defaultBranch}
								<p>
									Standard-Branch auf GitHub: <code class="font-mono wrap-anywhere"
										>{check.defaultBranch}</code
									>
									(eingestellt:
									<code class="font-mono wrap-anywhere">{store.project?.defaultBranch}</code>)
								</p>
							{/if}
						</Alert.Description>
					</Alert.Root>
				{:else if checkError}
					<Alert.Root variant="destructive">
						<Alert.Title>Prüfung fehlgeschlagen</Alert.Title>
						<Alert.Description>{checkError}</Alert.Description>
					</Alert.Root>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root class="border-destructive-border">
			<Card.Header>
				<Card.Title>Projekt archivieren</Card.Title>
				<Card.Description>
					Das Projekt verschwindet aus der Übersicht. Aufträge, Verlauf und Pull Requests bleiben
					erhalten.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Button variant="destructive" onclick={() => (archiveOpen = true)}>
					<Archive /> Archivieren
				</Button>
			</Card.Content>
		</Card.Root>
	{/if}
</div>

<ConfirmDialog
	bind:open={archiveOpen}
	title="Projekt archivieren?"
	description={`„${store.project?.name ?? ''}“ wird archiviert und aus der Übersicht entfernt.`}
	confirmLabel="Archivieren"
	destructive
	onconfirm={archive}
/>
