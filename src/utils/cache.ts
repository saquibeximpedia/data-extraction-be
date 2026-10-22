/**
 * Small in-memory cache for promises with a time-to-live.
 * Concurrent callers for the same key share one request; failures are not cached.
 * `maxEntries` bounds memory for large values: the oldest entry is dropped first.
 */
export class TtlCache<T> {
  private entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = Infinity
  ) {}

  public get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [k, e] of this.entries) if (now - e.at >= this.ttlMs) this.entries.delete(k);

    const hit = this.entries.get(key);
    if (hit) return hit.value;

    const value = load();
    this.entries.set(key, { at: now, value });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }
}
