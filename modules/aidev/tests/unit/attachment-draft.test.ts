import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentDraft } from '../../pages/project/attachments.svelte';

/** Minimaler XHR-Ersatz: Antwort bzw. Fortschritt steuert der Test über `respond`/`progress` */
class FakeXhr {
	static all: FakeXhr[] = [];
	status = 0;
	responseText = '';
	responseType = '';
	withCredentials = false;
	aborted = false;
	upload: {
		onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
	} = { onprogress: null };
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	constructor() {
		FakeXhr.all.push(this);
	}
	open() {}
	send() {}
	abort() {
		this.aborted = true;
		this.onabort?.();
	}
	progress(loaded: number, total: number) {
		this.upload.onprogress?.({ lengthComputable: true, loaded, total });
	}
	respond(id: string) {
		this.status = 201;
		this.responseText = JSON.stringify({
			data: { id, name: 'a.txt', mime: 'text/plain', size: 1, createdAt: '' }
		});
		this.onload?.();
	}
}

const file = (name: string) => new File(['x'], name, { type: 'text/plain' });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AttachmentDraft: Entfernen und Verwerfen', () => {
	let deleted: string[];
	let draft: AttachmentDraft;

	beforeEach(() => {
		FakeXhr.all = [];
		deleted = [];
		vi.stubGlobal('XMLHttpRequest', FakeXhr);
		draft = new AttachmentDraft(
			() => 'p1',
			undefined,
			async (id) => {
				deleted.push(id);
			}
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	it('löscht einen fertigen Upload beim Entfernen auf dem Server', async () => {
		draft.add([file('a.txt')]);
		FakeXhr.all[0]!.respond('srv-1');
		await flush();
		expect(draft.ids).toEqual(['srv-1']);
		draft.remove(draft.items[0]!.key);
		expect(draft.items).toHaveLength(0);
		expect(deleted).toEqual(['srv-1']);
	});

	it('bricht einen laufenden Upload ab, ohne zu löschen', async () => {
		draft.add([file('a.txt')]);
		draft.remove(draft.items[0]!.key);
		await flush();
		expect(FakeXhr.all[0]!.aborted).toBe(true);
		expect(deleted).toEqual([]);
	});

	it('wartet bei vollständig gesendetem Body die Antwort ab und löscht danach', async () => {
		draft.add([file('a.txt')]);
		const xhr = FakeXhr.all[0]!;
		xhr.progress(1, 1);
		draft.remove(draft.items[0]!.key);
		expect(xhr.aborted).toBe(false);
		xhr.respond('srv-2');
		await flush();
		expect(deleted).toEqual(['srv-2']);
		expect(draft.items).toHaveLength(0);
	});

	it('discard() löscht alle fertigen Uploads, clear() nach dem Absenden keine', async () => {
		draft.add([file('a.txt'), file('b.txt')]);
		FakeXhr.all[0]!.respond('srv-a');
		FakeXhr.all[1]!.respond('srv-b');
		await flush();
		draft.clear();
		expect(deleted).toEqual([]);
		expect(draft.items).toHaveLength(0);

		draft.add([file('c.txt')]);
		FakeXhr.all[2]!.respond('srv-c');
		await flush();
		draft.discard();
		expect(deleted).toEqual(['srv-c']);
		expect(draft.items).toHaveLength(0);
	});
});
