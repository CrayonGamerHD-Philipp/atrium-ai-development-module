<script lang="ts">
	// Anhänge einer Nachricht bzw. eines Auftrags: Bilder als Vorschau, andere Dateien als Link mit Name und Größe
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import { cn } from '$lib/utils';
	import type { AttachmentDto } from '../../schemas';
	import { attachmentUrl, formatBytes, splitAttachments } from './attachments';

	let {
		attachments,
		compact = false,
		class: className = ''
	}: {
		attachments: AttachmentDto[] | null | undefined;
		compact?: boolean;
		class?: string;
	} = $props();

	const parts = $derived(splitAttachments(attachments));
	const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';
</script>

{#if parts.images.length || parts.files.length}
	<div class={cn('flex min-w-0 flex-col gap-1.5', className)}>
		{#if parts.images.length}
			<ul class="flex flex-wrap gap-1.5" aria-label="Bilder">
				{#each parts.images as a (a.id)}
					<li>
						<a
							href={attachmentUrl(a.id)}
							target="_blank"
							rel="noopener noreferrer"
							class={cn('block overflow-hidden rounded-md border bg-background', FOCUS)}
							title="{a.name} ({formatBytes(a.size)})"
						>
							<img
								src={attachmentUrl(a.id)}
								alt={a.name}
								loading="lazy"
								class={cn('object-cover', compact ? 'size-16' : 'size-24 sm:size-32')}
							/>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
		{#if parts.files.length}
			<ul class="flex flex-wrap gap-1.5" aria-label="Dateien">
				{#each parts.files as a (a.id)}
					<li class="max-w-full min-w-0">
						<a
							href={attachmentUrl(a.id)}
							download={a.name}
							class={cn(
								'inline-flex max-w-full min-h-8 items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs hover:bg-muted max-lg:min-h-10',
								FOCUS
							)}
						>
							<Paperclip class="size-3.5 shrink-0" aria-hidden="true" />
							<span class="truncate text-link">{a.name}</span>
							<span class="shrink-0 text-muted-foreground tabular-nums">{formatBytes(a.size)}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
