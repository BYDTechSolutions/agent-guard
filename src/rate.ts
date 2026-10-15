/** A sliding-window log: remembers the time of each call inside the window. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly clock: () => number = Date.now) {}

  private prune(key: string, windowMs: number, now: number): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    const cutoff = now - windowMs;
    let drop = 0;
    while (drop < list.length && list[drop]! <= cutoff) drop++;
    if (drop) list.splice(0, drop);
    if (!list.length) this.hits.delete(key);
    return list;
  }

  /** Calls made under `key` in the last `windowMs` milliseconds. */
  count(key: string, windowMs: number): number {
    return this.prune(key, windowMs, this.clock()).length;
  }

  /**
   * Milliseconds until one more call fits, or 0 when it fits now. A call at time t
   * leaves the window at t + windowMs.
   */
  retryAfter(key: string, max: number, windowMs: number): number {
    const now = this.clock();
    const list = this.prune(key, windowMs, now);
    if (list.length < max) return 0;
    return list[list.length - max]! + windowMs - now;
  }

  /** Records one call under `key` now. */
  hit(key: string): void {
    const list = this.hits.get(key);
    if (list) list.push(this.clock());
    else this.hits.set(key, [this.clock()]);
  }

  /** Forgets every call. */
  clear(): void {
    this.hits.clear();
  }
}
