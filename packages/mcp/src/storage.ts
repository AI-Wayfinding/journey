/** A complete coordination record is committed with one put, never partial writes. */
export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

/** Serialize the whole read/step/write turn, including async storage and profile lookups. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  writes = 0;
  async get(key: string): Promise<unknown> { return this.data.get(key); }
  async put(key: string, value: string): Promise<void> {
    this.writes += 1;
    this.data.set(key, value);
  }
}
