// Kleiner Ersatz für die GitHub-CLI in Tests: simuliert `pr create|view|merge|list`, `repo view` und `--version`.
// Zustand in der JSON-Datei aus GH_SHIM_STATE.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const stateFile = process.env.GH_SHIM_STATE;
if (!stateFile) {
	process.stderr.write('GH_SHIM_STATE fehlt\n');
	process.exit(2);
}
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { prs: [], merges: [], calls: [] };
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const readStdin = () => {
	try {
		return readFileSync(0, 'utf8');
	} catch {
		return '';
	}
};

if (args[0] === '--version') {
	process.stdout.write('gh version 0.0.0-shim (2026-01-01)\n');
	process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'create') {
	const repo = opt('--repo');
	const head = opt('--head');
	const base = opt('--base');
	const title = opt('--title');
	const body = opt('--body-file') === '-' ? readStdin() : (opt('--body') ?? '');
	const existing = state.prs.find((p) => p.repo === repo && p.head === head && p.state === 'OPEN');
	if (existing) {
		save();
		process.stderr.write(`a pull request for branch "${head}" into branch "${base}" already exists:\n${existing.url}\n`);
		process.exit(1);
	}
	const number = state.prs.length + 1;
	const url = `https://github.com/${repo}/pull/${number}`;
	state.prs.push({ number, repo, head, base, title, body, url, state: 'OPEN', autoMerge: false });
	save();
	process.stdout.write(`${url}\n`);
	process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'view') {
	const repo = opt('--repo');
	const pr = state.prs.find((p) => p.repo === repo && (p.head === args[2] || String(p.number) === args[2]));
	save();
	if (!pr) {
		process.stderr.write(`no pull requests found for branch "${args[2]}"\n`);
		process.exit(1);
	}
	process.stdout.write(JSON.stringify({ number: pr.number, url: pr.url }) + '\n');
	process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'merge') {
	const repo = opt('--repo');
	const pr = state.prs.find((p) => p.repo === repo && String(p.number) === args[2]);
	if (!pr) {
		save();
		process.stderr.write('pull request not found\n');
		process.exit(1);
	}
	if (args.includes('--auto')) pr.autoMerge = true;
	else pr.state = 'MERGED';
	state.merges.push({ number: pr.number, args });
	save();
	process.stdout.write(`✓ Pull request #${pr.number} ${args.includes('--auto') ? 'will be automatically merged' : 'merged'}\n`);
	process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'list') {
	const repo = opt('--repo');
	save();
	const list = state.prs
		.filter((p) => p.repo === repo)
		.map((p) => ({
			number: p.number,
			title: p.title,
			headRefName: p.head,
			state: p.state,
			isDraft: false,
			mergeable: 'MERGEABLE',
			statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
			autoMergeRequest: p.autoMerge ? { mergeMethod: 'SQUASH' } : null,
			url: p.url,
			additions: 3,
			deletions: 1,
			createdAt: '2026-11-24T10:00:00Z',
			updatedAt: '2026-11-24T10:05:00Z'
		}));
	process.stdout.write(JSON.stringify(list) + '\n');
	process.exit(0);
}

if (args[0] === 'repo' && args[1] === 'view') {
	save();
	process.stdout.write(JSON.stringify({ defaultBranchRef: { name: 'main' }, viewerPermission: 'WRITE' }) + '\n');
	process.exit(0);
}

save();
process.stderr.write(`gh-shim: unbekannter Aufruf ${args.join(' ')}\n`);
process.exit(1);
