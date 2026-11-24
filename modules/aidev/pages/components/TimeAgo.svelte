<script lang="ts">
	// Relative Zeit („vor 5 Minuten“), absolute Zeit im Tooltip; aktualisiert sich alle 30 s
	import { onMount } from 'svelte';
	import { absolute, relative } from '../format';

	let {
		value,
		empty = '–',
		class: className
	}: { value: string | null | undefined; empty?: string; class?: string } = $props();

	let now = $state(new Date());
	onMount(() => {
		const t = setInterval(() => (now = new Date()), 30_000);
		return () => clearInterval(t);
	});
</script>

{#if value}
	<time datetime={value} title={absolute(value)} class={className}>{relative(value, now)}</time>
{:else}
	<span class={className}>{empty}</span>
{/if}
