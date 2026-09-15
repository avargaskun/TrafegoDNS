const noop = () => {};

class SingleFlight<A extends unknown[], T> {
  declare fn: (...args: A) => T | PromiseLike<T>;
  declare current: Promise<T> | null;
  declare queued: Promise<T> | null;
  declare queuedArgs: A | null;

  constructor(fn: (...args: A) => T | PromiseLike<T>) {
    this.fn = fn;
    this.current = null;
    this.queued = null;
    this.queuedArgs = null;
  }

  get running(): boolean {
    return this.current !== null;
  }

  run(...args: A): Promise<T> {
    // `current` clears one microtask before the queued rerun starts, so a pending rerun must also block a new start.
    if (!this.current && !this.queued) return this._start(args);
    this.queuedArgs = args;
    if (!this.queued) {
      this.queued = this.current!.then(noop, noop).then(() => {
        const queuedArgs = this.queuedArgs;
        this.queued = null;
        this.queuedArgs = null;
        return this._start(queuedArgs!);
      });
    }
    return this.queued;
  }

  _start(args: A): Promise<T> {
    const p = Promise.resolve().then(() => this.fn(...args));
    this.current = p;
    p.then(noop, noop).then(() => {
      if (this.current === p) this.current = null;
    });
    return p;
  }
}

export { SingleFlight };
