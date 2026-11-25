<script lang="ts">
	// Startseite des Moduls: Kennzahlen (live), Projekte, aktive Läufe aller Projekte, Auslastung je Konto
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import Activity from '@lucide/svelte/icons/activity';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import ListTodo from '@lucide/svelte/icons/list-todo';
	import Plus from '@lucide/svelte/icons/plus';
	import Server from '@lucide/svelte/icons/server';
	import Split from '@lucide/svelte/icons/split';
	import { EmptyState, ErrorState, LoadingState, PageHeader } from '$lib/components/layout';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { OverviewDto, OverviewLiveEvent, ProjectDto } from '../schemas';
	import { BASE, getOverview, listProjects, projectPath } from './api';
	import AccountUsageList from './components/AccountUsageList.svelte';
	import ActiveRunsList from './components/ActiveRunsList.svelte';
	import LiveIndicator from './components/LiveIndicator.svelte';
	import ProjectCreateDialog from './components/ProjectCreateDialog.svelte';
	import { errMsg } from './format';
	import { LiveStream } from './live.svelte';
	import { has, PERM } from './perms';
	import {
		defaultView,
		filterProjects,
		isProjectSort,
		isStatusFilter,
		loadFavorites,
		loadView,
		parseQuery,
		saveFavorites,
		saveView,
		statusCounts,
		type ProjectSort,
		type ProjectStatusFilter,
		type ProjectView
	} from './projects/filter';
	import ProjectCard from './projects/ProjectCard.svelte';
	import ProjectRow from './projects/ProjectRow.svelte';
	import ProjectToolbar from './projects/ProjectToolbar.svelte';

	let overview = $state<OverviewDto | null>(null);
	let projects = $state<ProjectDto[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let overviewError = $state('');
	let createOpen = $state(false);
	let live = $state<LiveStream<OverviewLiveEvent> | null>(null);

	const canManage = $derived(has(PERM.projectManage));
	const canRunners = $derived(has(PERM.runnerManage));
	const canRouting = $derived(has(PERM.settingsManage));

	async function loadProjects() {
		loading = true;
		loadError = '';
		try {
			projects = await listProjects();
		} catch (e) {
			loadError = errMsg(e, 'Projekte konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	async function loadOverview() {
		try {
			overview = await getOverview();
			overviewError = '';
		} catch (e) {
			overviewError = errMsg(e, 'Übersicht konnte nicht geladen werden');
		}
	}

	onMount(() => {
		void loadProjects();
		void loadOverview();
		const stream = new LiveStream<OverviewLiveEvent>({
			path: '/overview/live',
			withClient: true,
			onEvent: (e) => {
				if (e.type === 'overview') overview = e.overview;
			},
			onReconnect: () => {
				void loadOverview();
				void loadProjects();
			}
		});
		stream.connect();
		live = stream;
		return () => stream.close();
	});

	// Suche, Filter und Sortierung – Zustand im URL-Query (?q=&status=&sort=), Filterung sofort
	const initial = page.url.searchParams;
	const initialStatus = initial.get('status');
	const initialSort = initial.get('sort');
	let query = $state(initial.get('q') ?? '');
	let status = $state<ProjectStatusFilter>(isStatusFilter(initialStatus) ? initialStatus : 'all');
	let sort = $state<ProjectSort>(isProjectSort(initialSort) ? initialSort : 'activity');
	let favorites = $state.raw<ReadonlySet<string>>(loadFavorites());
	let viewChoice = $state<ProjectView | null>(loadView());
	let searchInput = $state<HTMLInputElement | null>(null);

	const active = $derived(projects.filter((p) => !p.archivedAt));
	const tokens = $derived(parseQuery(query));
	const visible = $derived(filterProjects(projects, { query, status, sort, favorites }));
	const counts = $derived(statusCounts(projects, favorites));
	const view = $derived<ProjectView>(viewChoice ?? defaultView(active.length));
	const filtered = $derived(tokens.length > 0 || status !== 'all');

	// Link/Zurück auf dieselbe Seite mit anderem Query: Zustand aus der URL übernehmen
	afterNavigate(({ type }) => {
		if (type !== 'link' && type !== 'popstate') return;
		const params = page.url.searchParams;
		const s = params.get('status');
		const o = params.get('sort');
		query = params.get('q') ?? '';
		status = isStatusFilter(s) ? s : 'all';
		sort = isProjectSort(o) ? o : 'activity';
	});

	let urlTimer: ReturnType<typeof setTimeout> | undefined;
	function syncUrl() {
		clearTimeout(urlTimer);
		const url = new URL(page.url);
		const q = query.trim();
		if (q) url.searchParams.set('q', q);
		else url.searchParams.delete('q');
		if (status !== 'all') url.searchParams.set('status', status);
		else url.searchParams.delete('status');
		if (sort !== 'activity') url.searchParams.set('sort', sort);
		else url.searchParams.delete('sort');
		if (url.search === page.url.search) return;
		void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}

	// Nur das URL-Update entprellen (~150 ms), die Liste filtert sofort
	$effect(() => {
		void query;
		clearTimeout(urlTimer);
		urlTimer = setTimeout(syncUrl, 150);
		return () => clearTimeout(urlTimer);
	});

	function setStatus(next: ProjectStatusFilter) {
		status = next;
		syncUrl();
	}

	function setSort(next: ProjectSort) {
		sort = next;
		syncUrl();
	}

	function setView(next: ProjectView) {
		viewChoice = next;
		saveView(next);
	}

	function resetFilters() {
		query = '';
		status = 'all';
		syncUrl();
		searchInput?.focus();
	}

	function toggleFavorite(id: string) {
		const next = new Set(favorites);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		favorites = next;
		saveFavorites(next);
	}

	function onQueryKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && query) {
			e.preventDefault();
			query = '';
		} else if (e.key === 'Enter' && visible.length === 1) {
			e.preventDefault();
			void goto(projectPath(visible[0]!.id));
		}
	}

	/** Fokus liegt in einem Eingabeelement – dann keine Tastenkürzel abfangen */
	function isEditable(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		return (
			target.isContentEditable ||
			target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.tagName === 'SELECT'
		);
	}

	// „/“ fokussiert die Suche. Strg/⌘+K bleibt der globalen Befehlspalette des Cores vorbehalten.
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
		if (!searchInput || createOpen || isEditable(e.target)) return;
		e.preventDefault();
		searchInput.focus();
		searchInput.select();
	}

	const stats = $derived(
		overview
			? [
					{
						label: 'Runner online',
						value: `${overview.runners.online}`,
						sub: `von ${overview.runners.total}${overview.runners.pendingApproval ? ` · ${overview.runners.pendingApproval} wartet auf Freigabe` : ''}`,
						icon: Server,
						tone: overview.runners.online ? '' : 'text-warning'
					},
					{
						label: 'Laufende Läufe',
						value: `${overview.tasks.running}`,
						sub: `${overview.activeRuns.length} aktiv`,
						icon: Activity,
						tone: ''
					},
					{
						label: 'Warteschlange',
						value: `${overview.tasks.queued}`,
						sub: overview.tasks.review ? `${overview.tasks.review} PR offen` : 'Aufträge warten',
						icon: ListTodo,
						tone: ''
					},
					{
						label: 'Rückfragen',
						value: `${overview.tasks.needsInput}`,
						sub: overview.tasks.failed
							? `${overview.tasks.failed} fehlgeschlagen`
							: 'warten auf dich',
						icon: CircleHelp,
						tone: overview.tasks.needsInput ? 'text-warning' : ''
					}
				]
			: []
	);
</script>

<svelte:window onkeydown={onWindowKeydown} />

<PageHeader
	title="KI-Entwicklung"
	description="Aufträge an Coding-Agents geben – sie arbeiten auf deinen Runnern, committen und öffnen Pull Requests."
>
	{#snippet actions()}
		{#if canManage}
			<Button onclick={() => (createOpen = true)}><Plus /> Projekt anlegen</Button>
		{/if}
		{#if canRunners}
			<Button variant="outline" href={`${BASE}/runners`}><Server /> Runner & Konten</Button>
		{/if}
		{#if canRouting}
			<Button variant="ghost" href={`${BASE}/routing`}><Split /> Verteilung</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class="space-y-6">
	<section aria-labelledby="aidev-stats" class="space-y-3">
		<div class="flex items-center justify-between gap-2">
			<h2 id="aidev-stats" class="sr-only">Kennzahlen</h2>
			{#if live}<LiveIndicator status={live.status} class="ml-auto" />{/if}
		</div>
		{#if overviewError && !overview}
			<ErrorState message={overviewError} onretry={loadOverview} compact />
		{:else if !overview}
			<LoadingState rows={1} rowClass="h-20 w-full" label="Kennzahlen" />
		{:else}
			<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
				{#each stats as s (s.label)}
					<div class="rounded-lg border bg-card p-3">
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<s.icon class="size-3.5" aria-hidden="true" />
							{s.label}
						</div>
						<div class={`mt-1 text-2xl font-semibold tabular-nums ${s.tone}`}>{s.value}</div>
						<div class="truncate text-xs text-muted-foreground">{s.sub}</div>
					</div>
				{/each}
			</div>
			{#if overview.runners.online === 0}
				<Alert.Root variant="warning">
					<Server />
					<Alert.Title>Kein Runner online</Alert.Title>
					<Alert.Description>
						Aufträge warten, bis ein Runner verbunden ist.
						{#if canRunners}
							<a href={`${BASE}/runners`} class="underline">Runner einrichten</a>
						{:else}
							Bitte die Verwaltung, einen Runner zu starten.
						{/if}
					</Alert.Description>
				</Alert.Root>
			{:else if overview.runners.pendingApproval && canRunners}
				<Alert.Root variant="info">
					<Server />
					<Alert.Title>Neuer Runner wartet auf Freigabe</Alert.Title>
					<Alert.Description>
						<a href={`${BASE}/runners`} class="underline">Unter Runner & Konten freigeben</a>
					</Alert.Description>
				</Alert.Root>
			{/if}
		{/if}
	</section>

	<section aria-labelledby="aidev-projects" class="space-y-3">
		<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
			<h2 id="aidev-projects" class="text-section">Projekte</h2>
			{#if active.length}
				<p class="text-xs text-muted-foreground tabular-nums" aria-live="polite">
					{#if filtered}
						{visible.length} von {active.length} Projekt{active.length === 1 ? '' : 'en'}
					{:else}
						{active.length} Projekt{active.length === 1 ? '' : 'e'}
					{/if}
				</p>
			{/if}
		</div>
		{#if loading && !projects.length}
			<LoadingState rows={3} rowClass="h-28 w-full" label="Projekte" />
		{:else if loadError}
			<ErrorState message={loadError} onretry={loadProjects} />
		{:else if !active.length}
			<EmptyState
				title="Noch keine Projekte"
				description={canManage
					? 'Lege ein Projekt für ein GitHub-Repository an. Danach gibst du Aufträge per Chat oder Board.'
					: 'Sobald jemand ein Projekt anlegt, erscheint es hier.'}
			>
				{#if canManage}
					<Button onclick={() => (createOpen = true)}><Plus /> Projekt anlegen</Button>
				{/if}
			</EmptyState>
		{:else}
			<ProjectToolbar
				bind:query
				bind:input={searchInput}
				{status}
				{sort}
				{view}
				{counts}
				onstatus={setStatus}
				onsort={setSort}
				onview={setView}
				onquerykeydown={onQueryKeydown}
			/>
			{#if !visible.length}
				<EmptyState
					title="Keine Projekte gefunden"
					description={tokens.length
						? `Kein Projekt passt zu „${query.trim()}“${status !== 'all' ? ' im gewählten Filter' : ''}.`
						: 'Kein Projekt passt zum gewählten Filter.'}
				>
					<Button variant="outline" onclick={resetFilters}>Suche & Filter zurücksetzen</Button>
				</EmptyState>
			{:else if view === 'list'}
				<ul class="divide-y overflow-hidden rounded-lg border bg-card">
					{#each visible as p (p.id)}
						<li>
							<ProjectRow
								project={p}
								{tokens}
								favorite={favorites.has(p.id)}
								ontogglefavorite={() => toggleFavorite(p.id)}
							/>
						</li>
					{/each}
				</ul>
			{:else}
				<ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 min-[110rem]:grid-cols-4">
					{#each visible as p (p.id)}
						<li>
							<ProjectCard
								project={p}
								{tokens}
								favorite={favorites.has(p.id)}
								ontogglefavorite={() => toggleFavorite(p.id)}
							/>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	{#if overview}
		<section aria-labelledby="aidev-runs">
			<Card.Root>
				<Card.Header>
					<Card.Title id="aidev-runs">Aktive Läufe</Card.Title>
					<Card.Description>Agents, die gerade an Aufträgen arbeiten</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if overview.activeRuns.length}
						<ActiveRunsList runs={overview.activeRuns} />
					{:else}
						<p class="py-4 text-center text-sm text-muted-foreground">
							Gerade arbeitet kein Agent. Neue Aufträge gibst du im Projekt per Chat oder Board.
						</p>
					{/if}
				</Card.Content>
			</Card.Root>
		</section>

		<section aria-labelledby="aidev-usage" class="space-y-3">
			<div>
				<h2 id="aidev-usage" class="text-section">Auslastung der Konten</h2>
				<p class="text-xs text-muted-foreground">
					Verbrauch je Anbieter-Abo im 5-Stunden-Fenster und in der Woche. Der Scheduler verteilt
					Läufe gleichmäßig.
				</p>
			</div>
			{#if overview.accounts.length}
				<AccountUsageList accounts={overview.accounts} />
			{:else}
				<p class="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
					Noch keine Konten. Konten meldet ein Runner beim Verbinden an.
				</p>
			{/if}
		</section>
	{/if}
</div>

{#if canManage}
	<ProjectCreateDialog bind:open={createOpen} />
{/if}
