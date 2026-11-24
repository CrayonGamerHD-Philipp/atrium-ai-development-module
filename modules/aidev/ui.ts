import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/ProjectsPage.svelte'),
		runners: () => import('./pages/RunnersPage.svelte'),
		routing: () => import('./pages/RoutingPage.svelte'),
		'projects/:id': () => import('./pages/ProjectPage.svelte'),
		'projects/:id/workspace': () => import('./pages/WorkspacePage.svelte'),
		'projects/:id/tasks/:taskId': () => import('./pages/TaskPage.svelte')
	},
	fullBleedRoutes: ['projects/:id/workspace'],
	dashboardWidgets: [
		{
			id: 'active-runs',
			title: 'KI-Agents',
			description: 'Laufende Coding-Agents und offene Rückfragen',
			order: 60,
			size: 'md',
			permission: 'aidev.project.view',
			component: () => import('./pages/widgets/ActiveRunsWidget.svelte')
		}
	]
} satisfies ModuleUi;
