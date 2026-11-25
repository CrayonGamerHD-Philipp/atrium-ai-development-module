<script lang="ts">
	// Dashboard-Kachel „KI-Agents“: aktive Läufe und offene Rückfragen; leer, wenn nichts läuft
	import { onMount } from 'svelte';
	import Bot from '@lucide/svelte/icons/bot';
	import MessageCircleQuestion from '@lucide/svelte/icons/message-circle-question';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { OverviewDto, OverviewLiveEvent } from '../../schemas';
	import { BASE, getOverview } from '../api';
	import ActiveRunsList from '../components/ActiveRunsList.svelte';
	import { errMsg } from '../format';
	import { LiveStream } from '../live.svelte';

	let { onstatus }: DashboardWidgetProps = $props();

	let overview = $state<OverviewDto | null>(null);
	let loading = $state(true);
	let error = $state('');

	const isEmpty = (o: OverviewDto) => !o.activeRuns.length && !o.tasks.needsInput;

	function apply(o: OverviewDto) {
		overview = o;
		onstatus?.(isEmpty(o) ? 'empty' : 'ready');
	}

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			apply(await getOverview());
		} catch (e) {
			error = errMsg(e, 'KI-Agents konnten nicht geladen werden');
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
		const live = new LiveStream<OverviewLiveEvent>({
			path: '/overview/live',
			withClient: true,
			onEvent: (e) => {
				if (e.type === 'overview') apply(e.overview);
			},
			onReconnect: () => void load()
		});
		live.connect();
		return () => live.close();
	});

	const runs = $derived(overview?.activeRuns.slice(0, 6) ?? []);
</script>

<DashboardCard
	title="KI-Agents"
	icon={Bot}
	href={BASE}
	{loading}
	{error}
	onretry={load}
	empty={!!overview && isEmpty(overview)}
	emptyText="Gerade arbeitet kein Agent."
>
	{#if overview}
		{#if overview.tasks.needsInput}
			<a
				href={BASE}
				class="mb-2 flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-warning-border bg-warning-muted px-3 py-2 text-sm break-words text-warning hover:underline"
			>
				<MessageCircleQuestion class="size-4 shrink-0" aria-hidden="true" />
				{overview.tasks.needsInput}
				{overview.tasks.needsInput === 1 ? 'Rückfrage wartet' : 'Rückfragen warten'} auf Antwort
			</a>
		{/if}
		{#if runs.length}
			<ActiveRunsList {runs} compact />
			{#if overview.activeRuns.length > runs.length}
				<p class="pt-1 text-xs text-muted-foreground">
					+ {overview.activeRuns.length - runs.length} weitere
				</p>
			{/if}
		{/if}
	{/if}
</DashboardCard>
