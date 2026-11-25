<script lang="ts">
	// Knopf „Datei anhängen“ mit verstecktem Dateifeld (Mehrfachauswahl)
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import { Button } from '$lib/components/ui/button';
	import type { AttachmentDraft } from './attachments.svelte';

	let {
		draft,
		disabled = false,
		label = false,
		class: className = ''
	}: {
		draft: AttachmentDraft;
		disabled?: boolean;
		/** Beschriftung sichtbar (sonst nur Symbol mit `aria-label`) */
		label?: boolean;
		class?: string;
	} = $props();

	let input = $state<HTMLInputElement | null>(null);

	function onchange() {
		const files = input?.files ? Array.from(input.files) : [];
		draft.add(files);
		// dieselbe Datei soll erneut wählbar sein
		if (input) input.value = '';
	}
</script>

<input
	bind:this={input}
	type="file"
	multiple
	class="hidden"
	tabindex="-1"
	aria-hidden="true"
	{onchange}
/>
<Button
	type="button"
	variant="ghost"
	size={label ? 'sm' : 'icon'}
	class={className}
	{disabled}
	aria-label="Datei anhängen"
	title="Datei anhängen (auch per Strg+V oder Ziehen)"
	onclick={() => input?.click()}
>
	<Paperclip class={label ? '' : 'size-5'} aria-hidden="true" />
	{#if label}Datei anhängen{/if}
</Button>
