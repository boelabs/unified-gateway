/** Small single-consumer async queue shared by persistent upstream transports. */
export class AsyncQueue<T> implements AsyncIterable<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<{
		resolve: (value: IteratorResult<T>) => void;
		reject: (reason: unknown) => void;
	}> = [];
	private failure: unknown;
	private ended = false;

	push(value: T): void {
		if (this.ended || this.failure !== undefined) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ done: false, value });
		else this.values.push(value);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const waiter of this.waiters.splice(0))
			waiter.resolve({ done: true, value: undefined });
	}

	fail(error: unknown): void {
		if (this.ended || this.failure !== undefined) return;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	next(): Promise<IteratorResult<T>> {
		if (this.values.length > 0)
			return Promise.resolve({ done: false, value: this.values.shift()! });
		if (this.failure !== undefined) return Promise.reject(this.failure);
		if (this.ended) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve, reject) =>
			this.waiters.push({ resolve, reject }),
		);
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this;
	}
}
