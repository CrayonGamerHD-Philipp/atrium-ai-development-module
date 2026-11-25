<script lang="ts">
	// Projekt-Chat: Verlauf (neueste unten), Eingabe als Auftrag oder Notiz, Agent-Nachrichten verlinken den Auftrag
	import { onMount, tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Bot from '@lucide/svelte/icons/bot';
	import ExternalLink from '@lucide/svelte/icons/arrow-up-right';
	import Info from '@lucide/svelte/icons/info';
	import Send from '@lucide/svelte/icons/send';
	import { BUSY_SEND, ErrorState, LoadingState } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { cn } from '$lib/utils';
	import { PROVIDERS, ROLES, type Provider, type Role } from '../../protocol';
	import { PROVIDER_LABELS, ROLE_LABELS, type ChatMessageDto } from '../../schemas';
	import { postChat, taskPath } from '../api';
	import { errMsg, taskTitle } from '../format';
	import { has, PERM } from '../perms';
	import TimeAgo from '../components/TimeAgo.svelte';
	import StatusBadge from '../components/StatusBadge.svelte';
	import type { ProjectStore } from './store.svelte';

	let { store }: { store: ProjectStore } = $props();

	const canWrite = $derived(has(PERM.taskCreate));

	let body = $state('');
	let mode = $state<'task' | 'note'>('task');
	let role = $state<Role>('implement');
	let decompose = $state(false);
	let delivery = $state<'project' | 'branch'>('project');
	let providerHint = $state<Provider | null>(null);
	let busy = $state(false);
	let scroller = $state<HTMLElement | null>(null);
	let stick = true;

	const deliveryOptions = [
		{ value: 'project', label: 'Projektvorgabe' },
		{ value: 'branch', label: 'Branch bereitstellen (ohne PR)' }
	];
	const roleOptions = ROLES.filter((r) => r !== 'orchestrate').map((r) => ({
		value: r,
		label: ROLE_LABELS[r]
	}));
	const providerOptions = PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }));
	const tasksById = $derived(new Map(store.tasks.map((t) => [t.id, t])));

	onMount(() => {
		if (!store.chatLoaded) void store.loadChat().then(scrollToEnd);
		else void scrollToEnd();
	});

	// Neue Nachrichten: unten bleiben, wenn man unten war
	$effect(() => {
		void store.chat.length;
		if (stick) void scrollToEnd();
	});

	async function scrollToEnd() {
		await tick();
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	}

	function onscroll() {
		if (!scroller) return;
		stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
	}

	async function loadOlder() {
		if (!scroller) return void store.loadOlderChat();
		const before = scroller.scrollHeight;
		await store.loadOlderChat();
		await tick();
		scroller.scrollTop += scroller.scrollHeight - before;
	}

	async function send(e?: Event) {
		e?.preventDefault();
		const text = body.trim();
		if (!text) return;
		busy = true;
		try {
			const res = await postChat(store.id, {
				body: text,
				mode,
				delivery,
				role,
				decompose: mode === 'task' && decompose,
				providerHint: mode === 'task' ? providerHint : null
			});
			store.addChat(res.message);
			if (res.task) store.upsertTask(res.task);
			body = '';
			stick = true;
			void scrollToEnd();
		} catch (err) {
			toast.error(errMsg(err, 'Nachricht konnte nicht gesendet werden'));
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(e);
	}

	/** Gleicher Tag wie die vorige Nachricht? (für Tagestrenner) */
	function dayKey(m: ChatMessageDto) {
		return m.createdAt.slice(0, 10);
	}
	function dayLabel(iso: string) {
		return new Date(iso).toLocaleDateString('de-DE', {
			weekday: 'long',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric'
		});
	}
</script>

<div
	class="flex h-[calc(100dvh-16rem)] min-h-[28rem] flex-col overflow-hidden rounded-lg border bg-card"
>
	<div
		bind:this={scroller}
		{onscroll}
		class="flex-1 space-y-3 overflow-y-auto p-3 sm:p-4"
		aria-live="polite"
		aria-label="Chatverlauf"
		role="log"
	>
		{#if store.chatLoading && !store.chatLoaded}
			<LoadingState rows={4} rowClass="h-12 w-3/4" label="Chat" />
		{:else if store.chatError && !store.chatLoaded}
			<ErrorState message={store.chatError} onretry={() => store.loadChat()} />
		{:else}
			{#if store.chatHasMore}
				<div class="text-center">
					<Button variant="ghost" size="sm" onclick={loadOlder} disabled={store.chatLoading}>
						Ältere Nachrichten laden
					</Button>
				</div>
			{/if}
			{#if !store.chat.length}
				<div class="flex h-full flex-col items-center justify-center gap-2 py-12 text-center">
					<Bot class="size-8 text-muted-foreground" aria-hidden="true" />
					<p class="font-medium">Noch keine Nachrichten</p>
					<p class="max-w-sm text-sm text-muted-foreground">
						Schreib einfach, was gebaut werden soll. Jede Nachricht im Modus „Auftrag“ wird ein
						Auftrag für einen Agent; Antworten der Agents erscheinen hier.
					</p>
				</div>
			{/if}
			{#each store.chat as m, i (m.id)}
				{@const task = m.taskId ? tasksById.get(m.taskId) : undefined}
				{#if i === 0 || dayKey(store.chat[i - 1]!) !== dayKey(m)}
					<div class="flex items-center gap-2 py-1 text-xs text-muted-foreground">
						<span class="h-px flex-1 bg-border"></span>{dayLabel(m.createdAt)}<span
							class="h-px flex-1 bg-border"
						></span>
					</div>
				{/if}
				{#if m.kind === 'system'}
					<div
						class="flex items-start justify-center gap-1.5 text-center text-xs text-muted-foreground"
					>
						<Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						<span class="whitespace-pre-wrap">{m.body}</span>
						<TimeAgo value={m.createdAt} class="shrink-0" />
					</div>
				{:else}
					<article class={cn('flex gap-2', m.kind === 'user' && 'flex-row-reverse')}>
						<div
							class={cn(
								'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium',
								m.kind === 'agent' ? 'bg-info-muted text-info' : 'bg-muted text-muted-foreground'
							)}
							aria-hidden="true"
						>
							{#if m.kind === 'agent'}<Bot class="size-4" />{:else}{(m.author?.name ?? '?')
									.slice(0, 1)
									.toUpperCase()}{/if}
						</div>
						<div
							class={cn(
								'max-w-[85%] min-w-0 rounded-lg px-3 py-2 sm:max-w-[75%]',
								m.kind === 'user' ? 'bg-muted' : 'border bg-background'
							)}
						>
							<div
								class={cn(
									'mb-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground',
									m.kind === 'user' && 'justify-end'
								)}
							>
								<span class="font-medium text-foreground"
									>{m.kind === 'agent' ? 'Agent' : (m.author?.name ?? 'Unbekannt')}</span
								>
								<TimeAgo value={m.createdAt} />
							</div>
							<p class="text-sm break-words whitespace-pre-wrap">{m.body}</p>
							{#if m.taskId}
								<a
									href={taskPath(store.id, m.taskId)}
									class="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs hover:bg-muted"
								>
									<ExternalLink class="size-3.5 shrink-0" aria-hidden="true" />
									<span class="truncate">{task ? taskTitle(task) : 'Zum Auftrag'}</span>
									{#if task}<StatusBadge status={task.status} />{/if}
								</a>
							{/if}
						</div>
					</article>
				{/if}
			{/each}
		{/if}
	</div>

	{#if canWrite}
		<form class="space-y-2 border-t bg-background p-2 sm:p-3" onsubmit={send}>
			<Label for="chat-input" class="sr-only">Nachricht</Label>
			<Textarea
				id="chat-input"
				bind:value={body}
				rows={2}
				maxlength={20000}
				placeholder={mode === 'task'
					? 'Was soll gebaut werden? (Strg+Enter sendet)'
					: 'Notiz für den Verlauf (Strg+Enter sendet)'}
				{onkeydown}
				disabled={busy}
				class="max-h-48 min-h-14 resize-y"
			/>
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
				<div class="inline-flex rounded-lg border p-0.5" role="group" aria-label="Modus">
					{#each [{ v: 'task', l: 'Auftrag' }, { v: 'note', l: 'Notiz' }] as o (o.v)}
						<button
							type="button"
							class={cn(
								'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
								mode === o.v
									? 'bg-primary text-primary-foreground'
									: 'text-muted-foreground hover:text-foreground'
							)}
							aria-pressed={mode === o.v}
							onclick={() => (mode = o.v as 'task' | 'note')}>{o.l}</button
						>
					{/each}
				</div>
				{#if mode === 'task'}
					<SelectField
						label="Rolle"
						options={roleOptions}
						value={role}
						onchange={(v) => v && (role = v as Role)}
						size="sm"
						class="w-36"
						disabled={busy || decompose}
					/>
					<SelectField
						label="Auslieferung"
						options={deliveryOptions}
						value={delivery}
						onchange={(v) => v && (delivery = v as 'project' | 'branch')}
						size="sm"
						class="w-64"
						disabled={busy}
					/>
					<label class="inline-flex items-center gap-2 text-sm">
						<Switch bind:checked={decompose} size="sm" disabled={busy} />
						Planen & aufteilen
					</label>
					<SelectField
						label="Anbieter"
						options={providerOptions}
						emptyLabel="Anbieter: automatisch"
						value={providerHint}
						onchange={(v) => (providerHint = v as Provider | null)}
						size="sm"
						class="w-48"
						disabled={busy}
					/>
				{/if}
				<Button type="submit" size="sm" class="ml-auto" disabled={busy || !body.trim()}>
					<Send />
					{busy ? BUSY_SEND : 'Senden'}
				</Button>
			</div>
			{#if mode === 'task'}<p class="text-xs text-muted-foreground">
					Branch bereitstellen pusht einen eigenen Branch ohne PR; der Hauptbranch bleibt
					unverändert. Leseaufträge liefern keine Änderungen aus.
				</p>{/if}
		</form>
	{:else}
		<p class="border-t p-3 text-center text-xs text-muted-foreground">
			Nur Ansicht – zum Schreiben fehlt dir das Recht, Aufträge zu geben.
		</p>
	{/if}
</div>
