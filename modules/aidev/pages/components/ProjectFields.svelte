<script lang="ts" module>
	import type { CommitPolicy } from '../../protocol';

	export interface ProjectFormValues {
		name: string;
		repo: string;
		defaultBranch: string;
		commitPolicy: CommitPolicy;
		maxParallel: number;
		setupCmd: string;
		testCmd: string;
		instructions: string;
		preferredRunnerId: string | null;
	}

	export const POLICY_HINTS: Record<CommitPolicy, string> = {
		pr: 'Agents arbeiten auf eigenen Branches und öffnen einen Pull Request. Du prüfst und mergst selbst.',
		'pr-automerge':
			'Wie Pull Request, aber GitHub mergt automatisch, sobald alle Checks grün sind (Auto-Merge muss im Repo erlaubt sein).',
		direct:
			'Agents pushen direkt auf den Haupt-Branch – ohne Prüfung. Nur für Experimente oder private Spielwiesen.'
	};
</script>

<script lang="ts">
	// Gemeinsame Felder für „Projekt anlegen“ und die Projekteinstellungen
	import { FormField, NumberStepper } from '$lib/components/layout';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import { COMMIT_POLICIES } from '../../protocol';
	import { POLICY_LABELS } from '../../schemas';

	let {
		values = $bindable(),
		errors = {},
		showRepo = true,
		runners = null,
		disabled = false,
		idPrefix = 'project'
	}: {
		values: ProjectFormValues;
		errors?: Partial<Record<keyof ProjectFormValues, string>>;
		showRepo?: boolean;
		/** Runner-Auswahl (nur mit Recht runner.manage geladen), `null` = Feld ausblenden */
		runners?: { id: string; name: string }[] | null;
		disabled?: boolean;
		idPrefix?: string;
	} = $props();

	const id = (k: string) => `${idPrefix}-${k}`;
	const policyOptions = COMMIT_POLICIES.map((p) => ({ value: p, label: POLICY_LABELS[p] }));
</script>

<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
	<FormField label="Name" id={id('name')} required error={errors.name}>
		<Input id={id('name')} bind:value={values.name} maxlength={120} {disabled} autocomplete="off" />
	</FormField>
	{#if showRepo}
		<FormField
			label="GitHub-Repository"
			id={id('repo')}
			required
			hint="Link (https://github.com/owner/repo) oder owner/repo"
			error={errors.repo}
		>
			<Input
				id={id('repo')}
				bind:value={values.repo}
				placeholder="owner/repo"
				maxlength={300}
				{disabled}
				autocomplete="off"
				spellcheck={false}
			/>
		</FormField>
	{/if}
	<FormField
		label="Haupt-Branch"
		id={id('branch')}
		hint="Basis für neue Arbeits-Branches"
		error={errors.defaultBranch}
	>
		<Input
			id={id('branch')}
			bind:value={values.defaultBranch}
			placeholder="main"
			maxlength={200}
			{disabled}
			spellcheck={false}
		/>
	</FormField>
	<FormField
		label="Max. gleichzeitige Läufe"
		id={id('parallel')}
		hint="So viele Agents arbeiten höchstens gleichzeitig an diesem Projekt"
		error={errors.maxParallel}
	>
		<NumberStepper
			id={id('parallel')}
			label="Max. gleichzeitige Läufe"
			bind:value={values.maxParallel}
			min={1}
			max={20}
			{disabled}
		/>
	</FormField>
	<div class="sm:col-span-2">
		<FormField
			label="Umgang mit Änderungen"
			id={id('policy')}
			hint={POLICY_HINTS[values.commitPolicy]}
			error={errors.commitPolicy}
		>
			<SelectField
				id={id('policy')}
				label="Umgang mit Änderungen"
				options={policyOptions}
				value={values.commitPolicy}
				onchange={(v) => {
					if (v) values.commitPolicy = v as CommitPolicy;
				}}
				{disabled}
			/>
		</FormField>
	</div>
	{#if runners}
		<div class="sm:col-span-2">
			<FormField
				label="Bevorzugter Runner"
				id={id('runner')}
				hint="Läufe und Workspace bevorzugt auf diesem Runner (sonst jeder freigegebene)"
			>
				<SelectField
					id={id('runner')}
					label="Bevorzugter Runner"
					options={runners.map((r) => ({ value: r.id, label: r.name }))}
					emptyLabel="Beliebiger Runner"
					value={values.preferredRunnerId}
					onchange={(v) => (values.preferredRunnerId = v)}
					{disabled}
				/>
			</FormField>
		</div>
	{/if}
	<FormField
		label="Setup-Befehl"
		id={id('setup')}
		hint="Läuft vor jedem Auftrag, z. B. npm ci"
		error={errors.setupCmd}
	>
		<Input
			id={id('setup')}
			bind:value={values.setupCmd}
			placeholder="npm ci"
			class="font-mono"
			maxlength={2000}
			{disabled}
			spellcheck={false}
		/>
	</FormField>
	<FormField
		label="Test-Befehl"
		id={id('test')}
		hint="Agents prüfen ihre Änderungen damit, z. B. npm test"
		error={errors.testCmd}
	>
		<Input
			id={id('test')}
			bind:value={values.testCmd}
			placeholder="npm test"
			class="font-mono"
			maxlength={2000}
			{disabled}
			spellcheck={false}
		/>
	</FormField>
	<div class="sm:col-span-2">
		<FormField
			label="Projektregeln für Agents"
			id={id('rules')}
			hint="Konventionen, Architektur, Verbote – wird jedem Agent mitgegeben"
			error={errors.instructions}
		>
			<Textarea
				id={id('rules')}
				bind:value={values.instructions}
				rows={5}
				maxlength={20000}
				placeholder="z. B. TypeScript strict, keine neuen Abhängigkeiten ohne Rückfrage, Tests für jede Änderung …"
				{disabled}
			/>
		</FormField>
	</div>
</div>
