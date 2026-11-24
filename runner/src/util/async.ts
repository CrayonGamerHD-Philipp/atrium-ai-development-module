/** Kleine Hilfen für Nebenläufigkeit: Warteschlange als AsyncIterable, Mutex, Pausen. */

/** Unbegrenzte Warteschlange, die als `AsyncIterable` gelesen wird (ein Leser). */
export class AsyncQueue<T> implements AsyncIterable<T> {
	private items: T[] = [];
	private waiters: ((r: IteratorResult<T>) => void)[] = [];
	private ended = false;

	push(item: T): void {
		if (this.ended) return;
		const w = this.waiters.shift();
		if (w) w({ value: item, done: false });
		else this.items.push(item);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
	}

	get isEnded(): boolean {
		return this.ended;
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const item = this.items.shift();
				if (item !== undefined || this.items.length > 0)
					return Promise.resolve({ value: item as T, done: false });
				if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
				return new Promise((resolve) => this.waiters.push(resolve));
			},
			return: () => {
				this.end();
				return Promise.resolve({ value: undefined as never, done: true });
			}
		};
	}
}

/** Gegenseitiger Ausschluss je Schlüssel (z. B. je Repository) */
export class KeyedMutex {
	private tails = new Map<string, Promise<void>>();

	async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((r) => (release = r));
		const tail = prev.then(() => current);
		this.tails.set(key, tail);
		await prev;
		try {
			return await fn();
		} finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}
}

/** Pause, die bei Abbruch sofort endet (ohne Fehler) */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});
}

/** Exponentielles Backoff mit Zufallsanteil */
export function backoffMs(attempt: number, baseMs = 500, maxMs = 30_000): number {
	const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16));
	return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/** Fehlertext ohne Stacktrace */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
