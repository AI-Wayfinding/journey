import rules from '@ai-wayfinding/rules';
import type { List } from '@ai-wayfinding/rules';

import { canonical } from './log.js';
import type { AgeIdentity } from './keys.js';
import { PRIVATE_FORMAT, PRIVATE_SLOT_BYTES, copyPrivateIdentity, copyPrivateHeader, mergePrivateViews, privateBytesHash, privateHash, privateObject, privateShape, privateSyncDue, privateCopies, privateCapacity, privateAccess, signPrivateHeader, verifyPrivateHeader } from './private.js';
import type { PrivateHeader, PrivateCheckpoint, PrivateView, PrivateCopyState } from './private.js';
import { verifyPrivateBundle } from './private-transfer.js';
import type { PrivateBundle, PrivateBundleOptions } from './private-transfer.js';
import { PRIVATE_CHUNK_BYTES, PRIVATE_HEADER_BYTES, privateEncode as encode, openPrivateFrame, openPrivateSlot, privateDecode, privatePlainBytes, privatePlainValue, privateRandomBytes, sealPrivateFrame, sealPrivateSlot } from './private-crypto.js';

export interface VaultWire { token: string; frame: string | null; slots: { index: number; ciphertext: string }[] }
export interface VaultPatch { token: string; frame: string; slots: { index: number; ciphertext: string }[] }
export interface VaultTransport { read(indices: readonly number[] | 'all'): Promise<VaultWire>; commit(patch: VaultPatch): Promise<{ token: string }> }
export interface VaultCache { read(): Promise<VaultCacheRecord | null>; commit(expected: string | null, value: VaultCacheRecord): Promise<void> }
export interface VaultCacheRecord { token: string; frame: string; slots: string[]; checkpoint: PrivateCheckpoint }
export interface VaultDirectory { branches: number[][]; initialized: number[] }
interface VaultFrame { header: PrivateHeader; root: string; directory: VaultDirectory }
export interface VaultOptions extends PrivateBundleOptions {
  identity: AgeIdentity; signingKey: CryptoKey; transport: VaultTransport; cache?: VaultCache;
  /** Trusted out-of-band input from a paired device. No pairing UI is implied. */
  paired?: PrivateCheckpoint; now?: () => number; randomOrder?: () => number[];
}
const list = (xs: readonly number[]): List<bigint> => xs.reduceRight<List<bigint>>((tail, n) => ({ $: 'Con', head: BigInt(n), tail }), { $: 'Nil' });
export function selectPrivateSlots(dirty: readonly number[], order: readonly number[]): number[] {
  if ([...dirty, ...order].some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid private slot candidate');
  const selected = rules.private_slots(list(dirty), list(order)), result: number[] = [];
  for (let row = selected; row.$ === 'Con'; row = row.tail) result.unshift(Number(row.head));
  if (result.length !== 2) throw new Error('Private sync requires two slots'); return result;
}
export function randomPrivateSlotOrder(): number[] {
  const values = Array.from({ length: 64 }, (_, i) => i);
  for (let i = 63; i > 0; i--) {
    let sample: number; const range = i + 1, limit = Math.floor(0x100000000 / range) * range;
    do { sample = crypto.getRandomValues(new Uint32Array(1))[0]!; } while (sample >= limit);
    const j = sample % range; [values[i], values[j]] = [values[j]!, values[i]!];
  }
  return values;
}
function directory(value: unknown): VaultDirectory {
  if (!privateObject(value) || !privateShape(value, ['branches', 'initialized']) || !Array.isArray(value.branches) || !Array.isArray(value.initialized)) throw new Error('Invalid private directory');
  const slot = (n: unknown): n is number => Number.isInteger(n) && Number(n) >= 0 && Number(n) < 64;
  if (!value.initialized.every(slot) || new Set(value.initialized).size !== value.initialized.length || value.branches.some(b => !Array.isArray(b) || !b.length || !b.every(slot))) throw new Error('Invalid private directory slots');
  const branches = value.branches.map(b => (b as number[]).slice()), used = branches.flat();
  if (new Set(used).size !== used.length || used.some(i => !(value.initialized as number[]).includes(i))) throw new Error('Invalid private live references');
  return { branches, initialized: value.initialized.slice() as number[] };
}
async function contents(hashes: string[], root: string, dir: VaultDirectory): Promise<string> { return privateHash({ slots: hashes, root, directory: dir }); }
async function decodeFrame(value: string, options: VaultOptions): Promise<VaultFrame> {
  const parsed = await openPrivateFrame(value, options.identity, options.trust.author.recipient);
  if (!privateObject(parsed) || !privateShape(parsed, ['header', 'root', 'directory']) || typeof parsed.root !== 'string') throw new Error('Invalid private vault frame');
  privateDecode(parsed.root, 32);
  const header = copyPrivateHeader(parsed.header as PrivateHeader), dir = directory(parsed.directory);
  if (await contents(header.slots, parsed.root, dir) !== header.contentsHash) throw new Error('Private complete contents digest mismatch');
  return { header, root: parsed.root, directory: dir };
}
export async function validateVaultCache(value: VaultCacheRecord, options: VaultOptions): Promise<VaultCacheRecord> {
  if (!privateObject(value) || !privateShape(value, ['token', 'frame', 'slots', 'checkpoint']) || !/^[a-f0-9]{64}$/.test(value.token) || typeof value.frame !== 'string' || !Array.isArray(value.slots) || value.slots.length !== 64) throw new Error('Invalid private cache');
  const frame = await decodeFrame(value.frame, options);
  // A scheduled two-slot fetch can leave other cached slots behind the signed
  // head. Such bytes are unavailable until their signed digest matches, never
  // decrypted or rendered. The checkpoint must still advance atomically.
  for (const slot of value.slots) privateDecode(slot, PRIVATE_SLOT_BYTES);
  const verified = await verifyPrivateHeader(frame.header, options.trust, { checkpoint: value.checkpoint, paired: options.paired, contentsHash: frame.header.contentsHash });
  if (verified.decision === 'merge' || canonical(verified.checkpoint.head) !== canonical(value.checkpoint.head) || verified.checkpoint.version !== value.checkpoint.version || canonical(verified.checkpoint.prev) !== canonical(value.checkpoint.prev)) throw new Error('Private cache checkpoint conflict');
  return { token: value.token, frame: value.frame, slots: value.slots.slice(), checkpoint: verified.checkpoint };
}
export async function verifyVaultCacheAdvance(previous: VaultCacheRecord, next: VaultCacheRecord, options: VaultOptions): Promise<void> {
  const frame = await decodeFrame(next.frame, options);
  const checked = await verifyPrivateHeader(frame.header, options.trust, { checkpoint: previous.checkpoint, contentsHash: frame.header.contentsHash });
  if (checked.decision === 'merge') throw new Error('Private cache fork must be merged');
}
async function readBranches(frame: VaultFrame, slots: string[], hashes: string[], options: VaultOptions): Promise<{ bundle: PrivateBundle; view: PrivateView }[] | null> {
  if (frame.directory.branches.flat().some(i => hashes[i] !== frame.header.slots[i])) return null;
  const result: { bundle: PrivateBundle; view: PrivateView }[] = [], root = privateDecode(frame.root, 32);
  try {
    for (const branch of frame.directory.branches) {
      const chunks: Uint8Array[] = [];
      try {
        for (const i of branch) chunks.push(await openPrivateSlot(root, options.trust.vault, i, slots[i]!));
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        try { result.push(await verifyPrivateBundle(privatePlainValue(bytes), { ...options, historical: true })); } finally { bytes.fill(0); }
      } finally { for (const chunk of chunks) chunk.fill(0); }
    }
    return result;
  } finally { root.fill(0); }
}
function bundleForCopies(copies: PrivateCopyState[], sources: PrivateBundle[]): PrivateBundle {
  const first = sources[0]!, ids = new Set(copies.map(c => c.copy));
  const live = new Set(copies.filter(c => !c.deleted).flatMap(c => c.records.flatMap(r => (r.body.blobs as { id: string }[] | undefined) ?? []).map(b => b.id)));
  const all = new Set(copies.flatMap(c => c.records.flatMap(r => (r.body.blobs as { id: string }[] | undefined) ?? []).map(b => b.id)));
  const keys = new Map(sources.flatMap(b => b.copyKeys).filter(k => ids.has(k.copy)).map(k => [k.copy, k]));
  for (const source of sources) for (const key of source.copyKeys) if (ids.has(key.copy) && keys.get(key.copy)!.key !== key.key) throw new Error('Private fork copy key conflict');
  const histories = new Map(sources.flatMap(b => b.authorityHistories).map(h => [canonical(h), h]));
  const blobs = new Map(sources.flatMap(b => b.blobs).filter(b => live.has(b.descriptor.id)).map(b => [b.descriptor.id, b]));
  return { format: PRIVATE_FORMAT, version: 1, vault: first.vault, author: copyPrivateIdentity(first.author), scope: 'author-backup', authorityHistories: [...histories.values()], records: copies.flatMap(c => c.records), payloads: copies.flatMap(c => c.payloads), copyKeys: [...keys.values()], blobs: [...blobs.values()], unavailableDeletedBlobs: [...all].filter(id => !live.has(id)).sort() };
}
/** One controller per open journey. Only scheduled ticks write to the network. */
export class PrivateVault {
  private slots: string[] = [];
  private hashes: string[] = [];
  private current: VaultFrame | null = null;
  private checkpoint: PrivateCheckpoint | undefined;
  private token = '';
  private cachedHead: string | null = null;
  private pending = new Map<number, Uint8Array>();
  private pendingBranches: number[][] | null = null;
  private last = -Infinity;
  private active = true;
  private busy = false;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private verifiedBranches: { bundle: PrivateBundle; view: PrivateView }[] = [];
  private available = false;
  private merging = false;
  private staging = false;
  constructor(private readonly options: VaultOptions) {}
  get freshness(): 'paired' | 'unverified' { return this.checkpoint?.freshness ?? 'unverified'; }
  get retainedCheckpoint(): PrivateCheckpoint | undefined { return this.checkpoint ? { vault: this.checkpoint.vault, author: copyPrivateIdentity(this.checkpoint.author), version: this.checkpoint.version, head: this.checkpoint.head, prev: this.checkpoint.prev, freshness: this.checkpoint.freshness } : undefined; }
  get branches(): readonly { bundle: PrivateBundle; view: PrivateView }[] { this.assertOpen(); if (!this.available) throw new Error('Private vault history is still synchronizing'); return structuredClone(this.verifiedBranches.map(b => ({ bundle: b.bundle }))).map((b, i) => ({ bundle: b.bundle, view: this.verifiedBranches[i]!.view })); }
  private assertOpen(): void { if (!this.active) throw new Error('Private vault is locked'); }
  private alive(generation: number): void { this.assertOpen(); if (generation !== this.generation) throw new Error('Private vault operation cancelled'); }
  private async refreshBranches(): Promise<void> {
    if (!this.current) { this.verifiedBranches = []; this.available = true; return; }
    const generation = this.generation, result = await readBranches(this.current, this.slots, this.hashes, this.options);
    this.alive(generation);
    this.available = result !== null; this.verifiedBranches = result ?? [];
  }
  async open(): Promise<void> {
    this.assertOpen(); if (this.slots.length) return;
    const generation = this.generation;
    const cached = await this.options.cache?.read(); this.alive(generation);
    if (cached) {
      const checked = await validateVaultCache(cached, this.options); this.alive(generation);
      const frame = await decodeFrame(checked.frame, this.options); this.alive(generation);
      this.current = frame; this.checkpoint = checked.checkpoint; this.cachedHead = checked.checkpoint.head;
      this.token = checked.token; this.slots = checked.slots;
    } else {
      if (this.options.historical) throw new Error('Offline private vault requires a retained cache');
      const wire = await this.options.transport.read('all'); this.alive(generation);
      if (!/^[a-f0-9]{64}$/.test(wire.token) || wire.slots.length !== 64 || wire.slots.some((s, i) => s.index !== i || !privateShape(s, ['index', 'ciphertext']))) throw new Error('Invalid private full fetch');
      this.slots = wire.slots.map(s => { privateDecode(s.ciphertext, PRIVATE_SLOT_BYTES); return s.ciphertext; }); this.token = wire.token;
      if (wire.frame) {
        const frame = await decodeFrame(wire.frame, this.options);
        const hashes = await Promise.all(this.slots.map(s => privateBytesHash(privateDecode(s))));
        if (canonical(hashes) !== canonical(frame.header.slots)) throw new Error('Private full contents digest mismatch');
        const checked = await verifyPrivateHeader(frame.header, this.options.trust, { paired: this.options.paired, contentsHash: frame.header.contentsHash });
        if (checked.decision === 'merge') throw new Error('Private fork requires verified local history');
        this.alive(generation); this.current = frame; this.checkpoint = checked.checkpoint;
      } else if (this.options.paired) throw new Error('Private vault rollback');
    }
    const hashes = await Promise.all(this.slots.map(s => privateBytesHash(privateDecode(s)))); this.alive(generation); this.hashes = hashes;
    await this.refreshBranches(); this.alive(generation); if (!this.options.historical) await this.sync(true);
  }
  start(): void { this.assertOpen(); if (!this.options.historical && !this.timer) this.timer = setInterval(() => { void this.tick().catch(() => { /* Retry only on the next fixed interval. */ }); }, 300000); }
  private writable(bundle: PrivateBundle): void {
    if (this.options.historical) throw new Error('Offline private vault is read-only');
    const copies = [...new Set(bundle.records.map(r => r.copy))];
    for (const copy of copies) {
      const record = bundle.records.find(r => r.copy === copy)!;
      const context = this.options.contexts?.find(c => c.journey === record.authority.journey), session = this.options.sessions?.find(s => s.binding.journey === record.authority.journey && canonical(s.identity) === canonical(this.options.trust.author));
      if (!context || !session || !privateAccess(context, this.options.trust.author, session, true)) throw new Error('Private vault requires current write authority');
    }
  }
  private async stageBranches(bundles: PrivateBundle[]): Promise<void> {
    const generation = this.generation, verified: PrivateBundle[] = [];
    for (const bundle of bundles) { this.writable(bundle); verified.push((await verifyPrivateBundle(bundle, { ...this.options, historical: true })).bundle); this.alive(generation); }
    const bytes = verified.map(privatePlainBytes), live = new Set(this.current?.directory.branches.flat() ?? []);
    const free = randomPrivateSlotOrder().filter(i => !live.has(i)), count = bytes.reduce((n, b) => n + Math.ceil(b.length / PRIVATE_CHUNK_BYTES), 0);
    try {
      if (count > free.length || !privateCapacity(bytes.reduce((n, b) => n + b.length, 0))) throw new Error('Private vault is full; nothing was saved');
      const next = new Map<number, Uint8Array>(), branches: number[][] = []; let offset = 0;
      for (const value of bytes) { const branch: number[] = []; for (let p = 0; p < value.length; p += PRIVATE_CHUNK_BYTES) { const slot = free[offset++]!; next.set(slot, value.slice(p, p + PRIVATE_CHUNK_BYTES)); branch.push(slot); } branches.push(branch); }
      for (const old of this.pending.values()) old.fill(0); this.pending = next; this.pendingBranches = branches;
    } finally { for (const value of bytes) value.fill(0); }
  }
  /** Copy-on-write chunks become live together, only after all have been uploaded. */
  async stage(bundle: PrivateBundle): Promise<void> {
    this.assertOpen(); if (!this.slots.length || this.busy || this.staging || !this.available) throw new Error('Private vault not ready');
    this.staging = true;
    try {
    const checked = await verifyPrivateBundle(bundle, { ...this.options, historical: true }), copies = privateCopies(checked.view);
    for (const branch of this.verifiedBranches) for (const old of privateCopies(branch.view)) {
      const next = copies.find(copy => copy.copy === old.copy);
      if (!next || canonical(next.records.slice(0, old.records.length)) !== canonical(old.records)) throw new Error('Stale private backup replacement');
    }
    await this.stageBranches([checked.bundle]);
    } finally { this.staging = false; }
  }
  async tick(): Promise<boolean> { return this.sync(false); }
  private async sync(open: boolean): Promise<boolean> {
    this.assertOpen(); const now = (this.options.now ?? Date.now)();
    if (this.options.historical || this.busy || this.staging || !privateSyncDue(open, open ? 0 : Math.max(0, now - this.last))) return false;
    this.last = now; this.busy = true; const generation = this.generation;
    try {
      const order = (this.options.randomOrder ?? randomPrivateSlotOrder)();
      const missing = this.current?.directory.branches.flat().filter(i => this.hashes[i] !== this.current!.header.slots[i]) ?? [];
      const indices = selectPrivateSlots([...this.pending.keys()], [...missing, ...order]);
      const wire = await this.options.transport.read(indices); this.alive(generation);
      if (!/^[a-f0-9]{64}$/.test(wire.token) || wire.slots.length !== 2 || wire.slots.some((s, i) => s.index !== indices[i] || !privateShape(s, ['index', 'ciphertext']))) throw new Error('Invalid private scheduled fetch');
      let remote: VaultFrame | null = null, stagingConflict = false;
      if (wire.frame) {
        remote = await decodeFrame(wire.frame, this.options);
        const checked = await verifyPrivateHeader(remote.header, this.options.trust, { checkpoint: this.checkpoint, paired: this.options.paired, contentsHash: remote.header.contentsHash });
        if (checked.decision === 'merge' && (!this.merging || !this.current || await privateHash(remote.header) !== await privateHash(this.current.header))) throw new Error('Private fork requires complete verified histories; use merge');
        stagingConflict = !!(this.current && remote.header.version !== this.current.header.version && this.pendingBranches);
        this.alive(generation); if (!this.merging) this.checkpoint = checked.checkpoint;
        // Once a newer head is verified, old decoded branches are no longer a
        // current view, even if the subsequent upload fails.
        if (!this.merging && this.current && await privateHash(this.current.header) !== checked.checkpoint.head) {
          this.alive(generation); this.current = remote; this.available = false; this.verifiedBranches = [];
        }
        if (this.options.cache && !this.merging && canonical(checked.checkpoint.head) !== canonical(this.cachedHead)) {
          await this.options.cache.commit(this.cachedHead, { token: wire.token, frame: wire.frame!, slots: this.slots.slice(), checkpoint: checked.checkpoint }); this.alive(generation); this.cachedHead = checked.checkpoint.head;
        }
        if (stagingConflict) {
          for (const bytes of this.pending.values()) bytes.fill(0); this.pending.clear(); this.pendingBranches = null;
          // Continue the scheduled dummy commit: a conflict must not disclose
          // whether there was a pending private save by changing traffic shape.
        }
      } else if (this.checkpoint || this.options.paired) throw new Error('Private vault rollback');
      const rootText = remote?.root ?? encode(privateRandomBytes(32)), root = privateDecode(rootText, 32);
      const dir = directory(remote?.directory ?? { branches: [], initialized: [] });
      const slots = this.slots.slice(), hashes = remote?.header.slots.slice() ?? this.hashes.slice();
      const patchSlots: VaultPatch['slots'] = [];
      try {
        for (const row of wire.slots) {
          if (await privateBytesHash(privateDecode(row.ciphertext, PRIVATE_SLOT_BYTES)) !== hashes[row.index]) throw new Error('Private fetched slot digest mismatch');
          const plain = this.pending.get(row.index) ?? (dir.initialized.includes(row.index) ? await openPrivateSlot(root, this.options.trust.vault, row.index, row.ciphertext) : new Uint8Array());
          const cipher = await sealPrivateSlot(root, this.options.trust.vault, row.index, plain);
          if (!this.pending.has(row.index)) plain.fill(0);
          slots[row.index] = cipher; hashes[row.index] = await privateBytesHash(privateDecode(cipher)); patchSlots.push({ index: row.index, ciphertext: cipher });
          if (!dir.initialized.includes(row.index)) dir.initialized.push(row.index);
        }
      } finally { root.fill(0); }
      if (this.pendingBranches && [...this.pending.keys()].every(i => indices.includes(i))) dir.branches = this.pendingBranches.map(b => b.slice());
      const header = await signPrivateHeader({ format: PRIVATE_FORMAT, v: 1, vault: this.options.trust.vault, author: copyPrivateIdentity(this.options.trust.author), version: (remote?.header.version ?? 0) + 1, prev: remote ? await privateHash(remote.header) : null, contentsHash: await contents(hashes, rootText, dir), slots: hashes }, this.options.signingKey);
      const frame = await sealPrivateFrame({ header, root: rootText, directory: dir }, this.options.trust.author.recipient);
      const checked = await verifyPrivateHeader(header, this.options.trust, { checkpoint: this.checkpoint, contentsHash: header.contentsHash });
      this.alive(generation); const committed = await this.options.transport.commit({ token: wire.token, frame, slots: patchSlots }); this.alive(generation);
      if (!/^[a-f0-9]{64}$/.test(committed.token)) throw new Error('Invalid private commit token');
      this.current = { header, root: rootText, directory: dir }; this.checkpoint = checked.checkpoint; this.token = committed.token; this.slots = slots;
      const hashesAfterCommit = await Promise.all(slots.map(s => privateBytesHash(privateDecode(s)))); this.alive(generation); this.hashes = hashesAfterCommit;
      for (const i of indices) { this.pending.get(i)?.fill(0); this.pending.delete(i); }
      if (!this.pending.size) { this.pendingBranches = null; this.merging = false; }
      await this.refreshBranches(); this.alive(generation);
      if (this.options.cache) { await this.options.cache.commit(this.cachedHead, { token: this.token, frame, slots, checkpoint: checked.checkpoint }); this.alive(generation); this.cachedHead = checked.checkpoint.head; }
      if (stagingConflict) throw new Error('Private vault concurrent staging conflict; reload before saving');
      return true;
    } finally { this.busy = false; }
  }
  /** Both complete signed histories are verified before selecting each copy.
   * Ties occupy separate encrypted branches. The next fixed tick signs version+1. */
  async merge(other: VaultCacheRecord): Promise<ReturnType<typeof mergePrivateViews>> {
    this.assertOpen(); if (this.busy || this.staging || !this.available || !this.current) throw new Error('Private vault not ready');
    this.staging = true; const generation = this.generation;
    try {
    const checked = await validateVaultCache(other, { ...this.options, paired: undefined }), remote = await decodeFrame(checked.frame, this.options);
    this.alive(generation);
    const decision = await verifyPrivateHeader(remote.header, this.options.trust, { checkpoint: this.checkpoint, contentsHash: remote.header.contentsHash });
    if (decision.decision !== 'merge' || this.verifiedBranches.length !== 1) throw new Error('Private fork merge requires complete verified branches');
    const hashes = await Promise.all(other.slots.map(s => privateBytesHash(privateDecode(s))));
    if (canonical(hashes) !== canonical(remote.header.slots)) throw new Error('Private fork contents digest mismatch');
    const branches = await readBranches(remote, other.slots, hashes, this.options);
    if (!branches || branches.length !== 1) throw new Error('Private fork merge requires complete verified branches');
    const selected = mergePrivateViews(this.verifiedBranches[0]!.view, branches[0]!.view), sources = [this.verifiedBranches[0]!.bundle, branches[0]!.bundle];
    const groups: PrivateCopyState[][] = [[]];
    for (const choice of selected) { groups[0]!.push(choice.branches[0]!); if (choice.branches.length > 1) { if (groups.length === 1) groups.push([]); groups[1]!.push(choice.branches[1]!); } }
    // Stage against the remote live references before adopting it; a full or
    // invalid merge must leave the original retained state untouched.
    const previous = this.current;
    this.alive(generation); this.current = remote;
    try { await this.stageBranches(groups.map(g => bundleForCopies(g, sources))); } catch (error) { if (this.active && generation === this.generation) this.current = previous; throw error; }
    this.alive(generation); this.slots = checked.slots.slice(); this.hashes = hashes; this.token = checked.token;
    this.merging = true;
    return selected;
    } finally { this.staging = false; }
  }
  close(): void {
    this.active = false; this.generation++; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    for (const bytes of this.pending.values()) bytes.fill(0); this.pending.clear(); this.pendingBranches = null;
    this.verifiedBranches = []; this.slots = []; this.hashes = []; this.current = null; this.available = false; this.checkpoint = undefined; this.cachedHead = null; this.token = ''; this.merging = false;
  }
}
/** Only fixed-sized opaque ciphertext and transport fields cross this boundary. */
export function encodeVaultPatch(patch: VaultPatch): Uint8Array {
  if (!privateObject(patch) || !privateShape(patch, ['token', 'frame', 'slots']) || !/^[a-f0-9]{64}$/.test(patch.token) || !Array.isArray(patch.slots) || patch.slots.length !== 2) throw new Error('Invalid opaque private patch');
  const bytes = new Uint8Array(64 + PRIVATE_HEADER_BYTES + 2 * (1 + PRIVATE_SLOT_BYTES)); bytes.set(new TextEncoder().encode(patch.token)); bytes.set(privateDecode(patch.frame, PRIVATE_HEADER_BYTES), 64);
  let offset = 64 + PRIVATE_HEADER_BYTES; const seen = new Set<number>();
  for (const slot of patch.slots) { if (!privateObject(slot) || !Number.isInteger(slot.index) || slot.index < 0 || slot.index >= 64 || seen.has(slot.index) || !privateShape(slot, ['index', 'ciphertext'])) throw new Error('Invalid opaque private slot'); seen.add(slot.index); bytes[offset++] = slot.index; bytes.set(privateDecode(slot.ciphertext, PRIVATE_SLOT_BYTES), offset); offset += PRIVATE_SLOT_BYTES; }
  return bytes;
}
export function decodeVaultPatch(bytes: Uint8Array): VaultPatch {
  if (bytes.length !== 64 + PRIVATE_HEADER_BYTES + 2 * (1 + PRIVATE_SLOT_BYTES)) throw new Error('Invalid opaque private patch size');
  const token = new TextDecoder().decode(bytes.subarray(0, 64)); if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid opaque private token');
  const frame = encode(bytes.subarray(64, 64 + PRIVATE_HEADER_BYTES)), slots: VaultPatch['slots'] = []; let offset = 64 + PRIVATE_HEADER_BYTES;
  for (let i = 0; i < 2; i++) { const index = bytes[offset++]!; if (index >= 64 || slots.some(s => s.index === index)) throw new Error('Invalid opaque private slot'); slots.push({ index, ciphertext: encode(bytes.subarray(offset, offset + PRIVATE_SLOT_BYTES)) }); offset += PRIVATE_SLOT_BYTES; }
  return { token, frame, slots };
}
export function decodeVaultWire(bytes: Uint8Array, indices: readonly number[] | 'all'): VaultWire {
  const wanted = indices === 'all' ? Array.from({ length: 64 }, (_, i) => i) : indices;
  if (bytes.length !== 65 + PRIVATE_HEADER_BYTES + wanted.length * (1 + PRIVATE_SLOT_BYTES) || ![0, 1].includes(bytes[64]!)) throw new Error('Invalid opaque private response');
  const token = new TextDecoder().decode(bytes.subarray(0, 64)); if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid opaque private token');
  const frame = bytes[64] ? encode(bytes.subarray(65, 65 + PRIVATE_HEADER_BYTES)) : null, slots: VaultWire['slots'] = []; let offset = 65 + PRIVATE_HEADER_BYTES;
  for (const index of wanted) { if (bytes[offset++] !== index) throw new Error('Invalid opaque private response slot'); slots.push({ index, ciphertext: encode(bytes.subarray(offset, offset + PRIVATE_SLOT_BYTES)) }); offset += PRIVATE_SLOT_BYTES; }
  return { token, frame, slots };
}
