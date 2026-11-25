<script lang="ts">
	// Chat-Eingabe: Modus (Automatisch · Auftrag · Frage · Notiz) mit Live-Erkennung, einklappbare Optionen und
	// Senden-Button neben dem Textfeld (mobil mit dem Daumen erreichbar)
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Send from '@lucide/svelte/icons/send';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import { BUSY_SEND } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { cn } from '$lib/utils';
	import { classifyChatIntent } from '../../intent';
	import { PROVIDERS, ROLES, type Provider, type Role } from '../../protocol';
	import { PROVIDER_LABELS, ROLE_LABELS } from '../../schemas';
	import { postChat } from '../api';
	import { errMsg } from '../format';
	import type { ProjectStore } from './store.svelte';

	type Mode = 'auto' | 'task' | 'question' | 'note';

	let { store, onsent }: { store: ProjectStore; onsent?: () => void } = $props();

	const MODE_KEY = 'aidev.chat.mode';
	const OPTIONS_KEY = 'aidev.chat.options';
	const MODES: { v: Mode; l: string }[] = [
		{ v: 'auto', l: 'Automatisch' },
		{ v: 'task', l: 'Auftrag' },
		{ v: 'question', l: 'Frage' },
		{ v: 'note', l: 'Notiz' }
	];
	const SENT_LABEL = {
		task: 'Als Auftrag angelegt',
		question: 'Als Frage gesendet',
		note: 'Als Notiz gespeichert'
	} as const;

	let body = $state('');
	let mode = $state<Mode>('auto');
	let role = $state<Role>('implement');
	let decompose = $state(false);
	let delivery = $state<'project' | 'branch'>('project');
	let providerHint = $state<Provider | null>(null);
	let busy = $state(false);
	/** Optionsleiste sichtbar (Desktop standardmäßig offen, mobil eingeklappt) */
	let optionsOpen = $state(true);
	/** ab sm (≥ 640px): Tastatur-Hinweis im Placeholder */
	let wide = $state(true);
	/** ab lg (≥ 1024px): größeres Eingabefeld */
	let large = $state(false);

	const deliveryOptions = [
		{ value: 'project', label: 'Projektvorgabe' },
		{ value: 'branch', label: 'Branch bereitstellen (ohne PR)' }
	];
	const roleOptions = ROLES.filter((r) => r !== 'orchestrate').map((r) => ({
		value: r,
		label: ROLE_LABELS[r]
	}));
	const providerOptions = PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }));

	/** Live-Erkennung (der Server klassifiziert beim Senden verbindlich) */
	const detected = $derived(classifyChatIntent(body));
	const hasText = $derived(body.trim().length > 0);
	/** Modus, nach dem sich die Optionen richten */
	const effective = $derived<'task' | 'question' | 'note'>(mode === 'auto' ? detected.mode : mode);
	const hasOptions = $derived(effective !== 'note');

	const placeholder = $derived.by(() => {
		const base =
			effective === 'note'
				? 'Notiz für den Verlauf, Markdown möglich'
				: mode === 'auto'
					? 'Frage stellen oder Auftrag geben – Markdown möglich'
					: effective === 'question'
						? 'Was möchtest du wissen? Markdown möglich'
						: 'Was soll gebaut werden? Markdown möglich';
		return wide ? `${base} (Strg+Enter sendet)` : base;
	});

	onMount(() => {
		const sm = window.matchMedia('(min-width: 640px)');
		const lg = window.matchMedia('(min-width: 1024px)');
		const sync = () => {
			wide = sm.matches;
			large = lg.matches;
		};
		sync();
		try {
			const saved = localStorage.getItem(MODE_KEY);
			if (saved && MODES.some((m) => m.v === saved)) mode = saved as Mode;
			const opts = localStorage.getItem(OPTIONS_KEY);
			optionsOpen = opts === null ? sm.matches : opts === '1';
		} catch {
			optionsOpen = sm.matches;
		}
		sm.addEventListener('change', sync);
		lg.addEventListener('change', sync);
		return () => {
			sm.removeEventListener('change', sync);
			lg.removeEventListener('change', sync);
		};
	});

	function remember(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {
			// z. B. privater Modus – Einstellung gilt dann nur für diese Sitzung
		}
	}

	function setMode(m: Mode) {
		mode = m;
		remember(MODE_KEY, m);
	}

	function toggleOptions() {
		optionsOpen = !optionsOpen;
		remember(OPTIONS_KEY, optionsOpen ? '1' : '0');
	}

	async function send(e?: Event) {
		e?.preventDefault();
		const text = body.trim();
		if (!text || busy) return;
		busy = true;
		try {
			const res = await postChat(store.id, {
				body: text,
				mode,
				delivery,
				role,
				// im Auto-Modus entscheidet der Server; Aufteilen gilt dort nur, wenn es ein Auftrag wird
				decompose: effective === 'task' && decompose,
				providerHint: effective !== 'note' ? providerHint : null
			});
			store.addChat(res.message);
			if (res.task) store.upsertTask(res.task);
			body = '';
			if (mode === 'auto') toast.success(SENT_LABEL[res.mode] ?? 'Gesendet');
			onsent?.();
		} catch (err) {
			toast.error(errMsg(err, 'Nachricht konnte nicht gesendet werden'));
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		// Enter allein erzeugt einen Zeilenumbruch (auch mobil); Strg/Cmd+Enter sendet
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(e);
	}
</script>

<form
	class="space-y-2 border-t bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-3 sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
	onsubmit={send}
>
	<div class="flex min-w-0 items-center gap-2">
		<div class="min-w-0 flex-1 overflow-x-auto">
			<div class="inline-flex rounded-lg border p-0.5" role="group" aria-label="Modus">
				{#each MODES as o (o.v)}
					<button
						type="button"
						class={cn(
							'min-h-9 shrink-0 rounded-md sm:min-h-0 px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors',
							mode === o.v
								? 'bg-primary text-primary-foreground'
								: 'text-muted-foreground hover:text-foreground'
						)}
						aria-pressed={mode === o.v}
						onclick={() => setMode(o.v)}>{o.l}</button
					>
				{/each}
			</div>
		</div>
		{#if hasOptions}
			<Button
				type="button"
				variant="ghost"
				size="sm"
				class="h-9 shrink-0 sm:h-7"
				aria-expanded={optionsOpen}
				aria-controls="chat-options"
				onclick={toggleOptions}
			>
				<SlidersHorizontal />
				<span class="sr-only sm:not-sr-only">Optionen</span>
			</Button>
		{/if}
	</div>

	{#if mode === 'auto' && hasText}
		<button
			type="button"
			class="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			title="{detected.reason} – klicken, um als festen Modus zu übernehmen"
			aria-label="Erkannt: {detected.mode === 'question'
				? 'Frage'
				: 'Auftrag'} ({detected.reason}). Als festen Modus übernehmen"
			onclick={() => setMode(detected.mode)}
		>
			<Sparkles class="size-3.5 shrink-0" aria-hidden="true" />
			<span class="truncate"
				>Erkannt: <span class="font-medium text-foreground"
					>{detected.mode === 'question' ? 'Frage' : 'Auftrag'}</span
				>{#if detected.confidence === 'low'}&nbsp;(unsicher){/if}</span
			>
		</button>
	{/if}

	{#if hasOptions && optionsOpen}
		<div
			id="chat-options"
			class="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-x-3"
		>
			{#if effective === 'task'}
				<SelectField
					label="Rolle"
					options={roleOptions}
					value={role}
					onchange={(v) => v && (role = v as Role)}
					size="sm"
					class="w-full sm:w-36"
					disabled={busy || decompose}
				/>
				<SelectField
					label="Auslieferung"
					options={deliveryOptions}
					value={delivery}
					onchange={(v) => v && (delivery = v as 'project' | 'branch')}
					size="sm"
					class="w-full sm:w-64"
					disabled={busy}
				/>
			{/if}
			<SelectField
				label="Anbieter"
				options={providerOptions}
				emptyLabel="Anbieter: automatisch"
				value={providerHint}
				onchange={(v) => (providerHint = v as Provider | null)}
				size="sm"
				class="w-full sm:w-48"
				disabled={busy}
			/>
			{#if effective === 'task'}
				<label class="inline-flex min-h-8 items-center gap-2 text-sm">
					<Switch bind:checked={decompose} size="sm" disabled={busy} />
					Planen & aufteilen
				</label>
			{/if}
		</div>
	{/if}

	<div class="flex items-end gap-2">
		<Label for="chat-input" class="sr-only">Nachricht</Label>
		<Textarea
			id="chat-input"
			bind:value={body}
			rows={large ? 4 : 2}
			maxlength={20000}
			{placeholder}
			{onkeydown}
			disabled={busy}
			class="max-h-40 min-h-14 min-w-0 flex-1 resize-y sm:max-h-56 lg:max-h-[40dvh] lg:min-h-24"
		/>
		<Button
			type="submit"
			class="size-11 shrink-0 sm:h-10 sm:w-auto sm:px-3"
			disabled={busy || !hasText}
			aria-label={busy ? BUSY_SEND : 'Senden'}
		>
			<Send />
			<span class="hidden sm:inline">{busy ? BUSY_SEND : 'Senden'}</span>
		</Button>
	</div>

	{#if effective === 'question'}
		<p class="text-xs text-muted-foreground">
			Fragen werden lesend beantwortet.<span class="hidden sm:inline">
				Frühere Fragen und Antworten dienen als Kontext.</span
			>
		</p>
	{:else if effective === 'task' && optionsOpen}
		<p class="hidden text-xs text-muted-foreground sm:block">
			Branch bereitstellen pusht einen eigenen Branch ohne PR; der Hauptbranch bleibt unverändert.
			Leseaufträge liefern keine Änderungen aus.
		</p>
	{/if}
</form>
