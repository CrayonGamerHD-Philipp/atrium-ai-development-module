import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import pkg from './atrium-module.json';
import { adminEndpoints } from './admin.endpoints';
import { chatEndpoints } from './chat.endpoints';
import { aidevJobs } from './jobs';
import { closeAllLive } from './live';
import { projectEndpoints } from './projects.endpoints';
import { pullEndpoints } from './pulls.endpoints';
import { runnerApiEndpoints } from './runner-api.endpoints';
import { taskEndpoints } from './tasks.endpoints';
import { onUserDeleted } from './user-deleted';
import { workspaceEndpoints } from './workspace.endpoints';
import {
	DEFAULT_LIMITS,
	DEFAULT_ROUTING,
	PERM,
	SETTING_LIMITS,
	SETTING_ROUTING,
	limitsSchema,
	routingSchema
} from './schemas';
import m0001 from './migrations/0001_init.sql?raw';

export default defineModule({
	package: pkg,
	manifest: {
		...manifestFromPackage(pkg),
		permissions: [
			PERM.projectView,
			PERM.projectManage,
			PERM.taskCreate,
			PERM.taskManage,
			PERM.terminal,
			PERM.files,
			PERM.runnerManage,
			PERM.runnerConnect,
			PERM.accountManage,
			PERM.settingsManage
		],
		permissionDescriptions: {
			[PERM.projectView]:
				'KI-Entwicklung nutzen: Projekte, Aufträge, Live-Log, Diffs und Pull Requests ansehen',
			[PERM.projectManage]:
				'Projekte (GitHub-Repos) anlegen, ändern und archivieren, Pull Requests mergen',
			[PERM.taskCreate]:
				'Aufträge an Coding-Agents geben, eigene Aufträge abbrechen, wiederholen und beantworten',
			[PERM.taskManage]: 'Alle Aufträge bearbeiten, abbrechen, wiederholen und löschen',
			[PERM.terminal]:
				'Terminal (Shell) auf einem Runner öffnen – voller Zugriff auf die Arbeitskopie und die Zugangsdaten des Runners',
			[PERM.files]: 'Dateien in den Arbeitskopien der Runner ansehen und bearbeiten',
			[PERM.runnerManage]: 'Runner freigeben, sperren und entfernen',
			[PERM.runnerConnect]:
				'Technisches Recht für Runner (nur für den API-Key eines Runners vergeben): Aufträge abholen und Ergebnisse melden',
			[PERM.accountManage]:
				'Anbieter-Konten (Abos) einstellen: Budgets, gleichzeitige Läufe, Standardmodell, Wartezeiten aufheben',
			[PERM.settingsManage]: 'Verteilung der Rollen auf Anbieter und Grenzwerte einstellen'
		},
		navigation: [
			{
				label: 'KI-Entwicklung',
				icon: 'bot',
				path: '/modules/aidev',
				permission: PERM.projectView,
				order: 85
			},
			{
				label: 'Runner & Konten',
				icon: 'server',
				path: '/modules/aidev/runners',
				permission: PERM.runnerManage,
				admin: true
			},
			{
				label: 'KI-Verteilung',
				icon: 'split',
				path: '/modules/aidev/routing',
				permission: PERM.settingsManage,
				admin: true,
				settingsPage: true
			}
		]
	},
	settings: [
		{
			key: SETTING_ROUTING,
			label: 'Verteilung der Rollen auf Anbieter',
			schema: routingSchema,
			default: DEFAULT_ROUTING,
			writePermission: PERM.settingsManage
		},
		{
			key: SETTING_LIMITS,
			label: 'Grenzwerte für Läufe',
			schema: limitsSchema,
			default: DEFAULT_LIMITS,
			writePermission: PERM.settingsManage
		}
	],
	migrations: [{ name: '0001_init', sql: m0001 }],
	jobs: aidevJobs,
	onUserDeleted,
	onDisable: async () => closeAllLive(),
	onDataReplaced: async () => closeAllLive(),
	// Reihenfolge: feste Pfade vor `:id`-Mustern (erster Treffer gewinnt)
	endpoints: [
		...runnerApiEndpoints,
		...adminEndpoints,
		...projectEndpoints,
		...taskEndpoints,
		...chatEndpoints,
		...pullEndpoints,
		...workspaceEndpoints
	]
});
