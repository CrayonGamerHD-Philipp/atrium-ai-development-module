<script lang="ts">
	// Schnellerfassung „Neuer Auftrag“: Auftragstext, Rolle, Planen & aufteilen, Priorität, Anbieter, Entwurf
	import { toast } from 'svelte-sonner';
	import Send from '@lucide/svelte/icons/send';
	import { BUSY_SAVE, NumberStepper } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { PROVIDERS, ROLES, type Provider, type Role } from '../../protocol';
	import { PROVIDER_LABELS, ROLE_LABELS, type TaskDto } from '../../schemas';
	import { createTask } from '../api';
	import { errMsg } from '../format';

	let { projectId, oncreated }: { projectId: string; oncreated?: (task: TaskDto) => void } =
		$props();

	let prompt = $state('');
	let title = $state('');
	let role = $state<Role>('implement');
	let decompose = $state(false);
	let delivery = $state<'project' | 'branch'>('project');
	let priority = $state(0);
	let providerHint = $state<Provider | null>(null);
	let draft = $state(false);
	let more = $state(false);
	let busy = $state(false);

	const deliveryOptions = [
		{ value: 'project', label: 'Projektvorgabe' },
		{ value: 'branch', label: 'Branch bereitstellen (ohne PR)' }
	];
	const roleOptions = ROLES.filter((r) => r !== 'orchestrate').map((r) => ({
		value: r,
		label: ROLE_LABELS[r]
	}));
	const providerOptions = PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }));

	async function submit(e?: Event) {
		e?.preventDefault();
		const text = prompt.trim();
		if (!text) {
			document.getElementById('new-task-prompt')?.focus();
			return;
		}
		busy = true;
		try {
			const task = await createTask(projectId, {
				prompt: text,
				title: title.trim() || undefined,
				role,
				decompose,
				delivery,
				priority,
				providerHint,
				draft
			});
			toast.success(draft ? 'Entwurf gespeichert' : 'Auftrag eingeplant');
			prompt = '';
			title = '';
			oncreated?.(task);
		} catch (err) {
			toast.error(errMsg(err, 'Auftrag konnte nicht angelegt werden'));
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e);
	}
</script>

<form class="space-y-3 rounded-lg border bg-card p-3" onsubmit={submit}>
	<Label for="new-task-prompt" class="sr-only">Neuer Auftrag</Label>
	<Textarea
		id="new-task-prompt"
		bind:value={prompt}
		rows={2}
		maxlength={20000}
		placeholder="Neuer Auftrag – was soll ein Agent tun? (Strg+Enter zum Senden)"
		{onkeydown}
		disabled={busy}
		class="min-h-16 resize-y"
	/>
	<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
		<SelectField
			label="Rolle"
			options={roleOptions}
			value={role}
			onchange={(v) => v && (role = v as Role)}
			size="sm"
			class="w-full sm:w-36"
			disabled={busy || decompose}
		/>
		<SelectField
			label="Auslieferung"
			options={deliveryOptions}
			value={delivery}
			onchange={(v) => v && (delivery = v as 'project' | 'branch')}
			size="sm"
			class="w-full sm:w-64"
			disabled={busy}
		/>
		<label class="inline-flex min-h-10 items-center gap-2 text-sm sm:min-h-8">
			<Switch bind:checked={decompose} size="sm" disabled={busy} />
			Planen & aufteilen
		</label>
		<label class="inline-flex min-h-10 items-center gap-2 text-sm sm:min-h-8">
			<Switch bind:checked={draft} size="sm" disabled={busy} />
			Als Entwurf
		</label>
		<Button
			variant="ghost"
			size="sm"
			onclick={() => (more = !more)}
			aria-expanded={more}
			aria-controls="new-task-more"
			class="max-sm:h-10">Mehr</Button
		>
		<Button
			type="submit"
			size="sm"
			class="w-full max-sm:h-10 sm:ml-auto sm:w-auto"
			disabled={busy || !prompt.trim()}
		>
			<Send />
			{busy ? BUSY_SAVE : draft ? 'Entwurf speichern' : 'Auftrag geben'}
		</Button>
	</div>
	<p class="text-xs text-muted-foreground">
		Branch bereitstellen pusht einen eigenen Branch ohne Pull Request; der Hauptbranch bleibt
		unverändert. Leseaufträge liefern keine Änderungen aus.
	</p>
	{#if more}
		<div id="new-task-more" class="grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-3">
			<div class="min-w-0 space-y-1">
				<Label for="new-task-title" class="text-xs">Titel (optional)</Label>
				<Input
					id="new-task-title"
					bind:value={title}
					maxlength={200}
					placeholder="wird sonst erzeugt"
					disabled={busy}
				/>
			</div>
			<div class="min-w-0 space-y-1">
				<Label for="new-task-priority" class="text-xs">Priorität</Label>
				<NumberStepper
					id="new-task-priority"
					label="Priorität"
					bind:value={priority}
					min={-10}
					max={10}
					disabled={busy}
				/>
			</div>
			<div class="min-w-0 space-y-1">
				<Label for="new-task-provider" class="text-xs">Anbieter erzwingen</Label>
				<SelectField
					id="new-task-provider"
					label="Anbieter erzwingen"
					options={providerOptions}
					emptyLabel="Automatisch (Verteilung)"
					value={providerHint}
					onchange={(v) => (providerHint = v as Provider | null)}
					disabled={busy}
				/>
			</div>
			{#if decompose}
				<p class="text-xs text-muted-foreground sm:col-span-3">
					Ein Agent plant zuerst und zerlegt den Auftrag in Teilaufträge mit Abhängigkeiten, die
					dann parallel abgearbeitet werden.
				</p>
			{/if}
		</div>
	{/if}
</form>
