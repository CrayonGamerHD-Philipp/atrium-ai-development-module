<script lang="ts">
	// Text mit markierten Suchtreffern – Segmente aus highlightParts, kein {@html}
	import { highlightParts } from './filter';

	let { text, tokens }: { text: string; tokens: string[] } = $props();

	const parts = $derived(highlightParts(text, tokens));
</script>

{#each parts as part, i (i)}{#if part.hit}<mark
			class="rounded-sm bg-warning/25 text-foreground dark:bg-warning/30">{part.text}</mark
		>{:else}{part.text}{/if}{/each}
