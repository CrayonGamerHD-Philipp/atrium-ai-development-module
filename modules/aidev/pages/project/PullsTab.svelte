<script lang="ts">
	// Pull Requests des Projekts: Status, Checks, Synchronisieren, Mergen (project.manage), Link zu GitHub
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Bot from '@lucide/svelte/icons/bot';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import GitMerge from '@lucide/svelte/icons/git-merge';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { ConfirmDialog, DataTable } from '$lib/components/layout';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Table from '$lib/components/ui/table';
	import type { PullRequestDto } from '../../schemas';
	import { mergePull, syncPulls, taskPath, type MergeMethod } from '../api';
	import { errMsg, PR_STATE_LABELS, type BadgeTone } from '../format';
	import { has, PERM } from '../perms';
	import TimeAgo from '../components/TimeAgo.svelte';
	import PrTaskDialog from './PrTaskDialog.svelte';
	import type { ProjectStore } from './store.svelte';

	let { store }: { store: ProjectStore } = $props();

	const canMerge = $derived(has(PERM.projectManage));
	const canCreate = $derived(has(PERM.taskCreate));
	let syncing = $state(false);
	let merging = $state<number | null>(null);
	let confirmOpen = $state(false);
	let pending = $state<{ pr: PullRequestDto; method: MergeMethod } | null>(null);
	let agentOpen = $state(false);
	let agentPr = $state<PullRequestDto | null>(null);

	const METHODS: { value: MergeMethod; label: string; hint: string }[] = [
		{ value: 'squash', label: 'Squash & Merge', hint: 'alle Commits zu einem zusammenfassen' },
		{ value: 'merge', label: 'Merge-Commit', hint: 'Commits behalten, Merge-Commit anlegen' },
		{
			value: 'rebase',
			label: 'Rebase & Merge',
			hint: 'Commits einzeln auf den Haupt-Branch setzen'
		}
	];

	onMount(() => {
		if (!store.pullsLoaded) void store.loadPulls();
	});

	const sorted = $derived(
		[...store.pulls].sort(
			(a, b) =>
				Number(b.state === 'open') - Number(a.state === 'open') ||
				b.updatedAt.localeCompare(a.updatedAt)
		)
	);

	async function sync() {
		syncing = true;
		try {
			store.setPulls(await syncPulls(store.id));
			toast.success('Pull Requests synchronisiert');
		} catch (e) {
			toast.error(errMsg(e, 'Synchronisieren fehlgeschlagen'));
		} finally {
			syncing = false;
		}
	}

	function askAgent(pr: PullRequestDto) {
		agentPr = pr;
		agentOpen = true;
	}

	function askMerge(pr: PullRequestDto, method: MergeMethod) {
		pending = { pr, method };
		confirmOpen = true;
	}

	async function merge() {
		if (!pending) return;
		const { pr, method } = pending;
		merging = pr.number;
		try {
			store.upsertPull(await mergePull(store.id, pr.number, method));
			toast.success(`#${pr.number} gemergt`);
		} catch (e) {
			toast.error(errMsg(e, 'Mergen fehlgeschlagen'));
		} finally {
			merging = null;
		}
	}

	function checksTone(checks: string): BadgeTone {
		const c = checks.toLowerCase();
		if (!c) return 'outline';
		if (/fail|error|cancel/.test(c)) return 'destructive';
		if (/pend|progress|queued|wait|expected/.test(c)) return 'warning';
		if (/success|pass|ok|green/.test(c)) return 'success';
		return 'outline';
	}
	function checksLabel(checks: string): string {
		const c = checks.toLowerCase();
		if (!c) return 'keine';
		if (/fail|error/.test(c)) return 'fehlgeschlagen';
		if (/cancel/.test(c)) return 'abgebrochen';
		if (/pend|progress|queued|wait|expected/.test(c)) return 'laufen';
		if (/success|pass/.test(c)) return 'grün';
		return checks;
	}
	const stateTone = (s: PullRequestDto['state']): BadgeTone =>
		s === 'open' ? 'info' : s === 'merged' ? 'success' : 'outline';
</script>

<DataTable
	caption="Pull Requests"
	mobile="cards"
	loading={store.pullsLoading && !store.pullsLoaded}
	error={store.pullsLoaded ? '' : store.pullsError}
	onretry={() => store.loadPulls()}
	empty={!sorted.length}
	emptyTitle="Noch keine Pull Requests"
	emptyDescription="Sobald ein Agent einen Auftrag abschließt, öffnet er hier einen Pull Request. „Synchronisieren“ holt den Stand von GitHub."
>
	{#snippet toolbar()}
		<div class="flex w-full flex-wrap items-center justify-between gap-2">
			<span class="text-sm text-muted-foreground">
				{sorted.filter((p) => p.state === 'open').length} offen
			</span>
			<Button variant="outline" size="sm" class="max-sm:h-10" onclick={sync} disabled={syncing}>
				<RefreshCw class={syncing ? 'animate-spin' : ''} />
				{syncing ? 'Synchronisiert …' : 'Synchronisieren'}
			</Button>
		</div>
	{/snippet}
	{#snippet head()}
		<Table.Row>
			<Table.Head class="w-16">Nr.</Table.Head>
			<Table.Head>Titel</Table.Head>
			<Table.Head>Status</Table.Head>
			<Table.Head>Checks</Table.Head>
			<Table.Head class="text-right">Änderungen</Table.Head>
			<Table.Head>Aktualisiert</Table.Head>
			<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
		</Table.Row>
	{/snippet}
	{#each sorted as pr (pr.number)}
		<Table.Row>
			<Table.Cell class="font-mono text-xs text-muted-foreground">#{pr.number}</Table.Cell>
			<Table.Cell class="max-w-md min-w-0 2xl:max-w-2xl">
				<div class="truncate font-medium" title={pr.title}>{pr.title}</div>
				<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<span class="max-w-full min-w-0 truncate font-mono" title={pr.branch}>{pr.branch}</span>
					{#if pr.taskId}
						<a href={taskPath(store.id, pr.taskId)} class="text-link hover:underline">Auftrag</a>
					{/if}
				</div>
			</Table.Cell>
			<Table.Cell>
				<div class="flex flex-wrap gap-1">
					<Badge variant={stateTone(pr.state)}>{PR_STATE_LABELS[pr.state]}</Badge>
					{#if pr.isDraft}<Badge variant="outline">Entwurf</Badge>{/if}
					{#if pr.autoMerge && pr.state === 'open'}<Badge variant="secondary">Auto-Merge</Badge
						>{/if}
					{#if pr.state === 'open' && /conflict/i.test(pr.mergeable)}
						<Badge variant="destructive">Konflikt</Badge>
					{/if}
				</div>
			</Table.Cell>
			<Table.Cell>
				<Badge variant={checksTone(pr.checks)}>{checksLabel(pr.checks)}</Badge>
			</Table.Cell>
			<Table.Cell class="text-right font-mono text-xs tabular-nums whitespace-nowrap">
				<span class="text-success">+{pr.additions}</span>
				<span class="text-destructive">−{pr.deletions}</span>
			</Table.Cell>
			<Table.Cell class="text-xs text-muted-foreground"><TimeAgo value={pr.updatedAt} /></Table.Cell
			>
			<Table.Cell class="text-right">
				<div class="flex flex-wrap justify-end gap-1">
					<Button
						variant="ghost"
						size="icon-sm"
						class="max-sm:size-10"
						href={pr.url}
						target="_blank"
						rel="noopener noreferrer"
						aria-label={`#${pr.number} auf GitHub öffnen`}
						title="Auf GitHub öffnen"><ExternalLink /></Button
					>
					{#if canCreate && pr.state === 'open'}
						<Button
							variant="ghost"
							size="icon-sm"
							class="max-sm:size-10"
							onclick={() => askAgent(pr)}
							aria-label={`#${pr.number} mit Agent bearbeiten`}
							title="Mit Agent bearbeiten"><Bot /></Button
						>
					{/if}
					{#if canMerge && pr.state === 'open'}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										size="sm"
										class="max-sm:h-10"
										variant="outline"
										disabled={merging === pr.number || pr.isDraft}
									>
										<GitMerge />
										{merging === pr.number ? 'Mergt …' : 'Mergen'}
										<ChevronDown />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end" class="w-64">
								{#each METHODS as m (m.value)}
									<DropdownMenu.Item
										onclick={() => askMerge(pr, m.value)}
										class="flex-col items-start"
									>
										<span>{m.label}</span>
										<span class="text-xs text-muted-foreground">{m.hint}</span>
									</DropdownMenu.Item>
								{/each}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
				</div>
			</Table.Cell>
		</Table.Row>
	{/each}
</DataTable>

<ConfirmDialog
	bind:open={confirmOpen}
	title={pending ? `#${pending.pr.number} mergen?` : 'Mergen?'}
	description={pending
		? `„${pending.pr.title}“ wird per ${METHODS.find((m) => m.value === pending?.method)?.label ?? pending.method} in den Haupt-Branch übernommen. Das lässt sich nur über GitHub rückgängig machen.`
		: ''}
	confirmLabel="Mergen"
	onconfirm={merge}
/>

<PrTaskDialog bind:open={agentOpen} projectId={store.id} pr={agentPr} />
