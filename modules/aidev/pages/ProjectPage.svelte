<script lang="ts">
	// Projektseite: Reiter Board · Chat · Pull Requests · Einstellungen (per `?tab=`), live über `/projects/:id/live`
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, untrack } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import {
		EmptyState,
		ErrorState,
		LoadingState,
		PageHeader,
		PageTitle
	} from '$lib/components/layout';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Tabs from '$lib/components/ui/tabs';
	import { POLICY_LABELS } from '../schemas';
	import { BASE, workspacePath } from './api';
	import LiveIndicator from './components/LiveIndicator.svelte';
	import { has, PERM } from './perms';
	import BoardTab from './project/BoardTab.svelte';
	import ChatTab from './project/ChatTab.svelte';
	import PullsTab from './project/PullsTab.svelte';
	import SettingsTab from './project/SettingsTab.svelte';
	import { ProjectStore } from './project/store.svelte';

	let { params }: ModulePageProps = $props();

	const TABS = ['board', 'chat', 'pulls', 'settings'] as const;
	type Tab = (typeof TABS)[number];

	let store = $state<ProjectStore | null>(null);
	let current: ProjectStore | null = null;

	// Neues Projekt (Navigation zwischen Projekten) → neuer Zustand und neue Verbindung
	$effect(() => {
		const id = params.id ?? '';
		untrack(() => {
			const s = new ProjectStore(id);
			current?.stop();
			current = s;
			store = s;
			s.start();
		});
	});
	onDestroy(() => current?.stop());

	const tab = $derived.by<Tab>(() => {
		const t = page.url.searchParams.get('tab');
		return (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'board';
	});

	function setTab(next: string) {
		const url = new URL(page.url);
		if (next === 'board') url.searchParams.delete('tab');
		else url.searchParams.set('tab', next);
		void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}

	const canWorkspace = $derived(has(PERM.files) || has(PERM.terminal));
	const project = $derived(store?.project ?? null);
	const counts = $derived.by(() => {
		const tasks = store?.tasks ?? [];
		return {
			open: tasks.filter((t) => !['done', 'failed', 'cancelled'].includes(t.status)).length,
			needsInput: tasks.filter((t) => t.status === 'needs-input').length
		};
	});
	const openPulls = $derived(store?.pulls.filter((p) => p.state === 'open').length ?? 0);
</script>

<a href={BASE} class="mb-3 inline-flex items-center gap-1 text-sm text-link hover:underline">
	<ArrowLeft class="size-4" /> Alle Projekte
</a>

{#if !store || (store.loading && !project)}
	<LoadingState rows={4} rowClass="h-16 w-full" label="Projekt" />
{:else if store.notFound}
	<EmptyState
		title="Projekt nicht gefunden"
		description="Es wurde archiviert oder du hast keinen Zugriff."
	>
		<Button href={BASE} variant="outline">Zur Übersicht</Button>
	</EmptyState>
{:else if store.error && !project}
	<ErrorState message={store.error} onretry={() => store?.load()} />
{:else if project}
	<PageTitle title={project.name} />
	<PageHeader
		title={project.name}
		description={`${project.repoOwner}/${project.repoName} · ${project.defaultBranch} · ${POLICY_LABELS[project.commitPolicy]}`}
	>
		{#snippet actions()}
			<LiveIndicator status={store!.live.status} />
			{#if canWorkspace}
				<Button href={workspacePath(project.id)} variant="outline">
					<SquareTerminal /> Workspace öffnen
				</Button>
			{/if}
			<Button
				href={project.repoUrl}
				target="_blank"
				rel="noopener noreferrer"
				variant="ghost"
				aria-label="Repository auf GitHub öffnen"
			>
				<ExternalLink /> GitHub
			</Button>
		{/snippet}
	</PageHeader>

	{#if store.revoked}
		<Alert.Root variant="warning" class="mb-4">
			<Alert.Title>Zugriff entzogen</Alert.Title>
			<Alert.Description
				>Du hast keinen Zugriff mehr auf dieses Projekt. Lade die Seite neu.</Alert.Description
			>
		</Alert.Root>
	{/if}
	{#if project.archivedAt}
		<Alert.Root variant="info" class="mb-4">
			<Alert.Title>Archiviert</Alert.Title>
			<Alert.Description
				>Dieses Projekt ist archiviert und nimmt keine neuen Aufträge an.</Alert.Description
			>
		</Alert.Root>
	{/if}

	<Tabs.Root value={tab} onValueChange={setTab}>
		<Tabs.List variant="line" aria-label="Bereiche des Projekts">
			<Tabs.Trigger value="board">
				Board
				{#if counts.open}<span class="text-xs text-muted-foreground tabular-nums"
						>{counts.open}</span
					>{/if}
				{#if counts.needsInput}
					<span
						class="size-1.5 rounded-full bg-warning"
						title={`${counts.needsInput} Rückfragen`}
						aria-label={`${counts.needsInput} Rückfragen`}
					></span>
				{/if}
			</Tabs.Trigger>
			<Tabs.Trigger value="chat">Chat</Tabs.Trigger>
			<Tabs.Trigger value="pulls">
				Pull Requests
				{#if openPulls}<span class="text-xs text-muted-foreground tabular-nums">{openPulls}</span
					>{/if}
			</Tabs.Trigger>
			<Tabs.Trigger value="settings">Einstellungen</Tabs.Trigger>
		</Tabs.List>
		<div class="pt-4">
			{#key store}
				{#if tab === 'board'}
					<BoardTab {store} />
				{:else if tab === 'chat'}
					<ChatTab {store} />
				{:else if tab === 'pulls'}
					<PullsTab {store} />
				{:else}
					<SettingsTab {store} />
				{/if}
			{/key}
		</div>
	</Tabs.Root>
{/if}
