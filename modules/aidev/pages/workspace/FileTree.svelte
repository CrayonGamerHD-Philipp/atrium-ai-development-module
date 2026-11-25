<script lang="ts">
	// Dateibaum der Arbeitskopie: Ordner werden beim Aufklappen geladen (`GET /projects/:id/files?target=&path=`)
	import { untrack } from 'svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import File from '@lucide/svelte/icons/file';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Link2 from '@lucide/svelte/icons/link-2';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { cn } from '$lib/utils';
	import type { FsEntry } from '../../protocol';
	import { listFiles } from '../api';
	import { errMsg, isUnavailable } from '../format';

	let {
		projectId,
		target,
		activePath = null,
		changed = new Set<string>(),
		onopen,
		reloadKey = 0
	}: {
		projectId: string;
		target: string;
		activePath?: string | null;
		/** Pfade mit Git-Änderungen (Markierung) */
		changed?: Set<string>;
		onopen: (entry: FsEntry) => void;
		reloadKey?: number;
	} = $props();

	type DirState =
		{ entries: FsEntry[] } | { loading: true } | { error: string; unavailable: boolean };

	let dirs = $state<Record<string, DirState>>({});
	let expanded = $state<Record<string, boolean>>({});

	async function loadDir(path: string) {
		dirs[path] = { loading: true };
		try {
			const res = await listFiles(projectId, target, path);
			const entries = [...res.entries].sort(
				(a, b) =>
					Number(b.type === 'dir') - Number(a.type === 'dir') ||
					a.name.localeCompare(b.name, 'de', { numeric: true })
			);
			dirs[path] = { entries };
		} catch (e) {
			dirs[path] = {
				error: errMsg(e, 'Ordner konnte nicht geladen werden'),
				unavailable: isUnavailable(e)
			};
		}
	}

	// Neues Ziel oder Neuladen: Baum zurücksetzen, aufgeklappte Ordner neu laden
	$effect(() => {
		void target;
		void reloadKey;
		untrack(() => {
			const open = Object.keys(expanded).filter((k) => expanded[k]);
			dirs = {};
			void loadDir('');
			for (const p of open) void loadDir(p);
		});
	});

	function toggle(entry: FsEntry) {
		if (entry.type === 'dir') {
			const next = !expanded[entry.path];
			expanded[entry.path] = next;
			if (next && !dirs[entry.path]) void loadDir(entry.path);
		} else onopen(entry);
	}

	const hasChange = (path: string) => changed.has(path);
	const dirChanged = (path: string) => {
		const prefix = `${path}/`;
		for (const p of changed) if (p.startsWith(prefix)) return true;
		return false;
	};
</script>

{#snippet dir(path: string, depth: number)}
	{@const st = dirs[path]}
	{#if !st || 'loading' in st}
		<div
			class="flex items-center gap-1.5 py-1 text-xs text-muted-foreground"
			style={`padding-left:${depth * 12 + 8}px`}
		>
			<LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" /> Lädt …
		</div>
	{:else if 'error' in st}
		<div class="space-y-1 py-1 pr-2 text-xs" style={`padding-left:${depth * 12 + 8}px`}>
			<p class={st.unavailable ? 'text-warning' : 'text-destructive'}>{st.error}</p>
			<button
				type="button"
				class="text-link hover:underline pointer-coarse:min-h-10"
				onclick={() => loadDir(path)}>Erneut versuchen</button
			>
		</div>
	{:else if !st.entries.length}
		<div class="py-1 text-xs text-muted-foreground" style={`padding-left:${depth * 12 + 24}px`}>
			leer
		</div>
	{:else}
		<ul role="group">
			{#each st.entries as e (e.path)}
				{@const isDir = e.type === 'dir'}
				{@const open = !!expanded[e.path]}
				<li
					role="treeitem"
					aria-expanded={isDir ? open : undefined}
					aria-selected={activePath === e.path}
				>
					<button
						type="button"
						class={cn(
							'flex w-full items-center gap-1.5 rounded-sm py-[3px] pr-2 text-left text-[13px] hover:bg-muted pointer-coarse:min-h-10 pointer-coarse:text-sm',
							activePath === e.path && 'bg-muted font-medium'
						)}
						style={`padding-left:${depth * 12 + 6}px`}
						onclick={() => toggle(e)}
						title={e.path}
					>
						{#if isDir}
							<ChevronRight
								class={cn(
									'size-3.5 shrink-0 text-muted-foreground transition-transform',
									open && 'rotate-90'
								)}
							/>
							{#if open}<FolderOpen class="size-3.5 shrink-0 text-muted-foreground" />{:else}<Folder
									class="size-3.5 shrink-0 text-muted-foreground"
								/>{/if}
						{:else}
							<span class="size-3.5 shrink-0"></span>
							{#if e.type === 'symlink'}<Link2
									class="size-3.5 shrink-0 text-muted-foreground"
								/>{:else}<File class="size-3.5 shrink-0 text-muted-foreground" />{/if}
						{/if}
						<span
							class={cn(
								'truncate',
								(isDir ? dirChanged(e.path) : hasChange(e.path)) && 'text-warning'
							)}>{e.name}</span
						>
					</button>
					{#if isDir && open}
						{@render dir(e.path, depth + 1)}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<div role="tree" aria-label="Dateien" class="py-1">
	{@render dir('', 0)}
</div>
