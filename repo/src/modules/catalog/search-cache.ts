type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export class TtlLruCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  public constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  public get(key: string): T | null {
    const existing = this.store.get(key);
    if (!existing) {
      return null;
    }

    if (existing.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }

    this.store.delete(key);
    this.store.set(key, existing);
    return existing.value;
  }

  public set(key: string, value: T): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs
    });

    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.store.delete(oldestKey);
    }
  }

  public clear(): void {
    this.store.clear();
  }
}
