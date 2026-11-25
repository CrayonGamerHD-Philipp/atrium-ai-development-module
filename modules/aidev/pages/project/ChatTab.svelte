<script lang="ts">
	// Projekt-Chat: Verlauf (neueste unten, Nachrichten als Markdown, gruppiert nach Autor), Antwort-Indikator,
	// „Nach unten“-Knopf und Eingabe (ChatComposer). Mobil (< lg) als Vollbild mit eigener Kopfzeile, ab lg als Karte,
	// die genau bis zum Fensterrand reicht (kein doppeltes Scrollen).
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ExternalLink from '@lucide/svelte/icons/arrow-up-right';
	import Bot from '@lucide/svelte/icons/bot';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Info from '@lucide/svelte/icons/info';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import { taskPath } from '../api';
	import { absolute, taskTitle } from '../format';
	import { has, PERM } from '../perms';
	import LiveIndicator from '../components/LiveIndicator.svelte';
	import Markdown from '../components/Markdown.svelte';
	import StatusBadge from '../components/StatusBadge.svelte';
	import ChatComposer from './ChatComposer.svelte';
	import { activityFor, buildTimeline, clockTime } from './chat/timeline';
	import type { ProjectStore } from './store.svelte';

	let { store, onclose }: { store: ProjectStore; onclose?: () => void } = $props();

	const canWrite = $derived(has(PERM.taskCreate));
	/** Angemeldeter Benutzer – eigene Nachrichten rechts */
	const meId = $derived((page.data as { user?: { id?: string } | null }).user?.id ?? null);

	/** Beispiele für den leeren Chat: `text` wird in die Eingabe übernommen (zum Weiterschreiben) */
	const SUGGESTIONS = [
		{ label: 'Erkläre mir die Projektstruktur', text: 'Erkläre mir die Projektstruktur.' },
		{ label: 'Behebe den Fehler …', text: 'Behebe den Fehler: ' },
		{ label: 'Schreibe Tests für …', text: 'Schreibe Tests für ' },
		{ label: 'Was wurde zuletzt geändert?', text: 'Was wurde zuletzt im Repository geändert?' }
	];

	let root = $state<HTMLElement | null>(null);
	let scroller = $state<HTMLElement | null>(null);
	let composer = $state<ReturnType<typeof ChatComposer> | null>(null);
	let draft = $state('');
	/** Nutzer ist (fast) ganz unten → neue Nachrichten scrollen mit */
	let stick = $state(true);
	/** Letzte Nachricht, die beim Hochscrollen sichtbar war (für den Zähler neuer Nachrichten) */
	let seenId = $state<string | null>(null);

	/** ab lg (≥ 1024px): Karte statt Vollbild */
	let desktop = $state(true);
	/** Mobil: sichtbare Fläche ohne Bildschirmtastatur (visualViewport) */
	let vvHeight = $state<number | null>(null);
	let vvTop = $state(0);
	/** Desktop: Abstand der Karte vom Dokumentanfang (für die Höhe bis zum Fensterrand) */
	let cardTop = $state<number | null>(null);

	const tasksById = $derived(new Map(store.tasks.map((t) => [t.id, t])));
	const timeline = $derived(buildTimeline(store.chat));
	const activity = $derived(activityFor(store.chat, tasksById));
	const newCount = $derived.by(() => {
		if (stick || !seenId) return 0;
		const idx = store.chat.findIndex((m) => m.id === seenId);
		return idx < 0 ? 0 : store.chat.length - idx - 1;
	});

	const rootStyle = $derived(
		[
			vvHeight != null && `--chat-vvh:${vvHeight}px`,
			`--chat-vvtop:${vvTop}px`,
			cardTop != null && `--chat-lg-h:calc(100dvh - ${Math.round(cardTop)}px - 2rem)`
		]
			.filter(Boolean)
			.join(';')
	);

	onMount(() => {
		if (!store.chatLoaded) void store.loadChat().then(() => scrollToEnd());
		else void scrollToEnd();

		// Bildschirmtastatur: Höhe/Versatz der sichtbaren Fläche übernehmen, damit die Eingabe sichtbar bleibt
		const vv = window.visualViewport;
		const onVv = () => {
			// nur im Mobil-Vollbild nötig (am Desktop z. B. kein Neuzeichnen bei Pinch-Zoom)
			if (!vv || desktop) return;
			vvHeight = vv.height;
			vvTop = vv.offsetTop;
			if (stick) void scrollToEnd();
		};
		const mq = window.matchMedia('(min-width: 1024px)');
		const onMq = () => {
			desktop = mq.matches;
			onVv();
		};
		onMq();
		mq.addEventListener('change', onMq);
		vv?.addEventListener('resize', onVv);
		vv?.addEventListener('scroll', onVv);

		// Desktop: Höhe bis zum Fensterrand neu berechnen, wenn sich der Seitenkopf verschiebt
		const measure = () => {
			if (root) cardTop = root.getBoundingClientRect().top + window.scrollY;
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.documentElement);
		window.addEventListener('resize', measure);

		return () => {
			mq.removeEventListener('change', onMq);
			vv?.removeEventListener('resize', onVv);
			vv?.removeEventListener('scroll', onVv);
			ro.disconnect();
			window.removeEventListener('resize', measure);
		};
	});

	// Mobil-Vollbild: Seite dahinter nicht scrollen lassen und für Tastatur/Screenreader sperren (`inert`),
	// beim Verlassen/Unmount wiederherstellen
	$effect(() => {
		if (desktop || !root) return;
		const html = document.documentElement;
		const prev = { html: html.style.overflow, body: document.body.style.overflow };
		html.style.overflow = 'hidden';
		document.body.style.overflow = 'hidden';
		const inerted = inertOutside(root);
		// Fokus in den Dialog holen (der auslösende Reiter ist jetzt gesperrt): auf „Zurück“, nicht ins Textfeld
		// (sonst öffnet sich die Bildschirmtastatur)
		if (!root.contains(document.activeElement))
			root.querySelector<HTMLElement>('[data-chat-close]')?.focus({ preventScroll: true });
		return () => {
			html.style.overflow = prev.html;
			document.body.style.overflow = prev.body;
			for (const el of inerted) el.inert = false;
		};
	});

	/**
	 * Setzt alle Geschwister von `el` und seinen Vorfahren (bis `body`) auf `inert`. Ausgenommen sind Live-Regionen
	 * (Toasts) und bereits gesperrte Elemente. Später geöffnete Portale (Menü, Blatt) liegen danach im `body`
	 * und bleiben bedienbar. Rückgabe: geänderte Elemente zum Zurücksetzen.
	 */
	function inertOutside(el: HTMLElement): HTMLElement[] {
		const changed: HTMLElement[] = [];
		for (
			let node: HTMLElement | null = el;
			node && node !== document.body;
			node = node.parentElement
		) {
			for (const sib of node.parentElement?.children ?? []) {
				if (sib === node || !(sib instanceof HTMLElement) || sib.inert) continue;
				if (sib.matches('script, style, [aria-live]') || sib.querySelector('[data-sonner-toaster]'))
					continue;
				sib.inert = true;
				changed.push(sib);
			}
		}
		return changed;
	}

	function onkeydown(e: KeyboardEvent) {
		// Mobil-Vollbild: Escape schließt den Chat (nicht während der IME-Komposition)
		if (desktop || e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
		e.preventDefault();
		onclose?.();
	}

	// Neue Nachrichten/Indikator: unten bleiben, wenn man unten war
	$effect(() => {
		void store.chat.length;
		void activity?.kind;
		if (stick) void scrollToEnd();
	});

	async function scrollToEnd(smooth = false) {
		await tick();
		if (!scroller) return;
		scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
	}

	function onscroll() {
		if (!scroller) return;
		const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
		if (atEnd === stick) return;
		stick = atEnd;
		seenId = atEnd ? null : (store.chat.at(-1)?.id ?? null);
	}

	function jumpToEnd() {
		stick = true;
		seenId = null;
		void scrollToEnd(true);
	}

	async function loadOlder() {
		if (!scroller) return void store.loadOlderChat();
		const before = scroller.scrollHeight;
		await store.loadOlderChat();
		await tick();
		scroller.scrollTop += scroller.scrollHeight - before;
	}

	function onsent() {
		stick = true;
		seenId = null;
		void scrollToEnd();
	}

	async function suggest(text: string) {
		draft = text;
		await tick();
		composer?.focus();
	}

	const FOCUS =
		'outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-0';
</script>

<section
	bind:this={root}
	style={rootStyle}
	aria-label="Projekt-Chat"
	role={desktop ? undefined : 'dialog'}
	aria-modal={desktop ? undefined : 'true'}
	{onkeydown}
	class={cn(
		'flex flex-col overflow-hidden bg-background outline-none',
		// Mobil: Vollbild über Kopfzeile/Navigation (z-40), unter Dialogen/Popovers (z-50) und Toasts
		'max-lg:fixed max-lg:inset-x-0 max-lg:top-[var(--chat-vvtop,0px)] max-lg:z-[45] max-lg:h-[var(--chat-vvh,100dvh)]',
		// Desktop: Karte bis zum Fensterrand
		'lg:h-[var(--chat-lg-h,calc(100dvh-14rem))] lg:min-h-[28rem] lg:rounded-lg lg:border lg:bg-card'
	)}
>
	<!-- Mobile Kopfzeile -->
	<header
		class="flex shrink-0 items-center gap-2 border-b bg-background pt-[env(safe-area-inset-top)] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.25rem,env(safe-area-inset-left))] lg:hidden"
	>
		<Button
			variant="ghost"
			size="icon"
			class="size-10"
			data-chat-close
			aria-label="Zurück zum Projekt"
			title="Zurück zum Projekt"
			onclick={() => onclose?.()}
		>
			<ArrowLeft class="size-5" aria-hidden="true" />
		</Button>
		<div class="min-w-0 flex-1 py-2">
			<p class="truncate text-sm leading-tight font-medium">{store.project?.name ?? 'Projekt'}</p>
			<p class="text-xs leading-tight text-muted-foreground">Chat</p>
		</div>
		<LiveIndicator status={store.live.status} />
	</header>

	<div class="relative flex min-h-0 flex-1 flex-col">
		<div
			bind:this={scroller}
			{onscroll}
			class={cn(
				'min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] sm:px-4 lg:px-4',
				// Platz für den „Nach unten“-Knopf, damit er die letzte Zeile nicht verdeckt
				!stick && 'pb-16'
			)}
		>
			{#if store.chatLoading && !store.chatLoaded}
				<LoadingState rows={4} rowClass="h-12 w-3/4" label="Chat" />
			{:else if store.chatError && !store.chatLoaded}
				<ErrorState message={store.chatError} onretry={() => store.loadChat()} />
			{:else}
				{#if store.chatHasMore}
					<div class="pb-2 text-center">
						<Button
							variant="ghost"
							size="sm"
							class="max-lg:h-10"
							onclick={loadOlder}
							disabled={store.chatLoading}
						>
							Ältere Nachrichten laden
						</Button>
					</div>
				{/if}

				{#if !store.chat.length}
					<div
						class="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-3 py-8 text-center"
					>
						<div
							class="flex size-12 items-center justify-center rounded-full bg-info-muted text-info"
						>
							<Bot class="size-6" aria-hidden="true" />
						</div>
						<div class="space-y-1">
							<p class="font-medium">Womit kann ich helfen?</p>
							<p class="text-sm text-muted-foreground">
								Stell eine Frage oder gib einen Auftrag. Der Chat erkennt automatisch, was du
								meinst: Fragen werden direkt beantwortet, Aufträge übernimmt ein Agent.
							</p>
						</div>
						{#if canWrite}
							<ul class="flex w-full flex-col gap-2 pt-1" aria-label="Vorschläge">
								{#each SUGGESTIONS as s (s.label)}
									<li>
										<button
											type="button"
											class={cn(
												'flex min-h-10 w-full items-center rounded-lg border bg-card px-3 py-2 text-left text-sm hover:bg-muted',
												FOCUS
											)}
											onclick={() => suggest(s.text)}
										>
											{s.label}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}

				<!-- Nur die Nachrichten sind Live-Region (ohne Ladezustand, Vorschläge und Indikator); nur neue
				     Nachrichten ansagen, keine Textänderungen wie Status-Chips -->
				<div role="log" aria-live="polite" aria-relevant="additions" aria-label="Chatverlauf">
					{#each timeline as item (item.message.id)}
						{@const m = item.message}
						{@const task = m.taskId ? tasksById.get(m.taskId) : undefined}
						{@const own = m.kind === 'user' && (!meId || m.author?.id === meId)}
						{#if item.day}
							<div
								class="flex items-center gap-2 py-3 text-xs font-medium text-muted-foreground"
								role="separator"
								aria-label={item.day}
							>
								<span class="h-px flex-1 bg-border"></span>{item.day}<span
									class="h-px flex-1 bg-border"
								></span>
							</div>
						{/if}
						{#if m.kind === 'system'}
							<div class="flex justify-center py-1.5">
								<p
									class="inline-flex max-w-[90%] min-w-0 items-start gap-1.5 rounded-full bg-muted/60 px-3 py-1 text-center text-xs text-muted-foreground"
								>
									<Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
									<span class="min-w-0 break-words whitespace-pre-wrap">{m.body}</span>
									<time datetime={m.createdAt} title={absolute(m.createdAt)} class="shrink-0"
										>{clockTime(m.createdAt)}</time
									>
								</p>
							</div>
						{:else}
							<article
								class={cn(
									'flex min-w-0 gap-2',
									own && 'flex-row-reverse',
									item.first ? 'mt-3 first:mt-0' : 'mt-1'
								)}
								aria-label={`${m.kind === 'agent' ? 'Agent' : (m.author?.name ?? 'Unbekannt')}, ${absolute(m.createdAt)}`}
							>
								<!-- Avatar nur bei der ersten Nachricht der Gruppe, sonst Platzhalter für die Einrückung -->
								{#if own}
									<!-- eigene Nachrichten ohne Avatar -->
								{:else if item.first}
									<div
										class={cn(
											'flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium',
											m.kind === 'agent'
												? 'bg-info-muted text-info'
												: 'bg-muted text-muted-foreground'
										)}
										aria-hidden="true"
									>
										{#if m.kind === 'agent'}<Bot class="size-4" />{:else}{(m.author?.name ?? '?')
												.slice(0, 1)
												.toUpperCase()}{/if}
									</div>
								{:else}
									<div class="w-8 shrink-0" aria-hidden="true"></div>
								{/if}
								<div
									class={cn(
										'flex max-w-[88%] min-w-0 flex-col sm:max-w-[80%] lg:max-w-[min(80%,52rem)]',
										own && 'items-end'
									)}
								>
									{#if item.first}
										<div
											class={cn(
												'mb-1 flex flex-wrap items-baseline gap-x-2 px-1 text-xs text-muted-foreground',
												own && 'justify-end'
											)}
										>
											{#if !own}
												<span class="font-medium text-foreground"
													>{m.kind === 'agent' ? 'Agent' : (m.author?.name ?? 'Unbekannt')}</span
												>
											{/if}
											<time datetime={m.createdAt} title={absolute(m.createdAt)}
												>{clockTime(m.createdAt)}</time
											>
										</div>
									{/if}
									<div
										class={cn(
											'max-w-full min-w-0 rounded-2xl px-3 py-2 break-words',
											own
												? 'border border-primary/25 bg-primary/10 text-foreground'
												: m.kind === 'agent'
													? 'border bg-card lg:bg-background'
													: 'bg-muted',
											own ? !item.first && 'rounded-tr-md' : !item.first && 'rounded-tl-md',
											own ? !item.last && 'rounded-br-md' : !item.last && 'rounded-bl-md'
										)}
										title={item.first ? undefined : absolute(m.createdAt)}
									>
										<Markdown text={m.body} />
										{#if m.taskId}
											<a
												href={taskPath(store.id, m.taskId)}
												class={cn(
													'mt-2 inline-flex max-w-full min-h-8 items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs hover:bg-muted max-lg:min-h-10',
													FOCUS
												)}
											>
												<ExternalLink class="size-3.5 shrink-0" aria-hidden="true" />
												<span class="truncate">{task ? taskTitle(task) : 'Zum Auftrag'}</span>
												{#if task}<StatusBadge status={task.status} />{/if}
											</a>
										{/if}
									</div>
								</div>
							</article>
						{/if}
					{/each}
				</div>

				{#if activity}
					{#if activity.kind === 'needs-input'}
						<div
							class="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-warning-border bg-warning-muted px-3 py-2 text-sm text-warning"
							role="status"
						>
							<CircleHelp class="size-4 shrink-0" aria-hidden="true" />
							<span class="font-medium">Rückfrage – bitte antworten</span>
							<a
								href={taskPath(store.id, activity.task.id)}
								class={cn(
									'ml-auto inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-link underline-offset-2 hover:underline max-lg:min-h-10',
									FOCUS
								)}
							>
								Zum Auftrag <ExternalLink class="size-3.5" aria-hidden="true" />
							</a>
						</div>
					{:else}
						<div class="mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status">
							<div
								class="flex size-8 shrink-0 items-center justify-center rounded-full bg-info-muted text-info"
								aria-hidden="true"
							>
								<Bot class="size-4" />
							</div>
							<span
								class="inline-flex items-center gap-2 rounded-2xl rounded-tl-md border bg-card px-3 py-2 lg:bg-background"
							>
								<span>{activity.label}</span>
								{#if activity.task.status === 'running' || activity.task.status === 'queued'}
									<span class="inline-flex gap-0.5" aria-hidden="true">
										<span
											class="size-1 animate-bounce rounded-full bg-current [animation-delay:-0.3s]"
										></span>
										<span
											class="size-1 animate-bounce rounded-full bg-current [animation-delay:-0.15s]"
										></span>
										<span class="size-1 animate-bounce rounded-full bg-current"></span>
									</span>
								{/if}
							</span>
							<a
								href={taskPath(store.id, activity.task.id)}
								class={cn(
									'inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-link underline-offset-2 hover:underline max-lg:min-h-10',
									FOCUS
								)}
							>
								Auftrag ansehen <ExternalLink class="size-3.5" aria-hidden="true" />
							</a>
						</div>
					{/if}
				{/if}
			{/if}
		</div>

		{#if !stick}
			<div class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
				<Button
					variant="outline"
					class="pointer-events-auto h-10 rounded-full shadow-md"
					aria-label={newCount
						? `Nach unten – ${newCount} neue ${newCount === 1 ? 'Nachricht' : 'Nachrichten'}`
						: 'Nach unten'}
					onclick={jumpToEnd}
				>
					<ArrowDown aria-hidden="true" />
					{#if newCount}
						<span class="tabular-nums">{newCount} neu</span>
					{:else}
						<span class="max-sm:sr-only">Nach unten</span>
					{/if}
				</Button>
			</div>
		{/if}
	</div>

	{#if canWrite}
		<ChatComposer bind:this={composer} bind:body={draft} {store} {onsent} />
	{:else}
		<p
			class="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground"
		>
			Nur Ansicht – zum Schreiben fehlt dir das Recht, Aufträge zu geben.
		</p>
	{/if}
</section>
