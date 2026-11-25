<script lang="ts">
	// Aktionsvorschläge eines Agents unter seiner Chat-Antwort: je Vorschlag eine kompakte Karte (Art, Titel bzw.
	// betroffener Auftrag, Optionen als Badges, aufklappbarer Text, Zustand) mit „Übernehmen“/„Verwerfen“. Ab zwei
	// offenen Vorschlägen zusätzlich „Alle übernehmen“ (nacheinander). Agent-Text nur über `Markdown` (kein {@html}).
	import { page } from '$app/state';
	import { SvelteSet } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import Ban from '@lucide/svelte/icons/ban';
	import Check from '@lucide/svelte/icons/check';
	import CheckCheck from '@lucide/svelte/icons/check-check';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import ExternalLink from '@lucide/svelte/icons/arrow-up-right';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import type { ChatActionDto, ChatMessageDto, TaskDto } from '../../../schemas';
	import { taskPath } from '../../api';
	import { errMsg, roleLabel, taskTitle } from '../../format';
	import { has, PERM } from '../../perms';
	import Markdown from '../../components/Markdown.svelte';
	import ProviderBadge from '../../components/ProviderBadge.svelte';
	import StatusBadge from '../../components/StatusBadge.svelte';
	import type { ProjectStore } from '../store.svelte';
	import {
		ACTION_KIND_LABELS,
		actionPrompt,
		actionTaskId,
		canApply,
		changedFields,
		pendingActions
	} from './proposals';

	let {
		store,
		message,
		tasksById
	}: { store: ProjectStore; message: ChatMessageDto; tasksById: Map<string, TaskDto> } = $props();

	const canCreate = $derived(has(PERM.taskCreate));
	const rights = $derived({
		canCreate,
		canManage: has(PERM.taskManage),
		userId: (page.data as { user?: { id?: string } | null }).user?.id ?? null
	});

	/** Indizes, deren Entscheidung gerade läuft */
	const busy = new SvelteSet<number>();
	let applyingAll = $state(false);

	/** Offene Vorschläge, die die Person übernehmen darf */
	const applicable = $derived(
		pendingActions(message.actions).filter((a) => canApply(a.action, taskOf(a), rights))
	);

	function taskOf(a: ChatActionDto): TaskDto | undefined {
		const id = actionTaskId(a);
		return id ? tasksById.get(id) : undefined;
	}

	/** Entscheidung senden; `true`, wenn der Vorschlag danach übernommen ist */
	async function decide(index: number, decision: 'apply' | 'reject'): Promise<boolean> {
		if (busy.has(index)) return false;
		busy.add(index);
		try {
			const res = await store.decideChatAction(message.id, index, decision);
			const after = res.message.actions.find((a) => a.index === index);
			if (decision === 'apply' && after?.state === 'failed') {
				toast.error(after.error ?? 'Vorschlag konnte nicht übernommen werden');
				return false;
			}
			return after?.state === 'applied';
		} catch (err) {
			toast.error(
				errMsg(
					err,
					decision === 'apply'
						? 'Vorschlag konnte nicht übernommen werden'
						: 'Vorschlag konnte nicht verworfen werden'
				)
			);
			return false;
		} finally {
			busy.delete(index);
		}
	}

	/** Alle offenen (erlaubten) Vorschläge nacheinander übernehmen – Reihenfolge wie vorgeschlagen */
	async function applyAll() {
		if (applyingAll) return;
		applyingAll = true;
		let ok = 0;
		const indices = applicable.map((a) => a.index);
		try {
			for (const index of indices) if (await decide(index, 'apply')) ok++;
		} finally {
			applyingAll = false;
		}
		if (ok === indices.length)
			toast.success(ok === 1 ? '1 Vorschlag übernommen' : `${ok} Vorschläge übernommen`);
		else if (ok > 0) toast.info(`${ok} von ${indices.length} Vorschlägen übernommen`);
	}

	const KIND_ICON = { create: Plus, update: Pencil, cancel: Ban } as const;
	const KIND_TONE = {
		create: 'bg-info-muted text-info',
		update: 'bg-muted text-foreground',
		cancel: 'bg-destructive/10 text-destructive'
	} as const;
	const FOCUS =
		'outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-0';
	const btn = 'h-9 max-lg:h-10 max-lg:min-w-10';
</script>

<section class="mt-1.5 w-full min-w-0 space-y-1.5" aria-label="Vorschläge des Agents">
	<ul class="space-y-1.5">
		{#each message.actions as a (a.index)}
			{@const action = a.action}
			{@const task = taskOf(a)}
			{@const targetId = actionTaskId(a)}
			{@const Icon = KIND_ICON[action.type]}
			{@const text = actionPrompt(action)}
			{@const fields = changedFields(action)}
			{@const loading = busy.has(a.index)}
			{@const allowed = canApply(action, task, rights)}
			<li
				class={cn(
					'min-w-0 rounded-xl border bg-card p-2.5 text-sm lg:bg-background',
					a.state !== 'pending' && 'bg-muted/40 lg:bg-muted/40'
				)}
			>
				<div class="flex min-w-0 items-start gap-2.5">
					<span
						class={cn(
							'flex size-7 shrink-0 items-center justify-center rounded-full',
							KIND_TONE[action.type]
						)}
						aria-hidden="true"
					>
						<Icon class="size-4" />
					</span>
					<div class="min-w-0 flex-1 space-y-1">
						<p class="text-xs text-muted-foreground">
							<span class="font-medium text-foreground">{ACTION_KIND_LABELS[action.type]}</span
							>{#if fields.length}<span> · {fields.join(', ')}</span>{/if}
						</p>
						{#if action.type === 'create'}
							<p class="font-medium break-words">{action.title}</p>
						{/if}
						{#if action.type !== 'create' || (a.state === 'applied' && targetId)}
							{#if targetId}
								<a
									href={taskPath(store.id, targetId)}
									class={cn(
										'inline-flex max-w-full min-h-8 items-center gap-1.5 rounded-md text-link underline-offset-2 hover:underline max-lg:min-h-10',
										action.type === 'create' ? 'text-xs' : 'font-medium',
										FOCUS
									)}
								>
									<span class="truncate"
										>{action.type === 'create'
											? 'Zum Auftrag'
											: task
												? taskTitle(task)
												: 'Unbekannter Auftrag'}</span
									>
									{#if task}<StatusBadge status={task.status} />{/if}
									<ExternalLink class="size-3.5 shrink-0" aria-hidden="true" />
								</a>
							{/if}
						{/if}
						{#if action.type === 'update' && action.title !== undefined}
							<p class="text-xs break-words text-muted-foreground">
								Neuer Titel: <span class="text-foreground">{action.title}</span>
							</p>
						{/if}
						{#if action.type === 'create' || (action.type === 'update' && (action.priority !== undefined || action.providerHint !== undefined))}
							<div class="flex flex-wrap items-center gap-1">
								{#if action.type === 'create'}
									<Badge variant="outline">{roleLabel(action.role)}</Badge>
									{#if action.decompose}<Badge variant="secondary">Planen & aufteilen</Badge>{/if}
									{#if action.targetPr}<Badge variant="outline">PR #{action.targetPr}</Badge>{/if}
								{:else if action.type === 'update' && action.priority !== undefined}
									<Badge variant="outline">Priorität {action.priority}</Badge>
								{/if}
								{#if action.providerHint}
									<ProviderBadge provider={action.providerHint} />
								{:else if action.type === 'update' && action.providerHint === null}
									<Badge variant="outline">Anbieter: automatisch</Badge>
								{/if}
							</div>
						{/if}
						{#if action.type !== 'create' && action.reason}
							<p class="text-xs break-words text-muted-foreground">Grund: {action.reason}</p>
						{/if}
					</div>
				</div>

				{#if text}
					<details class="group mt-1.5 min-w-0">
						<summary
							class={cn(
								'inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md text-xs text-muted-foreground select-none hover:text-foreground max-lg:min-h-10 [&::-webkit-details-marker]:hidden',
								FOCUS
							)}
						>
							<ChevronRight
								class="size-3.5 transition-transform group-open:rotate-90"
								aria-hidden="true"
							/>
							{action.type === 'update' ? 'Neuer Text' : 'Auftragstext'}
						</summary>
						<div class="mt-1 max-h-72 overflow-y-auto rounded-lg border bg-muted/30 px-2.5 py-2">
							<Markdown {text} class="text-sm" />
						</div>
					</details>
				{/if}

				<div class="mt-2 flex flex-wrap items-center gap-2 pl-[2.375rem] max-sm:pl-0">
					{#if a.state === 'pending'}
						{#if canCreate && allowed}
							<Button
								size="sm"
								class={btn}
								disabled={loading || applyingAll}
								aria-busy={loading}
								onclick={() => decide(a.index, 'apply')}
							>
								{#if loading}
									<LoaderCircle class="animate-spin" aria-hidden="true" />
								{:else}
									<Check aria-hidden="true" />
								{/if}
								Übernehmen
							</Button>
						{/if}
						{#if canCreate}
							<Button
								size="sm"
								variant="ghost"
								class={btn}
								disabled={loading || applyingAll}
								onclick={() => decide(a.index, 'reject')}
							>
								<X aria-hidden="true" />
								Verwerfen
							</Button>
						{/if}
						{#if !canCreate}
							<span class="text-xs text-muted-foreground">Offen</span>
						{:else if !allowed}
							<span class="text-xs text-muted-foreground"
								>Fremde Aufträge darf nur ändern, wer alle Aufträge verwalten darf.</span
							>
						{/if}
					{:else if a.state === 'applied'}
						<span class="inline-flex items-center gap-1 text-xs font-medium text-success">
							<Check class="size-3.5" aria-hidden="true" /> Übernommen
						</span>
					{:else if a.state === 'rejected'}
						<span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
							<X class="size-3.5" aria-hidden="true" /> Verworfen
						</span>
					{:else}
						<span
							class="inline-flex min-w-0 items-start gap-1 text-xs break-words text-destructive"
						>
							<CircleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
							<span class="min-w-0">Nicht übernommen{a.error ? `: ${a.error}` : ''}</span>
						</span>
					{/if}
				</div>
			</li>
		{/each}
	</ul>

	{#if canCreate && applicable.length >= 2}
		<Button
			size="sm"
			variant="outline"
			class={cn(btn, 'w-full sm:w-auto')}
			disabled={applyingAll || busy.size > 0}
			aria-busy={applyingAll}
			onclick={applyAll}
		>
			{#if applyingAll}
				<LoaderCircle class="animate-spin" aria-hidden="true" />
			{:else}
				<CheckCheck aria-hidden="true" />
			{/if}
			Alle übernehmen ({applicable.length})
		</Button>
	{/if}
</section>
