<script lang="ts">
	// Anhänge eines Entwurfs als Chips: Vorschaubild bzw. Symbol, Name, Größe, Fortschritt oder Fehler, Entfernen
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import FileIcon from '@lucide/svelte/icons/file';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import X from '@lucide/svelte/icons/x';
	import { cn } from '$lib/utils';
	import { formatBytes } from './attachments';
	import type { AttachmentDraft } from './attachments.svelte';

	let {
		draft,
		disabled = false,
		class: className = ''
	}: { draft: AttachmentDraft; disabled?: boolean; class?: string } = $props();
</script>

{#if draft.items.length}
	<ul class={cn('flex min-w-0 flex-wrap gap-1.5', className)} aria-label="Anhänge">
		{#each draft.items as item (item.key)}
			{@const failed = item.status === 'error'}
			<li
				class={cn(
					'inline-flex max-w-full min-w-0 items-center gap-2 rounded-lg border bg-muted/40 py-1 pr-0.5 pl-1 text-xs',
					failed && 'border-destructive-border bg-destructive-muted text-destructive'
				)}
				title={failed ? `${item.name}: ${item.error}` : item.name}
			>
				{#if item.preview}
					<img
						src={item.preview}
						alt=""
						class="size-8 shrink-0 rounded-md border bg-background object-cover"
					/>
				{:else}
					<span
						class="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"
						aria-hidden="true"
					>
						{#if failed}<CircleAlert class="size-4 text-destructive" />{:else}<FileIcon
								class="size-4"
							/>{/if}
					</span>
				{/if}
				<span class="flex min-w-0 flex-col leading-tight">
					<span class="max-w-48 truncate font-medium">{item.name}</span>
					<span class={cn('tabular-nums', !failed && 'text-muted-foreground')}>
						{#if failed}
							{item.error}
						{:else if item.status === 'uploading'}
							<span class="inline-flex items-center gap-1">
								<LoaderCircle class="size-3 animate-spin" aria-hidden="true" />
								{Math.round(item.progress * 100)} % von {formatBytes(item.size)}
							</span>
						{:else}
							{formatBytes(item.size)}
						{/if}
					</span>
					{#if item.status === 'uploading'}
						<progress
							class="sr-only"
							max="100"
							value={Math.round(item.progress * 100)}
							aria-label="{item.name} wird hochgeladen"
							>{Math.round(item.progress * 100)} %</progress
						>
					{/if}
				</span>
				<button
					type="button"
					class="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-sm:size-10"
					aria-label="Anhang {item.name} entfernen"
					{disabled}
					onclick={() => draft.remove(item.key)}
				>
					<X class="size-3.5" aria-hidden="true" />
				</button>
			</li>
		{/each}
	</ul>
{/if}
<p class="sr-only" aria-live="polite">{draft.notice}</p>
