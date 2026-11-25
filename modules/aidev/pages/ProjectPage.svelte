<script lang="ts">
	// Projektseite: Reiter Board · Chat · Pull Requests · Einstellungen (per `?tab=`), live über `/projects/:id/live`
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, untrack } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { EmptyState, ErrorState, LoadingState, PageTitle } from '$lib/components/layout';
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

	/** Mobil-Vollbild-Chat wurde mit eigenem Verlaufseintrag geöffnet (Zurück-Geste schließt nur den Chat) */
	let chatPushed = false;
	/** Nach dem Schließen des Vollbild-Chats den Fokus auf den Reiter „Chat“ legen */
	let focusChatTab = false;
	let chatTrigger = $state<HTMLElement | null>(null);

	function setTab(next: string) {
		const url = new URL(page.url);
		if (next === 'board') url.searchParams.delete('tab');
		else url.searchParams.set('tab', next);
		// Mobil ist der Chat ein Vollbild → eigener Verlaufseintrag, damit „Zurück“ (Browser/Android) ihn schließt
		const push =
			next === 'chat' && tab !== 'chat' && !window.matchMedia('(min-width: 1024px)').matches;
		chatPushed = push;
		void goto(url, { replaceState: !push, noScroll: true, keepFocus: true });
	}

	function closeChat() {
		focusChatTab = true;
		if (chatPushed) {
			chatPushed = false;
			history.back();
		} else setTab('board');
	}

	// Chat verlassen (auch per Zurück-Geste) → Verlaufseintrag ist verbraucht
	$effect(() => {
		if (tab !== 'chat') chatPushed = false;
	});
	// nach der Navigation (also nach SvelteKits Fokus-Reset) den Fokus auf den Reiter „Chat“ legen
	afterNavigate(() => {
		if (!focusChatTab || tab === 'chat') return;
		focusChatTab = false;
		chatTrigger?.focus();
	});

	/** Reiter mobil nicht stauchen und mit 40-px-Touch-Ziel */
	const TRIGGER = 'flex-none max-sm:min-h-10 max-sm:px-2.5';

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
	<!-- Eigener Kopf (Aufbau wie PageHeader): lange Repo-/Branch-Namen brechen mobil um, statt die Seite zu verbreitern -->
	<div class="mb-6 flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0 flex-1 basis-64">
			<h1 class="text-title wrap-break-word">{project.name}</h1>
			<p class="mt-1 flex flex-wrap gap-x-1.5 text-sm text-muted-foreground">
				<span class="font-mono wrap-anywhere">{project.repoOwner}/{project.repoName}</span>
				<span aria-hidden="true">·</span>
				<span class="font-mono wrap-anywhere">{project.defaultBranch}</span>
				<span aria-hidden="true">·</span>
				<span>{POLICY_LABELS[project.commitPolicy]}</span>
			</p>
		</div>
		<div class="flex max-w-full min-w-0 flex-wrap items-center gap-2">
			<LiveIndicator status={store.live.status} />
			{#if canWorkspace}
				<!-- Mobil nur Symbol (40 px), Text bleibt für Screenreader -->
				<Button
					href={workspacePath(project.id)}
					variant="outline"
					class="max-sm:size-10"
					title="Workspace öffnen"
				>
					<SquareTerminal aria-hidden="true" />
					<span class="max-sm:sr-only">Workspace öffnen</span>
				</Button>
			{/if}
			<Button
				href={project.repoUrl}
				target="_blank"
				rel="noopener noreferrer"
				variant="ghost"
				class="max-sm:size-10"
				aria-label="Repository auf GitHub öffnen"
				title="Repository auf GitHub öffnen"
			>
				<ExternalLink aria-hidden="true" />
				<span class="max-sm:sr-only">GitHub</span>
			</Button>
		</div>
	</div>

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
		<!-- Mobil seitlich scrollbar statt Umbruch; pb-1.5 hält die Aktiv-Linie (after:-bottom) sichtbar -->
		<div
			class="-mx-4 overflow-x-auto px-4 pb-1.5 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
		>
			<Tabs.List variant="line" aria-label="Bereiche des Projekts" class="flex-nowrap">
				<Tabs.Trigger value="board" class={TRIGGER}>
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
				<Tabs.Trigger value="chat" class={TRIGGER} bind:ref={chatTrigger}>Chat</Tabs.Trigger>
				<Tabs.Trigger value="pulls" class={TRIGGER}>
					Pull Requests
					{#if openPulls}<span class="text-xs text-muted-foreground tabular-nums">{openPulls}</span
						>{/if}
				</Tabs.Trigger>
				<Tabs.Trigger value="settings" class={TRIGGER}>Einstellungen</Tabs.Trigger>
			</Tabs.List>
		</div>
		<div class="pt-4">
			{#key store}
				{#if tab === 'board'}
					<BoardTab {store} />
				{:else if tab === 'chat'}
					<!-- Mobil Vollbild: „Zurück“ führt zum Board (bzw. zum vorherigen Verlaufseintrag) -->
					<ChatTab {store} onclose={closeChat} />
				{:else if tab === 'pulls'}
					<PullsTab {store} />
				{:else}
					<SettingsTab {store} />
				{/if}
			{/key}
		</div>
	</Tabs.Root>
{/if}
