<script lang="ts">
	import { cn } from '$lib/utils';
	import type { LiveStatus } from '../live.svelte';

	let { status, class: className }: { status: LiveStatus; class?: string } = $props();

	const label = $derived(
		status === 'live'
			? 'Live'
			: status === 'connecting'
				? 'Verbindet …'
				: status === 'offline'
					? 'Offline – verbindet erneut'
					: 'Getrennt'
	);
</script>

<span
	class={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}
	role="status"
	aria-live="polite"
>
	<span
		class={cn(
			'size-2 rounded-full',
			status === 'live' && 'bg-success',
			status === 'connecting' && 'animate-pulse bg-muted-foreground',
			status === 'offline' && 'bg-warning',
			status === 'closed' && 'bg-muted-foreground/50'
		)}
		aria-hidden="true"
	></span>
	{label}
</span>
