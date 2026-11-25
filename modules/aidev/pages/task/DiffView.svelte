<script lang="ts">
	// Diff eines Auftrags (Branch gegen Basis): Dateiliste mit +/−, je Datei einklappbarer Unified Diff mit Zeilenfärbung.
	// Große Dateien starten eingeklappt und zeigen zunächst nur einen Teil der Zeilen.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FileDiff from '@lucide/svelte/icons/file-diff';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import type { DiffDto } from '../../schemas';
	import { parseUnifiedDiff, type DiffFile } from '../diff';
	import { shortSha } from '../format';

	let { diff }: { diff: DiffDto } = $props();

	const files = $derived(parseUnifiedDiff(diff.diff));
	const totals = $derived(
		files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), {
			add: 0,
			del: 0
		})
	);

	const BIG = 400;
	const STEP = 800;
	let open = $state<Record<string, boolean>>({});
	let limits = $state<Record<string, number>>({});

	const isOpen = (f: DiffFile, i: number) =>
		open[`${i}:${f.path}`] ?? (f.lines.length <= BIG && files.length <= 40);
	const limitOf = (f: DiffFile, i: number) => limits[`${i}:${f.path}`] ?? STEP;

	function toggle(f: DiffFile, i: number) {
		open[`${i}:${f.path}`] = !isOpen(f, i);
	}

	function jump(i: number) {
		const f = files[i];
		if (!f) return;
		open[`${i}:${f.path}`] = true;
		document
			.getElementById(`diff-file-${i}`)
			?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	const STATUS_LABEL: Record<DiffFile['status'], string> = {
		added: 'neu',
		deleted: 'gelöscht',
		renamed: 'umbenannt',
		modified: '',
		binary: 'binär'
	};
</script>

<div class="min-w-0 space-y-4">
	<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
		<span class="font-medium">{files.length} {files.length === 1 ? 'Datei' : 'Dateien'}</span>
		<span class="font-mono text-xs tabular-nums">
			<span class="text-success">+{totals.add}</span>
			<span class="text-destructive">−{totals.del}</span>
		</span>
		<span class="font-mono text-xs break-all text-muted-foreground">
			{shortSha(diff.base) || diff.base} … {shortSha(diff.head) || diff.head}
		</span>
		{#if diff.truncated}
			<Badge variant="warning">Gekürzt – Diff zu groß</Badge>
		{/if}
	</div>

	{#if !files.length}
		<p class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
			Keine Änderungen gegenüber dem Haupt-Branch.
		</p>
	{:else}
		<nav aria-label="Geänderte Dateien" class="rounded-lg border bg-card">
			<ul class="max-h-64 divide-y overflow-y-auto">
				{#each files as f, i (`${i}:${f.path}`)}
					<li>
						<button
							type="button"
							class="flex min-h-10 w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted sm:min-h-0"
							onclick={() => jump(i)}
						>
							<FileDiff class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="min-w-0 flex-1 truncate font-mono">{f.path}</span>
							{#if STATUS_LABEL[f.status]}
								<span class="text-muted-foreground">{STATUS_LABEL[f.status]}</span>
							{/if}
							<span class="font-mono tabular-nums">
								<span class="text-success">+{f.additions}</span>
								<span class="text-destructive">−{f.deletions}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</nav>

		{#each files as f, i (`${i}:${f.path}`)}
			{@const expanded = isOpen(f, i)}
			{@const limit = limitOf(f, i)}
			<section
				id={`diff-file-${i}`}
				class="min-w-0 scroll-mt-20 overflow-hidden rounded-lg border bg-card"
			>
				<button
					type="button"
					class="sticky top-0 z-10 flex min-h-10 w-full items-center gap-2 border-b bg-muted/60 px-3 py-2 text-left text-xs backdrop-blur"
					aria-expanded={expanded}
					onclick={() => toggle(f, i)}
				>
					<ChevronRight
						class={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-90')}
					/>
					<span class="min-w-0 flex-1 truncate font-mono font-medium">
						{#if f.status === 'renamed' && f.oldPath}{f.oldPath} →
						{/if}{f.path}
					</span>
					{#if STATUS_LABEL[f.status]}<Badge variant="outline">{STATUS_LABEL[f.status]}</Badge>{/if}
					<span class="font-mono tabular-nums">
						<span class="text-success">+{f.additions}</span>
						<span class="text-destructive">−{f.deletions}</span>
					</span>
				</button>
				{#if expanded}
					{#if f.status === 'binary'}
						<p class="p-3 text-xs text-muted-foreground">Binärdatei – keine Textansicht.</p>
					{:else if !f.lines.length}
						<p class="p-3 text-xs text-muted-foreground">
							Keine Textänderungen (z. B. nur Rechte).
						</p>
					{:else}
						<div class="max-w-full min-w-0 overflow-x-auto overscroll-x-contain">
							<table
								class="w-full border-collapse font-mono text-[11px] leading-4 sm:text-xs sm:leading-5"
							>
								<tbody>
									{#each f.lines.slice(0, limit) as l, j (j)}
										{#if l.kind === 'hunk'}
											<tr class="bg-info-muted text-info">
												<td colspan="3" class="px-2 py-0.5 whitespace-pre select-none sm:px-3"
													>{l.text}</td
												>
											</tr>
										{:else}
											<tr
												class={cn(
													l.kind === 'add' && 'bg-success-muted',
													l.kind === 'del' && 'bg-destructive-muted'
												)}
											>
												<td
													class="w-8 border-r px-1 text-right text-muted-foreground tabular-nums select-none sm:w-10 sm:px-2"
													>{l.oldNo ?? ''}</td
												>
												<td
													class="w-8 border-r px-1 text-right text-muted-foreground tabular-nums select-none sm:w-10 sm:px-2"
													>{l.newNo ?? ''}</td
												>
												<td class="px-1.5 whitespace-pre sm:px-2"
													><span
														class={cn(
															'inline-block w-3 select-none',
															l.kind === 'add' && 'text-success',
															l.kind === 'del' && 'text-destructive',
															l.kind === 'meta' && 'text-muted-foreground'
														)}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span
													>{l.text}</td
												>
											</tr>
										{/if}
									{/each}
								</tbody>
							</table>
						</div>
						{#if f.lines.length > limit}
							<div class="border-t p-2 text-center">
								<Button
									variant="ghost"
									size="sm"
									onclick={() => (limits[`${i}:${f.path}`] = limit + STEP)}
								>
									Weitere {Math.min(STEP, f.lines.length - limit)} von {f.lines.length - limit} Zeilen
									zeigen
								</Button>
							</div>
						{/if}
					{/if}
				{/if}
			</section>
		{/each}
	{/if}
</div>
