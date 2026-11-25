<script lang="ts">
	// Markdown-Anzeige für Chat, Aufträge und Agent-Ausgaben: Parser in `../markdown.ts`, hier nur Svelte-Elemente.
	// Bewusst kein {@html} – Inhalte stammen von Nutzern und Agents; Text wird immer escaped gerendert.
	import Check from '@lucide/svelte/icons/check';
	import { cn } from '$lib/utils';
	import { parseMarkdown, type Align, type Block, type Inline } from '../markdown';

	let { text, class: className = '' }: { text: string; class?: string } = $props();

	const blocks = $derived(parseMarkdown(text ?? ''));

	const HEADING = {
		1: 'text-lg font-semibold',
		2: 'text-base font-semibold',
		3: 'text-sm font-semibold',
		4: 'text-sm font-semibold',
		5: 'text-sm font-medium',
		6: 'text-sm font-medium text-muted-foreground'
	} as const;

	const alignClass = (a: Align | undefined) =>
		a === 'center' ? 'text-center' : a === 'right' ? 'text-right' : 'text-left';
	const external = (href: string) => /^(?:https?:)?\/\//i.test(href);
</script>

{#snippet inlines(nodes: Inline[])}
	{#each nodes as n, i (i)}
		{#if n.t === 'text'}{n.v}{:else if n.t === 'br'}<br />{:else if n.t === 'code'}<code
				class="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-words">{n.v}</code
			>{:else if n.t === 'strong'}<strong class="font-semibold">{@render inlines(n.c)}</strong
			>{:else if n.t === 'em'}<em>{@render inlines(n.c)}</em>{:else if n.t === 'del'}<del
				>{@render inlines(n.c)}</del
			>{:else if n.t === 'link'}<a
				href={n.href}
				class="break-words text-link underline-offset-2 hover:underline"
				target={external(n.href) ? '_blank' : undefined}
				rel={external(n.href) ? 'noopener noreferrer nofollow' : undefined}
				>{@render inlines(n.c)}</a
			>{/if}
	{/each}
{/snippet}

{#snippet render(list: Block[])}
	{#each list as b, i (i)}
		{#if b.t === 'p'}
			<p class="break-words">{@render inlines(b.c)}</p>
		{:else if b.t === 'h'}
			<svelte:element
				this={`h${Math.min(b.level + 2, 6)}`}
				class={cn('break-words', HEADING[b.level])}>{@render inlines(b.c)}</svelte:element
			>
		{:else if b.t === 'code'}
			<pre
				class="overflow-x-auto rounded-md border bg-muted/60 p-2 font-mono text-xs leading-snug"
				data-lang={b.lang || undefined}><code>{b.v}</code></pre>
		{:else if b.t === 'quote'}
			<blockquote class="space-y-2 border-l-2 pl-3 text-muted-foreground">
				{@render render(b.c)}
			</blockquote>
		{:else if b.t === 'list'}
			<svelte:element
				this={b.ordered ? 'ol' : 'ul'}
				start={b.ordered && b.start !== 1 ? b.start : undefined}
				class={cn(
					'space-y-1 pl-5',
					b.ordered ? 'list-decimal' : 'list-disc',
					b.items.some((it) => it.checked !== null) && 'list-none pl-1'
				)}
			>
				{#each b.items as item, k (k)}
					<li class={cn('space-y-1', item.checked !== null && 'flex items-start gap-2')}>
						{#if item.checked !== null}
							<span
								class={cn(
									'mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded border',
									item.checked && 'border-success bg-success-muted text-success'
								)}
								role="img"
								aria-label={item.checked ? 'erledigt' : 'offen'}
								>{#if item.checked}<Check class="size-3" aria-hidden="true" />{/if}</span
							>
							<div class="min-w-0 flex-1 space-y-1">{@render render(item.c)}</div>
						{:else}
							{@render render(item.c)}
						{/if}
					</li>
				{/each}
			</svelte:element>
		{:else if b.t === 'hr'}
			<hr class="border-border" />
		{:else if b.t === 'table'}
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-xs">
					<thead>
						<tr class="border-b">
							{#each b.head as cell, k (k)}
								<th class={cn('px-2 py-1 font-semibold', alignClass(b.align[k]))}
									>{@render inlines(cell)}</th
								>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each b.rows as row, r (r)}
							<tr class="border-b last:border-b-0">
								{#each row as cell, k (k)}
									<td class={cn('px-2 py-1 align-top', alignClass(b.align[k]))}
										>{@render inlines(cell)}</td
									>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/each}
{/snippet}

<div class={cn('space-y-2 text-sm leading-relaxed', className)}>
	{@render render(blocks)}
</div>
