import { Refused, type RelayCommand, type ToolData } from './commands.ts';
import type { KeyValueStorage } from './storage.ts';

/** Structural subset of R2Bucket, also implemented by the in-memory test store. */
export interface BlobStore {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<unknown>;
}
export class MemoryBlobs implements BlobStore {
  readonly data = new Map<string, Uint8Array>();
  writes = 0;
  async put(key: string, value: Uint8Array): Promise<void> { this.writes++; this.data.set(key, value.slice()); }
  async delete(key: string): Promise<void> { this.writes++; this.data.delete(key); }
  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const value = this.data.get(key);
    return value ? { async arrayBuffer() { return new Uint8Array(value).buffer; } } : null;
  }
}
export function decodeBytes(data: string, maximum: number): Uint8Array {
  let raw: string;
  try { raw = atob(data); } catch { throw new Refused('Invalid relay base64'); }
  if (raw.length > maximum || btoa(raw) !== data) throw new Refused('Invalid or oversized relay bytes');
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
export function encodeBytes(bytes: Uint8Array): string {
  let raw = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(raw);
}
interface Message { sequence: number; epoch: number; kind: 'handshake' | 'application'; sender: string; key: string; size: number }
interface Log { sequence: number; epoch: number; messages: Message[] }
function objectKey(parts: (string | number)[]): string { return JSON.stringify(parts); }

/** Authorization is the host's responsibility; includes every successfully stored version. */
export async function deleteArtifactBlobs(storage: KeyValueStorage, blobs: BlobStore, groupId: string, artifactId: string): Promise<void> {
  const indexKey = objectKey(['artifactVersions', groupId, artifactId]);
  const raw = await storage.get(indexKey);
  const versions: number[] = typeof raw === 'string' ? JSON.parse(raw) : [];
  for (const version of versions) await blobs.delete(objectKey(['artifact', groupId, artifactId, version]));
  await storage.put(indexKey, '[]');
}

/** Called inside the host's serialized authorization turn, never before authorization. */
export async function relay(storage: KeyValueStorage, blobs: BlobStore | undefined, sender: string, command: RelayCommand): Promise<ToolData> {
  if (!blobs) throw new Refused('Relay blob storage is not configured');
  const input = command.input;
  const logKey = objectKey(['mls', input.groupId]);
  if (command.tool === 'mls_message_post' || command.tool === 'mls_message_fetch') {
    const raw = await storage.get(logKey);
    const log: Log = typeof raw === 'string' ? JSON.parse(raw) as Log : { sequence: 0, epoch: 0, messages: [] };
    if (command.tool === 'mls_message_post') {
      const { epoch, kind, data } = command.input;
      if (epoch < log.epoch) throw new Refused('MLS epoch regression refused');
      // Keep the complete metadata record below the Durable Object 128 KiB value limit.
      if (log.sequence >= Number.MAX_SAFE_INTEGER || log.messages.length >= 128) throw new Refused('Relay PoC log capacity (128 messages) reached');
      const bytes = decodeBytes(data, 1024 * 1024);
      const sequence = log.sequence + 1;
      const key = objectKey(['mls', input.groupId, sequence]);
      await blobs.put(key, bytes);
      log.messages.push({ sequence, epoch, kind, sender, key, size: bytes.length });
      log.sequence = sequence; log.epoch = epoch;
      await storage.put(logKey, JSON.stringify(log));
      return { sequence };
    }
    const { since, limit } = command.input;
    const messages: ToolData[] = [];
    let size = 0, cursor = since;
    for (const message of log.messages.filter(m => m.sequence > since).slice(0, limit)) {
      if (size + message.size > 4 * 1024 * 1024) break;
      const blob = await blobs.get(message.key);
      if (!blob) throw new Refused('MLS message bytes not found');
      messages.push({ sequence: message.sequence, epoch: message.epoch, kind: message.kind, sender: message.sender, data: encodeBytes(new Uint8Array(await blob.arrayBuffer())) });
      size += message.size; cursor = message.sequence;
    }
    return { messages, cursor };
  }
  if (command.tool === 'artifact_blob_delete') {
    await deleteArtifactBlobs(storage, blobs, input.groupId, command.input.artifactId);
    return { deleted: true };
  }
  const { artifactId, version } = command.input;
  const key = objectKey(['artifact', input.groupId, artifactId, version]);
  const existing = await blobs.get(key);
  if (command.tool === 'artifact_blob_get') {
    if (!existing) throw new Refused('Artifact ciphertext not found');
    return { data: encodeBytes(new Uint8Array(await existing.arrayBuffer())) };
  }
  if (existing) throw new Refused('Artifact ciphertext version already exists');
  const bytes = decodeBytes(command.input.data, 10 * 1024 * 1024);
  const indexKey = objectKey(['artifactVersions', input.groupId, artifactId]);
  const raw = await storage.get(indexKey);
  const versions: number[] = typeof raw === 'string' ? JSON.parse(raw) : [];
  if (!versions.includes(version)) versions.push(version);
  await blobs.put(key, bytes);
  await storage.put(indexKey, JSON.stringify(versions));
  return { stored: true };
}
