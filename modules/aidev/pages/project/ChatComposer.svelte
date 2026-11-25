<script lang="ts">
	// Chat-Eingabe als eine kompakte Zeile: [Modus] [Optionen] [mitwachsendes Textfeld] [Senden].
	// Modus per Menü (mit Live-Erkennung im Auto-Modus), erweiterte Optionen im Popover (Desktop) bzw.
	// Blatt von unten (mobil); abweichende Optionen stehen als entfernbare Chips über der Eingabe.
	// Entwurf pro Projekt und Modus werden im Browser gemerkt.
	import { onMount, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import X from '@lucide/svelte/icons/x';
	import { BottomSheet, BUSY_SEND } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Label } from '$lib/components/ui/label';
	import * as Popover from '$lib/components/ui/popover';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { classifyChatIntent } from '../../intent';
	import { PROVIDERS, ROLES, type Provider, type Role } from '../../protocol';
	import { PROVIDER_LABELS, ROLE_LABELS } from '../../schemas';
	import { postChat } from '../api';
	import { errMsg } from '../format';
	import { CHAT_MODES, isChatMode, modeInfo, storage, type ChatMode } from './chat/modes';
	import type { ProjectStore } from './store.svelte';

	let {
		store,
		onsent,
		body = $bindable('')
	}: { store: ProjectStore; onsent?: () => void; body?: string } = $props();

	const MODE_KEY = 'aidev.chat.mode';
	const DRAFT_PREFIX = 'aidev.chat.draft.';
	const SENT_LABEL = {
		task: 'Als Auftrag angelegt',
		question: 'Als Frage gesendet',
		note: 'Als Notiz gespeichert'
	} as const;
	const DEFAULT_ROLE: Role = 'implement';

	let mode = $state<ChatMode>('auto');
	let role = $state<Role>(DEFAULT_ROLE);
	let decompose = $state(false);
	let delivery = $state<'project' | 'branch'>('project');
	let providerHint = $state<Provider | null>(null);
	let busy = $state(false);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let optionsOpen = $state(false);
	/** Browser ohne `field-sizing: content` → Höhe per JS anpassen */
	let manualGrow = $state(false);

	/** ab sm: eigener Optionen-Knopf (darunter steckt er im Modus-Menü) */
	const sm = new MediaQuery('(min-width: 640px)', true);
	/** ab lg: Optionen als Popover statt Blatt von unten */
	const lg = new MediaQuery('(min-width: 1024px)', true);
	/** Desktop mit feinem Zeiger: Enter sendet, Umschalt+Enter = Zeilenumbruch */
	const fine = new MediaQuery('(pointer: fine)', true);
	const enterSends = $derived(sm.current && fine.current);

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
	const active = $derived(modeInfo(mode));

	/** Vom Standard abweichende, im wirksamen Modus geltende Optionen (als Chips mit Zurücksetzen) */
	const chips = $derived.by(() => {
		const list: { key: string; label: string; reset: () => void }[] = [];
		if (effective === 'task') {
			if (decompose)
				list.push({
					key: 'decompose',
					label: 'Planen & aufteilen',
					reset: () => (decompose = false)
				});
			else if (role !== DEFAULT_ROLE)
				list.push({
					key: 'role',
					label: `Rolle: ${ROLE_LABELS[role]}`,
					reset: () => (role = DEFAULT_ROLE)
				});
			if (delivery !== 'project')
				list.push({
					key: 'delivery',
					label: 'Branch bereitstellen',
					reset: () => (delivery = 'project')
				});
		}
		if (effective !== 'note' && providerHint)
			list.push({
				key: 'provider',
				label: `Anbieter: ${PROVIDER_LABELS[providerHint]}`,
				reset: () => (providerHint = null)
			});
		return list;
	});
	const customized = $derived(chips.length > 0);
	const showAutoChip = $derived(mode === 'auto' && hasText);

	// --- Entwurf pro Projekt ------------------------------------------------------------
	const draftKey = $derived(DRAFT_PREFIX + store.id);
	/** Schlüssel, dessen Entwurf bereits geladen ist (vorher nichts speichern) */
	let loadedKey = $state<string | null>(null);
	$effect(() => {
		const key = draftKey;
		untrack(() => {
			const saved = storage.get(key);
			// beim ersten Laden gewinnt ein von außen gesetzter Text; beim Projektwechsel der Entwurf
			if (loadedKey === null) {
				if (saved && !body.trim()) body = saved;
			} else body = saved ?? '';
			loadedKey = key;
		});
	});
	$effect(() => {
		const key = draftKey;
		const text = body;
		if (loadedKey !== key) return;
		if (text.trim()) storage.set(key, text);
		else storage.remove(key);
	});

	// Fallback fürs Mitwachsen ohne `field-sizing` (Höhe begrenzt per CSS `max-h`)
	$effect(() => {
		void body;
		if (!manualGrow || !textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${textarea.scrollHeight + 2}px`;
	});

	onMount(() => {
		const saved = storage.get(MODE_KEY);
		if (isChatMode(saved)) mode = saved;
		manualGrow = !(typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content'));
	});

	/** Fokus ins Textfeld (z. B. nach „Antworten“ oder beim Öffnen des Vollbild-Chats) */
	export function focus() {
		textarea?.focus();
	}

	function setMode(m: string) {
		if (!isChatMode(m)) return;
		mode = m;
		storage.set(MODE_KEY, m);
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
			// Desktop: direkt weiterschreiben; mobil Tastatur schließen, damit die Antwort sichtbar ist
			if (enterSends) textarea?.focus();
			else textarea?.blur();
		} catch (err) {
			toast.error(errMsg(err, 'Nachricht konnte nicht gesendet werden'));
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		// keine Aktion während der IME-Komposition (z. B. japanische Eingabe)
		if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
		// Strg/Cmd+Enter sendet überall; Enter allein nur am Desktop (mobil = Zeilenumbruch)
		if (e.ctrlKey || e.metaKey || (enterSends && !e.shiftKey && !e.altKey)) void send(e);
	}

	function openOptions() {
		// erst nach dem Schließen des Menüs öffnen, damit der Fokus ins Blatt wandert
		setTimeout(() => (optionsOpen = true), 0);
	}

	const iconBtn =
		'relative size-11 shrink-0 rounded-full sm:size-10 focus-visible:ring-3 focus-visible:ring-ring/50';
</script>

{#snippet dot()}
	<span
		class="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-background"
		aria-hidden="true"
	></span>
{/snippet}

{#snippet optionsBody()}
	<div class="space-y-4">
		{#if effective === 'task'}
			<SelectField
				label="Rolle"
				options={roleOptions}
				value={role}
				onchange={(v) => v && (role = v as Role)}
				class="w-full"
				disabled={busy || decompose}
			/>
			<SelectField
				label="Auslieferung"
				options={deliveryOptions}
				value={delivery}
				onchange={(v) => v && (delivery = v as 'project' | 'branch')}
				class="w-full"
				disabled={busy}
			/>
		{/if}
		{#if hasOptions}
			<SelectField
				label="Anbieter"
				options={providerOptions}
				emptyLabel="Automatisch"
				value={providerHint}
				onchange={(v) => (providerHint = v as Provider | null)}
				class="w-full"
				disabled={busy}
			/>
		{/if}
		{#if effective === 'task'}
			<label class="flex min-h-10 items-center justify-between gap-3 text-sm">
				<span>
					<span class="font-medium">Planen & aufteilen</span>
					<span class="block text-xs text-muted-foreground"
						>Zerlegt den Auftrag zuerst in Teilaufgaben.</span
					>
				</span>
				<Switch bind:checked={decompose} disabled={busy} />
			</label>
			<p class="text-xs text-muted-foreground">
				„Branch bereitstellen“ pusht einen eigenen Branch ohne PR; der Hauptbranch bleibt
				unverändert. Leseaufträge liefern keine Änderungen aus.
			</p>
		{:else if effective === 'question'}
			<p class="text-xs text-muted-foreground">
				Fragen werden lesend beantwortet. Frühere Fragen und Antworten dienen als Kontext.
			</p>
		{:else}
			<p class="text-sm text-muted-foreground">Für Notizen gibt es keine Optionen.</p>
		{/if}
		{#if mode === 'auto'}
			<p class="text-xs text-muted-foreground">
				Gezeigt werden die Optionen für „{effective === 'question' ? 'Frage' : 'Auftrag'}“ – so wird
				deine Nachricht gerade erkannt.
			</p>
		{/if}
	</div>
{/snippet}

<form
	class="space-y-1.5 border-t bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-3 sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
	onsubmit={send}
	aria-label="Nachricht senden"
>
	{#if showAutoChip || chips.length > 0 || (enterSends && hasText)}
		<div class="flex min-w-0 flex-wrap items-center gap-1.5 px-1">
			{#if showAutoChip}
				<button
					type="button"
					class="inline-flex min-h-7 max-w-full items-center gap-1 rounded-full bg-info-muted px-2.5 text-xs text-info transition-colors outline-none hover:opacity-80 focus-visible:ring-3 focus-visible:ring-ring/50"
					title="{detected.reason} – antippen, um den Modus festzulegen"
					aria-label="Wird als {detected.mode === 'question'
						? 'Frage'
						: 'Auftrag'} erkannt{detected.confidence === 'low'
						? ' (unsicher)'
						: ''}. Als festen Modus übernehmen"
					onclick={() => setMode(detected.mode)}
				>
					<span class="truncate"
						>wird <span class="font-medium"
							>{detected.mode === 'question' ? 'Frage' : 'Auftrag'}</span
						>{#if detected.confidence === 'low'}<span class="opacity-75">
								· unsicher</span
							>{/if}</span
					>
				</button>
			{/if}
			{#each chips as c (c.key)}
				<span
					class="inline-flex min-h-7 max-w-full items-center gap-0.5 rounded-full border bg-muted/50 pl-2.5 text-xs"
				>
					<span class="truncate">{c.label}</span>
					<button
						type="button"
						class="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
						aria-label="{c.label} zurücksetzen"
						disabled={busy}
						onclick={c.reset}
					>
						<X class="size-3.5" aria-hidden="true" />
					</button>
				</span>
			{/each}
			{#if enterSends && hasText}
				<span
					class="ml-auto hidden text-[11px] text-muted-foreground/80 sm:inline"
					aria-hidden="true">Enter sendet · Umschalt+Enter neue Zeile</span
				>
			{/if}
		</div>
	{/if}

	<div class="flex items-end gap-1.5 sm:gap-2">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						type="button"
						variant="ghost"
						size="icon"
						class={iconBtn}
						aria-label="Modus: {active.label} – ändern"
						title="Modus: {active.label}"
					>
						<active.icon class="size-5" aria-hidden="true" />
						{#if customized && !sm.current}{@render dot()}{/if}
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" side="top" sideOffset={8} class="w-72">
				<DropdownMenu.Label class="text-xs text-muted-foreground"
					>Wie soll die Nachricht wirken?</DropdownMenu.Label
				>
				<DropdownMenu.RadioGroup value={mode} onValueChange={setMode}>
					{#each CHAT_MODES as m (m.value)}
						<DropdownMenu.RadioItem value={m.value} closeOnSelect class="min-h-11 items-start py-2">
							<m.icon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							<span class="flex min-w-0 flex-col">
								<span class="font-medium">{m.label}</span>
								<span class="text-xs text-muted-foreground">{m.hint}</span>
							</span>
						</DropdownMenu.RadioItem>
					{/each}
				</DropdownMenu.RadioGroup>
				{#if !sm.current && hasOptions}
					<DropdownMenu.Separator />
					<DropdownMenu.Item class="min-h-11" onSelect={openOptions}>
						<SlidersHorizontal class="size-4" aria-hidden="true" />
						<span class="flex-1">Optionen …</span>
						{#if customized}
							<span class="text-xs text-muted-foreground">{chips.length} geändert</span>
						{/if}
					</DropdownMenu.Item>
				{/if}
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		{#if sm.current && hasOptions}
			{#if lg.current}
				<Popover.Root bind:open={optionsOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								type="button"
								variant="ghost"
								size="icon"
								class={iconBtn}
								aria-label={customized ? 'Optionen (geändert)' : 'Optionen'}
								title="Optionen"
							>
								<SlidersHorizontal class="size-5" aria-hidden="true" />
								{#if customized}{@render dot()}{/if}
							</Button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content align="start" side="top" sideOffset={8} class="w-80 p-4">
						<p class="mb-3 text-sm font-medium">Optionen</p>
						{@render optionsBody()}
					</Popover.Content>
				</Popover.Root>
			{:else}
				<Button
					type="button"
					variant="ghost"
					size="icon"
					class={iconBtn}
					aria-label={customized ? 'Optionen (geändert)' : 'Optionen'}
					aria-haspopup="dialog"
					aria-expanded={optionsOpen}
					title="Optionen"
					onclick={() => (optionsOpen = true)}
				>
					<SlidersHorizontal class="size-5" aria-hidden="true" />
					{#if customized}{@render dot()}{/if}
				</Button>
			{/if}
		{/if}

		<Label for="chat-input" class="sr-only">Nachricht</Label>
		<Textarea
			id="chat-input"
			bind:ref={textarea}
			bind:value={body}
			rows={1}
			maxlength={20000}
			placeholder={active.placeholder}
			enterkeyhint={enterSends ? 'send' : 'enter'}
			aria-keyshortcuts={enterSends ? 'Enter Control+Enter Meta+Enter' : 'Control+Enter Meta+Enter'}
			readonly={busy}
			aria-busy={busy}
			{onkeydown}
			class="max-h-[40dvh] min-h-11 min-w-0 flex-1 resize-none overflow-y-auto rounded-3xl px-4 py-2.5 sm:min-h-10 sm:py-2"
		/>
		<Button
			type="submit"
			size="icon"
			class="size-11 shrink-0 rounded-full sm:size-10 focus-visible:ring-3 focus-visible:ring-ring/50"
			disabled={busy || !hasText}
			aria-label={busy ? BUSY_SEND : 'Senden'}
			title={enterSends ? 'Senden (Enter)' : 'Senden'}
		>
			{#if busy}
				<LoaderCircle class="size-5 animate-spin" aria-hidden="true" />
			{:else}
				<ArrowUp class="size-5" aria-hidden="true" />
			{/if}
		</Button>
	</div>
</form>

{#if !lg.current}
	<BottomSheet
		bind:open={optionsOpen}
		title="Optionen"
		description="Gilt für die nächste Nachricht"
	>
		<div class="px-5 pt-1">
			{@render optionsBody()}
		</div>
	</BottomSheet>
{/if}
