import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathError, resolveInJail } from '../src/paths.ts';

let tmp: string;
let root: string;
let outside: string;
let canSymlinkFile = true;

beforeAll(async () => {
	tmp = await mkdtemp(path.join(os.tmpdir(), 'aidev-paths-'));
	root = path.join(tmp, 'root');
	outside = path.join(tmp, 'outside');
	await mkdir(path.join(root, 'src'), { recursive: true });
	await mkdir(path.join(root, '.git'), { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(path.join(root, 'src', 'a.ts'), 'x');
	await writeFile(path.join(outside, 'secret.txt'), 'geheim');
	// Verzeichnis-Link nach außen (Junction funktioniert unter Windows ohne Adminrechte)
	await symlink(outside, path.join(root, 'link-out'), process.platform === 'win32' ? 'junction' : 'dir');
	await symlink(path.join(root, 'src'), path.join(root, 'link-in'), process.platform === 'win32' ? 'junction' : 'dir');
	try {
		await symlink(path.join(outside, 'secret.txt'), path.join(root, 'file-out'), 'file');
	} catch {
		canSymlinkFile = false;
	}
});

afterAll(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe('resolveInJail', () => {
	it('löst normale Pfade auf', async () => {
		const r = await resolveInJail(root, 'src/a.ts');
		expect(r.rel).toBe('src/a.ts');
		expect(r.abs.endsWith(path.join('src', 'a.ts'))).toBe(true);
		expect((await resolveInJail(root, '')).rel).toBe('');
		expect((await resolveInJail(root, './src//a.ts')).rel).toBe('src/a.ts');
		expect((await resolveInJail(root, 'src\\a.ts')).rel).toBe('src/a.ts');
	});

	it('erlaubt neue Dateien in neuen Ordnern', async () => {
		const r = await resolveInJail(root, 'neu/ordner/datei.txt', { write: true });
		expect(r.rel).toBe('neu/ordner/datei.txt');
	});

	it.each(['../outside/secret.txt', 'src/../../outside', '/etc/passwd', 'C:/Windows/win.ini', 'C:\\x', '\\\\server\\share'])(
		'lehnt %s ab',
		async (p) => {
			await expect(resolveInJail(root, p)).rejects.toBeInstanceOf(PathError);
		}
	);

	it('lehnt Symlinks nach außen ab, erlaubt Symlinks nach innen', async () => {
		await expect(resolveInJail(root, 'link-out/secret.txt')).rejects.toBeInstanceOf(PathError);
		await expect(resolveInJail(root, 'link-out')).rejects.toBeInstanceOf(PathError);
		await expect(resolveInJail(root, 'link-out/neu.txt', { write: true })).rejects.toBeInstanceOf(PathError);
		expect((await resolveInJail(root, 'link-in/a.ts')).rel).toBe('link-in/a.ts');
	});

	it('lehnt Datei-Symlinks nach außen ab', async () => {
		if (!canSymlinkFile) return;
		await expect(resolveInJail(root, 'file-out')).rejects.toBeInstanceOf(PathError);
	});

	it('verbietet Schreiben in .git, erlaubt Lesen', async () => {
		await expect(resolveInJail(root, '.git/config', { write: true })).rejects.toBeInstanceOf(PathError);
		await expect(resolveInJail(root, 'sub/.GIT/hooks/x', { write: true })).rejects.toBeInstanceOf(PathError);
		expect((await resolveInJail(root, '.git')).rel).toBe('.git');
	});

	it('lehnt NUL-Zeichen ab', async () => {
		await expect(resolveInJail(root, 'a\0b')).rejects.toBeInstanceOf(PathError);
	});
});
