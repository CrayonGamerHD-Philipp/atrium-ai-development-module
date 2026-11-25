<script lang="ts">
	// Workspace (vollflächig): Dateibaum links, CodeMirror-Editor mit Reitern in der Mitte, xterm-Terminals unten
	// (größenveränderbar), Git-Status-Leiste. Ziel: Arbeitskopie `main` oder Worktree eines Laufs (`run:<id>`).
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import FileCode from '@lucide/svelte/icons/file-code';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import PanelBottom from '@lucide/svelte/icons/panel-bottom';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Save from '@lucide/svelte/icons/save';
	import X from '@lucide/svelte/icons/x';
	import { formatBytes } from '$lib/sdk/i18n';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { BUSY_SAVE, ConfirmDialog, deviceLayout, PageTitle } from '$lib/components/layout';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { SelectField } from '$lib/components/ui/select-field';
	import { cn } from '$lib/utils';
	import { MAX_FILE_BYTES, type FsEntry } from '../protocol';
	import type { ProjectDto, TaskDto } from '../schemas';
	import {
		getGitStatus,
		getProject,
		listTasks,
		projectPath,
		readFile,
		writeFile,
		type GitStatus
	} from './api';
	import { errMsg, isUnavailable, taskTitle } from './format';
	import { has, PERM } from './perms';
	import { EditorHost } from './workspace/editor';
	import FileTree from './workspace/FileTree.svelte';
	import TerminalPanel from './workspace/TerminalPanel.svelte';

	let { params }: ModulePageProps = $props();
	const projectId = $derived(params.id ?? '');

	const canFiles = $derived(has(PERM.files));
	const canTerminal = $derived(has(PERM.terminal));
	const phone = $derived(deviceLayout() === 'phone');

	let project = $state<ProjectDto | null>(null);
	let runTasks = $state<TaskDto[]>([]);
	let target = $state(untrack(() => page.url.searchParams.get('target') ?? 'main'));

	type OpenFile = {
		key: string;
		target: string;
		path: string;
		name: string;
		state: 'loading' | 'ready' | 'binary' | 'error';
		error: string;
		truncated: boolean;
		size: number;
		dirty: boolean;
		saving: boolean;
	};
	let tabs = $state<OpenFile[]>([]);
	let activeKey = $state<string | null>(null);
	const activeTab = $derived(tabs.find((t) => t.key === activeKey) ?? null);
	const dirtyCount = $derived(tabs.filter((t) => t.dirty).length);

	let editorEl = $state<HTMLElement | null>(null);
	let editorReady = $state(false);
	let dark = $state(false);
	let git = $state<GitStatus | null>(null);
	let gitError = $state('');
	let gitLoading = $state(false);
	let treeKey = $state(0);

	let showTerminal = $state(true);
	let termHeight = $state(280);
	let terminalPanel = $state<ReturnType<typeof TerminalPanel> | null>(null);
	let mobileView = $state<'files' | 'editor' | 'terminal'>('files');

	let closeAsk = $state<OpenFile | null>(null);
	let closeOpen = $state(false);

	const host = new EditorHost({
		onChange: (key) => {
			const t = tabs.find((x) => x.key === key);
			if (t && !t.dirty) t.dirty = true;
		},
		onSave: () => void save()
	});

	// ---------------------------------------------------------------- Ziele

	const runTargets = $derived(
		runTasks
			.filter((t) => t.lastRun && (t.lastRun.status === 'running' || t.branch))
			.sort((a, b) => (b.lastRun?.startedAt ?? '').localeCompare(a.lastRun?.startedAt ?? ''))
			.slice(0, 25)
	);
	const targetOptions = $derived([
		{ value: 'main', label: `Haupt-Arbeitskopie (${project?.defaultBranch ?? 'main'})` },
		...runTargets.map((t) => ({
			value: `run:${t.lastRun!.id}`,
			label: `${t.lastRun!.status === 'running' ? '● ' : ''}${taskTitle(t)} · Versuch ${t.lastRun!.attempt}`
		})),
		...(target !== 'main' && !runTargets.some((t) => `run:${t.lastRun!.id}` === target)
			? [{ value: target, label: `Lauf ${target.slice(4, 12)}` }]
			: [])
	]);
	function targetLabel(t: string): string {
		if (t === 'main') return project?.defaultBranch ?? 'main';
		const task = runTasks.find((x) => x.lastRun && `run:${x.lastRun.id}` === t);
		return task ? taskTitle(task).slice(0, 24) : `Lauf ${t.slice(4, 12)}`;
	}

	function setTarget(next: string | null) {
		if (!next || next === target) return;
		target = next;
		const url = new URL(page.url);
		if (next === 'main') url.searchParams.delete('target');
		else url.searchParams.set('target', next);
		void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}

	// ---------------------------------------------------------------- Laden

	onMount(() => {
		void getProject(projectId)
			.then((p) => (project = p))
			.catch(() => undefined);
		void listTasks(projectId, { status: 'all', limit: 200 })
			.then((t) => (runTasks = t))
			.catch(() => undefined);

		const root = document.documentElement;
		dark = root.classList.contains('dark');
		const mo = new MutationObserver(() => {
			const d = root.classList.contains('dark');
			if (d !== dark) {
				dark = d;
				host.setDark(d);
			}
		});
		mo.observe(root, { attributes: true, attributeFilter: ['class'] });

		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				void save();
			}
		};
		const onUnload = (e: BeforeUnloadEvent) => {
			if (tabs.some((t) => t.dirty)) e.preventDefault();
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('beforeunload', onUnload);
		return () => {
			mo.disconnect();
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('beforeunload', onUnload);
		};
	});

	let markReady: () => void = () => undefined;
	const editorLoaded = new Promise<void>((resolve) => (markReady = resolve));

	// Editor erst im Browser laden, sobald der Container da ist
	$effect(() => {
		const el = editorEl;
		if (!el || editorReady || !canFiles) return;
		void host
			.init(
				el,
				untrack(() => dark)
			)
			.then(() => {
				editorReady = true;
				markReady();
			})
			.catch((e) => toast.error(errMsg(e, 'Editor konnte nicht geladen werden')));
	});

	onDestroy(() => host.destroy());

	beforeNavigate((nav) => {
		if (nav.type === 'leave' || nav.to?.url.pathname === page.url.pathname) return;
		if (tabs.some((t) => t.dirty) && !confirm('Ungespeicherte Änderungen verwerfen?')) nav.cancel();
	});

	async function loadGit() {
		if (!canFiles) return;
		gitLoading = true;
		try {
			git = await getGitStatus(projectId, target);
			gitError = '';
		} catch (e) {
			git = null;
			gitError = isUnavailable(e) ? 'Kein Runner online' : errMsg(e, 'Git-Status nicht verfügbar');
		} finally {
			gitLoading = false;
		}
	}

	$effect(() => {
		void target;
		untrack(() => void loadGit());
	});

	const changed = $derived(new Set(git?.files.map((f) => f.path) ?? []));

	// Aktiven Reiter im Editor zeigen
	$effect(() => {
		const t = activeTab;
		if (!editorReady) return;
		untrack(() => {
			if (t && t.state === 'ready') host.show(t.key);
			else host.clear();
		});
	});

	// ---------------------------------------------------------------- Dateien

	async function openEntry(entry: FsEntry) {
		const key = `${target}::${entry.path}`;
		if (phone) mobileView = 'editor';
		if (tabs.some((t) => t.key === key)) {
			activeKey = key;
			return;
		}
		const tab: OpenFile = {
			key,
			target,
			path: entry.path,
			name: entry.name,
			state: 'loading',
			error: '',
			truncated: false,
			size: entry.size,
			dirty: false,
			saving: false
		};
		tabs = [...tabs, tab];
		activeKey = key;
		const t = tabs.find((x) => x.key === key)!;
		try {
			const file = await readFile(projectId, tab.target, tab.path);
			t.size = file.size;
			t.truncated = file.truncated;
			if (file.encoding === 'base64') t.state = 'binary';
			else if (file.truncated) t.state = 'binary';
			else {
				await editorLoaded;
				host.open(key, tab.path, file.content);
				t.state = 'ready';
				if (activeKey === key) host.show(key);
			}
		} catch (e) {
			t.state = 'error';
			t.error = errMsg(e, 'Datei konnte nicht geladen werden');
		}
	}

	async function save() {
		const t = activeTab;
		if (!t || t.state !== 'ready' || !t.dirty || t.saving) return;
		const content = host.content(t.key);
		if (content === null) return;
		if (new Blob([content]).size > MAX_FILE_BYTES) {
			toast.error(`Datei ist zu groß zum Speichern (max. ${formatBytes(MAX_FILE_BYTES)}).`);
			return;
		}
		t.saving = true;
		try {
			await writeFile(projectId, t.target, t.path, content);
			// Änderungen während des Speicherns bleiben „ungespeichert“
			if (host.content(t.key) === content) t.dirty = false;
			toast.success(`${t.name} gespeichert`);
			void loadGit();
		} catch (e) {
			toast.error(errMsg(e, 'Speichern fehlgeschlagen'));
		} finally {
			t.saving = false;
		}
	}

	function askClose(t: OpenFile) {
		if (t.dirty) {
			closeAsk = t;
			closeOpen = true;
		} else closeTab(t.key);
	}

	function closeTab(key: string) {
		const i = tabs.findIndex((t) => t.key === key);
		if (i < 0) return;
		host.close(key);
		tabs = tabs.filter((t) => t.key !== key);
		if (activeKey === key) activeKey = tabs[Math.min(i, tabs.length - 1)]?.key ?? null;
	}

	// ---------------------------------------------------------------- Terminal-Größe

	function startDrag(e: PointerEvent) {
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		const startY = e.clientY;
		const startH = termHeight;
		const max = Math.max(160, window.innerHeight - 220);
		const move = (ev: PointerEvent) => {
			termHeight = Math.min(Math.max(startH - (ev.clientY - startY), 120), max);
		};
		const up = () => {
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', up);
			terminalPanel?.refit();
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
	}

	function onHandleKey(e: KeyboardEvent) {
		if (e.key === 'ArrowUp') termHeight = Math.min(termHeight + 24, window.innerHeight - 220);
		else if (e.key === 'ArrowDown') termHeight = Math.max(termHeight - 24, 120);
		else return;
		e.preventDefault();
		terminalPanel?.refit();
	}

	const showFiles = $derived(canFiles && (!phone || mobileView === 'files'));
	const showEditor = $derived(canFiles && (!phone || mobileView === 'editor'));
	const showTerm = $derived(
		canTerminal && (phone ? mobileView === 'terminal' : showTerminal || !canFiles)
	);
</script>

<PageTitle title={project ? `Workspace – ${project.name}` : 'Workspace'} />

<div class="flex h-full min-h-0 flex-col bg-background">
	<!-- Kopf -->
	<header class="flex h-12 shrink-0 items-center gap-2 border-b px-2 sm:px-3">
		<a
			href={projectPath(projectId)}
			class="inline-flex shrink-0 items-center gap-1 text-sm text-link hover:underline"
			aria-label="Zurück zum Projekt"
		>
			<ArrowLeft class="size-4" />
			<span class="hidden max-w-40 truncate sm:inline">{project?.name ?? 'Projekt'}</span>
		</a>
		<span class="hidden text-sm text-muted-foreground sm:inline">/ Workspace</span>
		<SelectField
			label="Arbeitskopie"
			options={targetOptions}
			value={target}
			onchange={setTarget}
			size="sm"
			class="ml-1 min-w-0 flex-1 sm:w-72 sm:flex-none"
		/>
		<div class="ml-auto flex items-center gap-1">
			{#if canFiles && !phone}
				<Button
					size="sm"
					variant="outline"
					onclick={save}
					disabled={!activeTab?.dirty || activeTab.saving}
					title="Speichern (Strg+S)"
				>
					<Save />
					{activeTab?.saving ? BUSY_SAVE : 'Speichern'}
				</Button>
			{:else if canFiles && mobileView === 'editor'}
				<!-- Handy: kein Strg+S – Speichern als Symbolknopf im Kopf -->
				<Button
					size="icon"
					variant="outline"
					onclick={save}
					disabled={!activeTab?.dirty || activeTab.saving}
					aria-label={activeTab?.saving ? BUSY_SAVE : 'Speichern'}
					title="Speichern"
				>
					<Save />
				</Button>
			{/if}
			{#if canTerminal && canFiles && !phone}
				<Button
					size="icon-sm"
					variant={showTerminal ? 'secondary' : 'ghost'}
					onclick={() => {
						showTerminal = !showTerminal;
						if (showTerminal) setTimeout(() => terminalPanel?.refit(), 0);
					}}
					aria-pressed={showTerminal}
					aria-label="Terminal ein-/ausblenden"
					title="Terminal ein-/ausblenden"><PanelBottom /></Button
				>
			{/if}
		</div>
	</header>

	{#if phone}
		<div class="shrink-0 space-y-2 border-b p-2">
			<Alert.Root variant="info">
				<Alert.Description class="text-xs">
					Der Workspace ist für größere Bildschirme gedacht. Auf dem Handy wechselst du zwischen den
					Ansichten.
				</Alert.Description>
			</Alert.Root>
			<div
				class="grid auto-cols-fr grid-flow-col gap-1 rounded-lg border p-0.5"
				role="group"
				aria-label="Ansicht"
			>
				{#each [{ v: 'files', l: 'Dateien', ok: canFiles }, { v: 'editor', l: 'Editor', ok: canFiles }, { v: 'terminal', l: 'Terminal', ok: canTerminal }] as o (o.v)}
					{#if o.ok}
						<button
							type="button"
							class={cn(
								'min-h-10 rounded-md px-1 py-1.5 text-sm font-medium',
								mobileView === o.v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
							)}
							aria-pressed={mobileView === o.v}
							onclick={() => {
								mobileView = o.v as typeof mobileView;
								if (o.v === 'terminal') setTimeout(() => terminalPanel?.refit(), 0);
							}}>{o.l}</button
						>
					{/if}
				{/each}
			</div>
		</div>
	{/if}

	{#if !canFiles && !canTerminal}
		<div class="p-6">
			<Alert.Root variant="warning">
				<Alert.Title>Kein Zugriff</Alert.Title>
				<Alert.Description
					>Für den Workspace brauchst du das Recht für Dateien oder Terminal.</Alert.Description
				>
			</Alert.Root>
		</div>
	{:else}
		<div class="flex min-h-0 flex-1">
			<!-- Dateibaum -->
			{#if canFiles}
				<aside
					class={cn(
						'min-h-0 shrink-0 overflow-y-auto border-r bg-sidebar-surface',
						phone ? 'w-full' : 'w-56 lg:w-64 2xl:w-72',
						!showFiles && 'hidden'
					)}
					aria-label="Dateibaum"
				>
					<div
						class="flex h-8 items-center justify-between px-2 text-xs font-medium text-muted-foreground pointer-coarse:h-11"
					>
						<span>Dateien</span>
						<Button
							variant="ghost"
							size="icon-xs"
							class="pointer-coarse:size-10"
							onclick={() => {
								treeKey++;
								void loadGit();
							}}
							aria-label="Dateibaum neu laden"
							title="Neu laden"><RefreshCw /></Button
						>
					</div>
					<FileTree
						{projectId}
						{target}
						activePath={activeTab?.target === target ? activeTab.path : null}
						{changed}
						onopen={openEntry}
						reloadKey={treeKey}
					/>
				</aside>
			{/if}

			<!-- Editor + Terminal -->
			<div
				class={cn('flex min-w-0 flex-1 flex-col', phone && !showEditor && !showTerm && 'hidden')}
			>
				{#if canFiles}
					<section
						class={cn('flex min-h-0 flex-1 flex-col', !showEditor && 'hidden')}
						aria-label="Editor"
					>
						<div
							class="flex h-9 shrink-0 items-end overflow-x-auto border-b bg-muted/30 pointer-coarse:h-11"
							role="tablist"
							aria-label="Offene Dateien"
						>
							{#each tabs as t (t.key)}
								<div
									class={cn(
										'group flex h-8 max-w-56 shrink-0 items-center gap-1 border-r pr-1 pl-3 text-xs pointer-coarse:h-10',
										activeKey === t.key
											? 'bg-background text-foreground'
											: 'text-muted-foreground hover:bg-muted/60'
									)}
								>
									<button
										type="button"
										role="tab"
										aria-selected={activeKey === t.key}
										class="min-w-0 truncate"
										title={`${t.path}${t.target !== 'main' ? ` (${targetLabel(t.target)})` : ''}`}
										onclick={() => (activeKey = t.key)}
									>
										{t.name}{#if t.target !== target}<span class="text-muted-foreground">
												· {targetLabel(t.target)}</span
											>{/if}
									</button>
									<button
										type="button"
										class="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-muted pointer-coarse:size-8"
										aria-label={t.dirty
											? `${t.name} schließen (ungespeichert)`
											: `${t.name} schließen`}
										onclick={() => askClose(t)}
									>
										{#if t.dirty}
											<span
												class="size-2 rounded-full bg-foreground group-hover:hidden"
												title="Ungespeichert"
											></span>
											<X class="hidden size-3 group-hover:block" />
										{:else}
											<X class="size-3" />
										{/if}
									</button>
								</div>
							{/each}
						</div>
						<div class="relative min-h-0 flex-1">
							<div
								bind:this={editorEl}
								class={cn('absolute inset-0', activeTab?.state !== 'ready' && 'invisible')}
							></div>
							{#if !activeTab}
								<div
									class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center"
								>
									<FileCode class="size-7 text-muted-foreground" aria-hidden="true" />
									<p class="text-sm text-muted-foreground">
										{phone
											? 'Wähle unter „Dateien“ eine Datei. Speichern schreibt direkt in die Arbeitskopie des Runners.'
											: 'Wähle links eine Datei. Änderungen speicherst du mit Strg+S direkt in die Arbeitskopie des Runners.'}
									</p>
								</div>
							{:else if activeTab.state === 'loading'}
								<div
									class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground"
									role="status"
								>
									Lädt …
								</div>
							{:else if activeTab.state === 'binary'}
								<div class="absolute inset-0 flex items-center justify-center p-6">
									<Alert.Root variant="info" class="max-w-md">
										<Alert.Title>
											{activeTab.truncated ? 'Datei zu groß für den Editor' : 'Binärdatei'}
										</Alert.Title>
										<Alert.Description>
											„{activeTab.path}“ ({formatBytes(activeTab.size)}) lässt sich hier nicht
											bearbeiten.
											{activeTab.truncated
												? `Der Editor öffnet Dateien bis ${formatBytes(MAX_FILE_BYTES)}.`
												: 'Nutze das Terminal, um sie zu bearbeiten.'}
										</Alert.Description>
									</Alert.Root>
								</div>
							{:else if activeTab.state === 'error'}
								<div class="absolute inset-0 flex items-center justify-center p-6">
									<Alert.Root variant="destructive" class="max-w-md">
										<Alert.Title>Datei nicht geladen</Alert.Title>
										<Alert.Description>{activeTab.error}</Alert.Description>
									</Alert.Root>
								</div>
							{/if}
						</div>
					</section>
				{/if}

				{#if canTerminal}
					{#if canFiles && !phone && showTerminal}
						<button
							type="button"
							class="block h-1.5 w-full shrink-0 cursor-row-resize border-t bg-muted/40 hover:bg-muted focus-visible:bg-muted"
							aria-label="Terminalhöhe ändern (ziehen oder Pfeiltasten)"
							onpointerdown={startDrag}
							onkeydown={onHandleKey}
						></button>
					{/if}
					<section
						class={cn('min-h-0 border-t', !showTerm && 'hidden', (!canFiles || phone) && 'flex-1')}
						style={canFiles && !phone ? `height:${termHeight}px` : ''}
						aria-label="Terminal"
					>
						<TerminalPanel bind:this={terminalPanel} {projectId} {target} {dark} {targetLabel} />
					</section>
				{/if}
			</div>
		</div>

		<!-- Git-Status -->
		{#if canFiles}
			<footer
				class="flex h-7 shrink-0 items-center gap-3 overflow-x-auto border-t bg-muted/40 px-3 text-xs whitespace-nowrap text-muted-foreground pointer-coarse:h-10"
			>
				{#if git}
					<span class="inline-flex items-center gap-1 font-mono">
						<GitBranch class="size-3.5" aria-hidden="true" />{git.branch}
					</span>
					<span class="font-mono">{git.head.slice(0, 7)}</span>
					{#if git.ahead}<span
							class="inline-flex items-center gap-0.5"
							title="Commits vor dem Remote"><ArrowUp class="size-3" />{git.ahead}</span
						>{/if}
					{#if git.behind}<span
							class="inline-flex items-center gap-0.5"
							title="Commits hinter dem Remote"><ArrowDown class="size-3" />{git.behind}</span
						>{/if}
					<span class:text-warning={git.files.length > 0}>
						{git.files.length
							? `${git.files.length} geänderte ${git.files.length === 1 ? 'Datei' : 'Dateien'}`
							: 'Keine Änderungen'}
					</span>
				{:else if gitError}
					<span class="text-warning">{gitError}</span>
				{:else}
					<span>Git-Status lädt …</span>
				{/if}
				{#if dirtyCount}
					<span class="ml-auto">{dirtyCount} ungespeichert</span>
				{/if}
				<button
					type="button"
					class={cn(
						'inline-flex shrink-0 items-center gap-1 hover:text-foreground pointer-coarse:min-h-10 pointer-coarse:min-w-10 pointer-coarse:justify-center',
						!dirtyCount && 'ml-auto'
					)}
					onclick={loadGit}
					disabled={gitLoading}
					aria-label="Git-Status aktualisieren"
				>
					<RefreshCw class={cn('size-3', gitLoading && 'animate-spin')} />
				</button>
			</footer>
		{/if}
	{/if}
</div>

<ConfirmDialog
	bind:open={closeOpen}
	title="Änderungen verwerfen?"
	description={closeAsk ? `„${closeAsk.name}“ hat ungespeicherte Änderungen.` : ''}
	confirmLabel="Verwerfen"
	destructive
	onconfirm={() => {
		if (closeAsk) closeTab(closeAsk.key);
		closeAsk = null;
	}}
/>
