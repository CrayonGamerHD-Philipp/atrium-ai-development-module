/**
 * Version des Runners, der mit diesem Modulstand ausgeliefert wird (`runner/package.json`, GitHub-Release
 * `runner-v<Version>`). Die Runner-Seite zeigt „Update verfügbar“, wenn ein Runner eine ältere Version meldet.
 * Ein Unit-Test prüft, dass beide Werte übereinstimmen.
 */
export const RUNNER_RELEASE_VERSION = '0.6.0';
/** Download-Seite der Runner-Releases */
export const RUNNER_RELEASES_URL =
	'https://github.com/CrayonGamerHD-Philipp/atrium-ai-development-module/releases?q=runner-v';
