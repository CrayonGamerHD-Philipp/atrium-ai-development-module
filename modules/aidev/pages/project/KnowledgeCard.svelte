<script lang="ts">
	// Projektwissen (knowledge.ts): Notizen der Agents aus früheren Läufen – ansehen, bearbeiten, leeren
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { BUSY_SAVE, ConfirmDialog } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Textarea } from '$lib/components/ui/textarea';
	import { KNOWLEDGE_MAX } from '../../knowledge';
	import { updateProject } from '../api';
	import { errMsg } from '../format';
	import TimeAgo from '../components/TimeAgo.svelte';
	import type { ProjectStore } from './store.svelte';

	let { store, canManage }: { store: ProjectStore; canManage: boolean } = $props();

	let value = $state(untrack(() => store.project?.knowledge ?? ''));
	let baseline = $state(untrack(() => store.project?.knowledge ?? ''));
	let busy = $state(false);
	let clearOpen = $state(false);
	const dirty = $derived(value !== baseline);

	// Neue Notizen der Agents übernehmen, solange nichts bearbeitet wird
	$effect(() => {
		const k = store.project?.knowledge ?? '';
		if (!untrack(() => dirty) && k !== untrack(() => baseline)) {
			value = k;
			baseline = k;
		}
	});

	async function save(next: string) {
		busy = true;
		try {
			const p = await updateProject(store.id, { knowledge: next });
			store.project = p;
			value = p.knowledge;
			baseline = p.knowledge;
			toast.success(next ? 'Projektwissen gespeichert' : 'Projektwissen geleert');
		} catch (e) {
			toast.error(errMsg(e, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Projektwissen</Card.Title>
		<Card.Description>
			Agents halten hier fest, was sie über das Repository gelernt haben (Befehle, Aufbau,
			Stolperfallen). Jeder Lauf bekommt es mit und muss das Projekt nicht erneut erkunden – das
			spart Tokens und Zeit.
			{#if store.project?.knowledgeUpdatedAt}
				Zuletzt ergänzt <TimeAgo value={store.project.knowledgeUpdatedAt} />.
			{/if}
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-2">
		<Textarea
			id="project-knowledge"
			aria-label="Projektwissen"
			bind:value
			rows={8}
			maxlength={KNOWLEDGE_MAX}
			class="font-mono text-xs"
			placeholder="Noch leer – Agents ergänzen es nach ihren Läufen. Eigene Notizen sind ebenfalls möglich."
			disabled={!canManage || busy}
			spellcheck={false}
		/>
		<p class="text-xs text-muted-foreground">
			{value.length} / {KNOWLEDGE_MAX} Zeichen. Automatische Einträge (<code>- [Datum] …</code>)
			fallen bei Platzmangel als erste weg, eigene Zeilen bleiben.
		</p>
	</Card.Content>
	{#if canManage}
		<Card.Footer class="flex-wrap justify-end gap-2">
			{#if baseline}
				<Button variant="ghost" onclick={() => (clearOpen = true)} disabled={busy}>Leeren</Button>
			{/if}
			{#if dirty}
				<Button variant="ghost" onclick={() => (value = baseline)} disabled={busy}>Verwerfen</Button
				>
			{/if}
			<Button onclick={() => save(value)} disabled={busy || !dirty}>
				{busy ? BUSY_SAVE : 'Speichern'}
			</Button>
		</Card.Footer>
	{/if}
</Card.Root>

<ConfirmDialog
	bind:open={clearOpen}
	title="Projektwissen leeren?"
	description="Alle Notizen werden entfernt. Agents beginnen danach wieder ohne Vorwissen."
	confirmLabel="Leeren"
	destructive
	onconfirm={() => save('')}
/>
