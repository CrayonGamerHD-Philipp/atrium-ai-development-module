import { describe, expect, it } from 'vitest';
import { branchFromRef, parseRepoInput, repoKey } from '../../pages/projects/repo-input';

describe('parseRepoInput', () => {
	it.each([
		['owner/repo', 'owner', 'repo'],
		['  owner/repo  ', 'owner', 'repo'],
		['owner/repo.git', 'owner', 'repo'],
		['owner/repo/', 'owner', 'repo'],
		['https://github.com/ACME/Widgets', 'ACME', 'Widgets'],
		['https://github.com/ACME/Widgets.git', 'ACME', 'Widgets'],
		['https://www.github.com/acme/widgets/', 'acme', 'widgets'],
		['http://github.com/acme/my.repo_x-1', 'acme', 'my.repo_x-1'],
		['github.com/acme/widgets', 'acme', 'widgets'],
		['git@github.com:acme/widgets.git', 'acme', 'widgets'],
		['ssh://git@github.com/acme/widgets.git', 'acme', 'widgets'],
		['HTTPS://GitHub.com/acme/widgets', 'acme', 'widgets'],
		['https://github.com/acme/widgets?tab=readme', 'acme', 'widgets'],
		['https://github.com/acme/widgets#readme', 'acme', 'widgets'],
		['https://github.com/acme/widgets/pulls', 'acme', 'widgets']
	])('%s → %s/%s', (input, owner, name) => {
		expect(parseRepoInput(input)).toMatchObject({ owner, name });
	});

	it('liest den Branch aus /tree/<branch>', () => {
		expect(parseRepoInput('https://github.com/acme/widgets/tree/develop')).toEqual({
			owner: 'acme',
			name: 'widgets',
			ref: 'develop'
		});
		expect(
			parseRepoInput('https://github.com/acme/widgets/tree/feature%2Fx/src?plain=1')?.ref
		).toBe('feature/x/src');
		expect(parseRepoInput('https://github.com/acme/widgets/tree/')?.ref).toBeNull();
		expect(parseRepoInput('acme/widgets')?.ref).toBeNull();
	});

	it.each([
		'',
		'   ',
		'widgets',
		'owner/',
		'/repo',
		'owner/repo/extra',
		'owner/repo?x=1',
		'owner/re po',
		'https://gitlab.com/acme/widgets',
		'https://github.com/acme',
		'https://github.com/./widgets',
		'https://github.com/acme/..',
		'acme/wid:gets',
		`acme/${'x'.repeat(101)}`
	])('lehnt %j ab', (input) => {
		expect(parseRepoInput(input)).toBeNull();
	});
});

describe('repoKey', () => {
	it('normalisiert auf owner/repo', () => {
		expect(repoKey(parseRepoInput('git@github.com:acme/widgets.git')!)).toBe('acme/widgets');
	});
});

describe('branchFromRef', () => {
	const branches = ['main', 'develop', 'feature/x'];
	it('nimmt den längsten bekannten Präfix', () => {
		expect(branchFromRef('develop', branches)).toBe('develop');
		expect(branchFromRef('feature/x/src/lib', branches)).toBe('feature/x');
		expect(branchFromRef('main/docs', branches)).toBe('main');
	});
	it('liefert null ohne Treffer', () => {
		expect(branchFromRef(null, branches)).toBeNull();
		expect(branchFromRef('unknown', branches)).toBeNull();
		expect(branchFromRef('feature', branches)).toBeNull();
		expect(branchFromRef('main', [])).toBeNull();
	});
});
