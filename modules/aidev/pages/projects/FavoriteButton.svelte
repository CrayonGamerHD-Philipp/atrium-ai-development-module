<script lang="ts">
	// Stern zum (Ent-)Markieren als Favorit – steht neben dem Projektlink, nie darin
	import Star from '@lucide/svelte/icons/star';
	import { cn } from '$lib/utils';

	let {
		active,
		name,
		ontoggle,
		class: className
	}: { active: boolean; name: string; ontoggle: () => void; class?: string } = $props();
</script>

<button
	type="button"
	class={cn(
		'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
		active && 'text-warning hover:text-warning',
		className
	)}
	aria-label={active ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
	aria-pressed={active}
	title={`${name}: ${active ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}`}
	onclick={(e) => {
		e.preventDefault();
		e.stopPropagation();
		ontoggle();
	}}
>
	<Star class={cn('size-4', active && 'fill-current')} aria-hidden="true" />
</button>
