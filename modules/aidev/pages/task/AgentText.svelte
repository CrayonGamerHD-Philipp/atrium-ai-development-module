<script lang="ts">
	// Agent-Text als reiner Text: Absätze mit Zeilenumbrüchen, ```-Blöcke als <pre>, Überschriften (#) fett.
	// Bewusst kein {@html} – Inhalte stammen vom Agent.
	let { text, class: className = '' }: { text: string; class?: string } = $props();

	type Part = { kind: 'text' | 'code' | 'heading'; body: string; lang?: string };

	const parts = $derived.by<Part[]>(() => {
		const out: Part[] = [];
		const lines = text.split('\n');
		let buf: string[] = [];
		let code: string[] | null = null;
		let lang = '';
		const flush = () => {
			const body = buf.join('\n').replace(/^\n+|\n+$/g, '');
			if (body) out.push({ kind: 'text', body });
			buf = [];
		};
		for (const line of lines) {
			const fence = /^\s*```(\S*)/.exec(line);
			if (code) {
				if (fence) {
					out.push({ kind: 'code', body: code.join('\n'), lang });
					code = null;
				} else code.push(line);
				continue;
			}
			if (fence) {
				flush();
				code = [];
				lang = fence[1] ?? '';
				continue;
			}
			const h = /^#{1,6}\s+(.*)$/.exec(line);
			if (h) {
				flush();
				out.push({ kind: 'heading', body: h[1] ?? '' });
				continue;
			}
			buf.push(line);
		}
		if (code) out.push({ kind: 'code', body: code.join('\n'), lang });
		flush();
		return out;
	});
</script>

<div class={`space-y-2 text-sm leading-relaxed ${className}`}>
	{#each parts as p, i (i)}
		{#if p.kind === 'code'}
			<pre
				class="overflow-x-auto rounded-md border bg-muted/60 p-2 font-mono text-xs leading-snug"
				data-lang={p.lang || undefined}>{p.body}</pre>
		{:else if p.kind === 'heading'}
			<p class="font-semibold">{p.body}</p>
		{:else}
			<p class="break-words whitespace-pre-wrap">{p.body}</p>
		{/if}
	{/each}
</div>
