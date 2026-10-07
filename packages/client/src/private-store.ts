import { mkdir, open, readFile, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, openIdentity, sealIdentity, privateHash, validPrivateId, validateVaultCache, verifyVaultCacheAdvance } from '@ai-wayfinding/core';
import type { VaultCache, VaultCacheRecord, VaultOptions } from '@ai-wayfinding/core';
import { PrivateVault, privateBinding, privateAgentAudience, privateIdentity, privateVaultOwner, sealVaultAgentWrap } from '@ai-wayfinding/core';
import type { PrivateContext, Member } from '@ai-wayfinding/core';

/** Shared person-vault adapter: backfill each live agent on every open. */
export async function openPersonPrivateVault(options: VaultOptions, context: PrivateContext, delivery: {
  agents(): Promise<Member[]>;
  put(agent: string, ciphertext: string): Promise<void>;
}): Promise<PrivateVault> {
  const actor = options.actor ?? options.trust.author;
  const person = privateVaultOwner(context, actor).id;
  if (canonical(privateIdentity(privateVaultOwner(context, actor))) !== canonical(options.trust.author)) throw new Error('Person vault binding mismatch');
  const controller = new PrivateVault(options); rememberNodePrivateVault(controller);
  try {
    await controller.open();
    for (const member of await delivery.agents()) {
      if (member.kind !== 'agent') continue;
      const recipient = privateIdentity(member);
      if (!privateAgentAudience(context, options.trust.author, recipient)) continue;
      const agent = privateBinding(context, recipient).principal;
      const ciphertext = await sealVaultAgentWrap({ journey: context.journey, person, agent, vault: options.trust.vault, author: options.trust.author, recipient }, controller.agentContentIdentity, options.signingKey, actor.kind === 'agent' ? { writer: actor, context } : undefined);
      await delivery.put(agent, ciphertext);
    }
    return controller;
  } catch (error) { controller.close(); throw error; }
}

/** One encrypted immutable cache file, selected by an independently encrypted
 * checkpoint pointer. A crash before pointer rename leaves the old checkpoint;
 * a crash after it leaves a complete referenced cache. No plaintext is written. */
const controllers = new Set<{ close(): void }>();
export function rememberNodePrivateVault(controller: { close(): void }): void { controllers.add(controller); }
export function closeNodePrivateVaults(): void { for (const controller of controllers) controller.close(); controllers.clear(); }
export class NodePrivateStore implements VaultCache {
  private folder: string;
  constructor(root: string, readonly vault: string, private options: VaultOptions) {
    if (!validPrivateId(vault)) throw new Error('Invalid private cache binding');
    this.folder = join(root, vault);
  }
  private async pointer(): Promise<{ head: string; file: string } | null> {
    let raw: string;
    try { raw = await readFile(join(this.folder, 'checkpoint.age'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const value: unknown = JSON.parse(await openIdentity(raw, [this.options.identity]));
    if (!value || typeof value !== 'object' || !('head' in value) || !('file' in value)) throw new Error('Invalid private checkpoint');
    const { head, file } = value;
    if (typeof head !== 'string' || typeof file !== 'string' || !/^[a-f0-9]{64}\.vault$/.test(file) || Object.keys(value).sort().join(',') !== 'file,head') throw new Error('Invalid private checkpoint');
    return { head, file };
  }
  async read(): Promise<VaultCacheRecord | null> {
    const pointer = await this.pointer(); if (!pointer) return null;
    const record = JSON.parse(await readFile(join(this.folder, pointer.file), 'utf8')) as { token: string; frame: string; slots: string[]; checkpoint: string };
    if (!record || Object.keys(record).sort().join(',') !== 'checkpoint,frame,slots,token') throw new Error('Invalid private cache fields');
    const checkpoint = JSON.parse(await openIdentity(record.checkpoint, [this.options.identity]));
    const checked = await validateVaultCache({ token: record.token, frame: record.frame, slots: record.slots, checkpoint }, this.options);
    if (canonical(checked.checkpoint.head) !== canonical(pointer.head)) throw new Error('Private cache checkpoint mismatch'); return checked;
  }
  private async atomic(file: string, bytes: string): Promise<void> {
    const path = join(this.folder, '.' + crypto.randomUUID()); const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); await handle.close(); await rename(path, join(this.folder, file)); }
    finally { await handle.close().catch(() => {}); await rm(path, { force: true }); }
  }
  async commit(expected: string | null, input: VaultCacheRecord): Promise<void> {
    const value = await validateVaultCache(input, this.options);
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    const lock = join(this.folder, '.lock'); await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error('Private cache concurrent commit'); });
    try {
      const pointer = await this.pointer(); if (canonical(pointer?.head ?? null) !== canonical(expected)) throw new Error('Private cache concurrent checkpoint');
      const prior = await this.read(); if (prior) await verifyVaultCacheAdvance(prior, value, this.options);
      const checkpoint = await sealIdentity(canonical(value.checkpoint), [(this.options.actor ?? this.options.trust.author).recipient]);
      const bytes = canonical({ token: value.token, frame: value.frame, slots: value.slots, checkpoint });
      const file = Buffer.from(await privateHash(bytes), 'base64').toString('hex') + '.vault';
      await this.atomic(file, bytes);
      await this.atomic('checkpoint.age', await sealIdentity(canonical({ head: value.checkpoint.head, file }), [(this.options.actor ?? this.options.trust.author).recipient]));
      const dir = await open(this.folder, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      // Cleanup runs under the same lock and preserves the sole live reference.
      for (const name of await readdir(this.folder)) if (/^[a-f0-9]{64}\.vault$/.test(name) && name !== file) await rm(join(this.folder, name));
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
}
