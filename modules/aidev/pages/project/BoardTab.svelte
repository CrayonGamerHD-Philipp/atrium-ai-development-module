<script lang="ts">
	// Auftragsboard: Spalten nach Status – mobil seitlich snap-scrollend, ab lg als Raster (3, ab 110rem 6 Spalten), Schnellerfassung oben
	import Plus from '@lucide/svelte/icons/plus';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import type { TaskDto, TaskStatus } from '../../schemas';
	import { taskTitle } from '../format';
	import { has, PERM } from '../perms';
	import NewTaskForm from './NewTaskForm.svelte';
	import type { ProjectStore } from './store.svelte';
	import TaskCard from './TaskCard.svelte';

	let { store }: { store: ProjectStore } = $props();

	const canCreate = $derived(has(PERM.taskCreate));
	let showChildren = $state(false);

	const COLUMNS: { key: string; label: string; statuses: TaskStatus[]; hint: string }[] = [
		{
			key: 'queued',
			label: 'Wartet',
			statuses: ['draft', 'queued', 'blocked'],
			hint: 'Entwürfe und eingeplante Aufträge'
		},
		{ key: 'running', label: 'Läuft', statuses: ['running'], hint: 'Ein Agent arbeitet daran' },
		{
			key: 'needs-input',
			label: 'Rückfrage',
			statuses: ['needs-input'],
			hint: 'Der Agent braucht eine Antwort'
		},
		{
			key: 'review',
			label: 'PR offen',
			statuses: ['review'],
			hint: 'Pull Request wartet auf Merge'
		},
		{ key: 'done', label: 'Fertig', statuses: ['done'], hint: 'Abgeschlossen' },
		{
			key: 'failed',
			label: 'Fehlgeschlagen',
			statuses: ['failed', 'cancelled'],
			hint: 'Fehlgeschlagen oder abgebrochen'
		}
	];

	const byParent = $derived.by(() => {
		const m = new Map<string, TaskDto[]>();
		for (const t of store.tasks) {
			if (!t.parentId) continue;
			const list = m.get(t.parentId) ?? [];
			list.push(t);
			m.set(t.parentId, list);
		}
		return m;
	});
	const titles = $derived(new Map(store.tasks.map((t) => [t.id, taskTitle(t)])));
	const hasChildren = $derived(store.tasks.some((t) => t.parentId));

	const STATUS_ORDER: Record<string, number> = { blocked: 2, queued: 1, draft: 3 };

	function columnTasks(statuses: TaskStatus[]): TaskDto[] {
		return store.tasks
			.filter((t) => statuses.includes(t.status) && (showChildren || !t.parentId))
			.sort((a, b) => {
				if (statuses.includes('queued'))
					return (
						(STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
						b.priority - a.priority ||
						a.createdAt.localeCompare(b.createdAt)
					);
				return b.updatedAt.localeCompare(a.updatedAt);
			});
	}

	const FINISHED_LIMIT = 30;
</script>

<div class="space-y-4">
	{#if canCreate}
		<NewTaskForm projectId={store.id} oncreated={(t) => store.upsertTask(t)} />
	{/if}

	{#if hasChildren}
		<div class="flex min-h-10 items-center gap-2">
			<Switch id="board-children" bind:checked={showChildren} size="sm" />
			<Label for="board-children" class="text-sm font-normal">Teilaufträge einzeln zeigen</Label>
		</div>
	{/if}

	{#if !store.tasks.length}
		<div class="rounded-lg border border-dashed p-8 text-center">
			<Plus class="mx-auto mb-2 size-6 text-muted-foreground" aria-hidden="true" />
			<p class="font-medium">Noch keine Aufträge</p>
			<p class="text-sm text-muted-foreground">
				{canCreate
					? 'Beschreibe oben, was ein Agent tun soll – oder nutze den Chat.'
					: 'Hier erscheinen die Aufträge dieses Projekts.'}
			</p>
		</div>
	{:else}
		<div
			class="-mx-4 flex scroll-px-4 snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-3 sm:mx-0 sm:scroll-px-0 sm:px-0 lg:grid lg:snap-none lg:grid-cols-3 lg:items-start lg:overflow-visible lg:pb-0 min-[110rem]:grid-cols-6"
			role="list"
			aria-label="Auftragsboard"
		>
			{#each COLUMNS as col (col.key)}
				{@const items = columnTasks(col.statuses)}
				{@const finished = col.key === 'done' || col.key === 'failed'}
				<section
					class="flex w-[min(17.5rem,calc(100vw-4rem))] min-w-0 shrink-0 snap-start flex-col rounded-lg bg-muted/50 p-2 lg:w-auto"
					role="listitem"
					aria-labelledby={`col-${col.key}`}
				>
					<header class="mb-2 flex items-center justify-between gap-2 px-1" title={col.hint}>
						<h3 id={`col-${col.key}`} class="truncate text-sm font-medium">{col.label}</h3>
						<span
							class="shrink-0 rounded-full bg-background px-2 text-xs text-muted-foreground tabular-nums"
						>
							{items.length}
						</span>
					</header>
					<ul class="flex min-h-16 flex-col gap-2">
						{#each finished ? items.slice(0, FINISHED_LIMIT) : items as t (t.id)}
							<li>
								<TaskCard
									task={t}
									children={byParent.get(t.id) ?? []}
									parentTitle={t.parentId ? (titles.get(t.parentId) ?? '') : ''}
								/>
							</li>
						{:else}
							<li class="px-1 py-3 text-center text-xs text-muted-foreground">Leer</li>
						{/each}
						{#if finished && items.length > FINISHED_LIMIT}
							<li class="px-1 text-center text-xs text-muted-foreground">
								+ {items.length - FINISHED_LIMIT} ältere
							</li>
						{/if}
					</ul>
				</section>
			{/each}
		</div>
	{/if}
</div>
