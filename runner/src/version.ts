declare const __RUNNER_VERSION__: string | undefined;

/** Version des Runners (beim Bauen aus `package.json` eingesetzt) */
export const RUNNER_VERSION: string =
	typeof __RUNNER_VERSION__ === 'string' ? __RUNNER_VERSION__ : '0.5.0-dev';
