<script lang="ts">
	// Fläche für Drag & Drop von Dateien: hebt sich beim Ziehen hervor und übergibt die Dateien an den Entwurf
	import type { Snippet } from 'svelte';
	import Upload from '@lucide/svelte/icons/upload';
	import { cn } from '$lib/utils';
	import type { AttachmentDraft } from './attachments.svelte';

	let {
		draft,
		disabled = false,
		class: className = '',
		children
	}: { draft: AttachmentDraft; disabled?: boolean; class?: string; children: Snippet } = $props();

	// gesperrt: Dateien nicht annehmen, aber den Browser daran hindern, die Datei zu öffnen
	const block = (e: DragEvent) => {
		if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files'))
			e.preventDefault();
	};
</script>

<div
	role="group"
	aria-label="Ablagefläche für Dateien"
	class={cn('relative', className)}
	ondragenter={disabled ? block : draft.ondragenter}
	ondragover={disabled ? block : draft.ondragover}
	ondragleave={disabled ? undefined : draft.ondragleave}
	ondrop={disabled ? block : draft.ondrop}
>
	{@render children()}
	{#if draft.dragging && !disabled}
		<div
			class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-info-border bg-info-muted/90 text-sm font-medium text-info"
			aria-hidden="true"
		>
			<Upload class="size-5" />
			Dateien hier ablegen
		</div>
	{/if}
</div>
