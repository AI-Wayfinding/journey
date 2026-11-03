/** A journey record and its next deadline are committed in the same storage transaction. */
export interface StorageTurn {
  get(key: string): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface KeyValueStorage extends StorageTurn {
  transaction<T>(operation: (storage: StorageTurn) => Promise<T>): Promise<T>;
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
  alarmAt: number | undefined;
  async transaction<T>(operation: (storage: StorageTurn) => Promise<T>): Promise<T> {
    const before = new Map(this.data), writes = this.writes, alarm = this.alarmAt;
    try { return await operation(this); }
    catch (error) {
      this.data.clear(); for (const [key, value] of before) this.data.set(key, value);
      this.writes = writes; this.alarmAt = alarm; throw error;
    }
  }
  async setAlarm(time: number): Promise<void> { this.alarmAt = time; }
  async deleteAlarm(): Promise<void> { this.alarmAt = undefined; }
  async get(key: string): Promise<unknown> { return this.data.get(key); }
  async put(key: string, value: string): Promise<void> {
    this.writes += 1;
    this.data.set(key, value);
  }
}
