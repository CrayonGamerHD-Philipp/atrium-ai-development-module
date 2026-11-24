<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type { RunStatus, TaskStatus } from '../../schemas';
	import { RUN_STATUS_LABELS, RUN_TONE, TASK_TONE, statusLabel } from '../format';

	let {
		status,
		run = false,
		class: className
	}: { status: TaskStatus | RunStatus; run?: boolean; class?: string } = $props();

	const tone = $derived(run ? RUN_TONE[status as RunStatus] : TASK_TONE[status as TaskStatus]);
	const label = $derived(
		run ? RUN_STATUS_LABELS[status as RunStatus] : statusLabel(status as TaskStatus)
	);
	const pulsing = $derived(status === 'running');
</script>

<Badge variant={tone ?? 'outline'} class={className}>
	{#if pulsing}
		<span class="relative flex size-1.5" aria-hidden="true">
			<span class="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60"
			></span>
			<span class="relative inline-flex size-1.5 rounded-full bg-current"></span>
		</span>
	{/if}
	{label ?? status}
</Badge>
