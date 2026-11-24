<script lang="ts">
	// Anbieter-Badge: farbiger Punkt (unterscheidbar je Anbieter) + Name in Vordergrundfarbe (Kontrast unabhängig vom Punkt)
	import { cn } from '$lib/utils';
	import type { Provider } from '../../protocol';
	import { PROVIDER_SHORT, providerLabel } from '../format';

	let {
		provider,
		model = '',
		class: className
	}: { provider: Provider; model?: string; class?: string } = $props();

	/** Datenvisualisierung: feste, in Hell und Dunkel gut unterscheidbare Punktfarben */
	const DOT: Record<Provider, string> = {
		claude: '#d97757',
		codex: '#10a37f',
		gemini: '#4c8df6',
		'openai-api': '#9b6dff',
		fake: '#94a3b8'
	};
</script>

<span
	class={cn(
		'inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2 text-xs font-medium whitespace-nowrap',
		className
	)}
	title={model ? `${providerLabel(provider)} · ${model}` : providerLabel(provider)}
>
	<span
		class="size-2 shrink-0 rounded-full"
		style={`background-color:${DOT[provider] ?? '#94a3b8'}`}
	></span>
	<span class="truncate">{PROVIDER_SHORT[provider] ?? provider}</span>
	{#if model}<span class="truncate font-normal text-muted-foreground">{model}</span>{/if}
</span>
