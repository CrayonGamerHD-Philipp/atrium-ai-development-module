<script lang="ts">
	// Startseite des Moduls: Kennzahlen (live), Projekte, aktive Läufe aller Projekte, Auslastung je Konto
	import { onMount } from 'svelte';
	import Activity from '@lucide/svelte/icons/activity';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import ListTodo from '@lucide/svelte/icons/list-todo';
	import Plus from '@lucide/svelte/icons/plus';
	import Server from '@lucide/svelte/icons/server';
	import Split from '@lucide/svelte/icons/split';
	import { EmptyState, ErrorState, LoadingState, PageHeader } from '$lib/components/layout';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { OverviewDto, OverviewLiveEvent, ProjectDto } from '../schemas';
	import { POLICY_LABELS } from '../schemas';
	import { BASE, getOverview, listProjects, projectPath } from './api';
	import AccountUsageList from './components/AccountUsageList.svelte';
	import ActiveRunsList from './components/ActiveRunsList.svelte';
	import LiveIndicator from './components/LiveIndicator.svelte';
	import ProjectCreateDialog from './components/ProjectCreateDialog.svelte';
	import TimeAgo from './components/TimeAgo.svelte';
	import { errMsg } from './format';
	import { LiveStream } from './live.svelte';
	import { has, PERM } from './perms';

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

	const visible = $derived(
		[...projects]
			.filter((p) => !p.archivedAt)
			.sort(
				(a, b) =>
					b.counts.running + b.counts.needsInput - (a.counts.running + a.counts.needsInput) ||
					b.updatedAt.localeCompare(a.updatedAt)
			)
	);

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
		<h2 id="aidev-projects" class="text-section">Projekte</h2>
		{#if loading && !projects.length}
			<LoadingState rows={3} rowClass="h-28 w-full" label="Projekte" />
		{:else if loadError}
			<ErrorState message={loadError} onretry={loadProjects} />
		{:else if !visible.length}
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
			<ul class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{#each visible as p (p.id)}
					<li>
						<a
							href={projectPath(p.id)}
							class="group block h-full rounded-lg border bg-card p-4 transition-colors outline-none hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring"
						>
							<div class="flex items-start gap-3">
								<FolderGit2
									class="mt-0.5 size-5 shrink-0 text-muted-foreground"
									aria-hidden="true"
								/>
								<div class="min-w-0 flex-1">
									<div class="truncate font-medium group-hover:underline">{p.name}</div>
									<div class="truncate font-mono text-xs text-muted-foreground">
										{p.repoOwner}/{p.repoName} · {p.defaultBranch}
									</div>
								</div>
								{#if p.counts.needsInput}
									<Badge variant="warning"
										>{p.counts.needsInput} Rückfrage{p.counts.needsInput === 1 ? '' : 'n'}</Badge
									>
								{/if}
							</div>
							<dl class="mt-4 grid grid-cols-4 gap-2 text-center">
								<div>
									<dt class="text-xs text-muted-foreground">Wartet</dt>
									<dd class="text-sm font-semibold tabular-nums">{p.counts.queued}</dd>
								</div>
								<div>
									<dt class="text-xs text-muted-foreground">Läuft</dt>
									<dd
										class="text-sm font-semibold tabular-nums"
										class:text-info={p.counts.running > 0}
									>
										{p.counts.running}
									</dd>
								</div>
								<div>
									<dt class="text-xs text-muted-foreground">PR offen</dt>
									<dd class="text-sm font-semibold tabular-nums">{p.counts.review}</dd>
								</div>
								<div>
									<dt class="text-xs text-muted-foreground">Fertig</dt>
									<dd class="text-sm font-semibold tabular-nums">{p.counts.done}</dd>
								</div>
							</dl>
							<div
								class="mt-3 flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground"
							>
								<span class="inline-flex items-center gap-1 truncate">
									<GitPullRequest class="size-3.5" aria-hidden="true" />
									{POLICY_LABELS[p.commitPolicy]}
								</span>
								<TimeAgo value={p.updatedAt} />
							</div>
						</a>
					</li>
				{/each}
			</ul>
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
