const noop = () => {};

class SingleFlight {
  constructor(fn) {
    this.fn = fn;
    this.current = null;
    this.queued = null;
    this.queuedArgs = null;
  }

  get running() {
    return this.current !== null;
  }

  run(...args) {
    // `current` clears one microtask before the queued rerun starts, so a pending rerun must also block a new start.
    if (!this.current && !this.queued) return this._start(args);
    this.queuedArgs = args;
    if (!this.queued) {
      this.queued = this.current.then(noop, noop).then(() => {
        const queuedArgs = this.queuedArgs;
        this.queued = null;
        this.queuedArgs = null;
        return this._start(queuedArgs);
      });
    }
    return this.queued;
  }

  _start(args) {
    const p = Promise.resolve().then(() => this.fn(...args));
    this.current = p;
    p.then(noop, noop).then(() => {
      if (this.current === p) this.current = null;
    });
    return p;
  }
}

module.exports = { SingleFlight };
