import { describe, expect, it } from 'vitest';
import { generateJourneyKey, MAX_ARTIFACT_PAYLOAD_BYTES, MAX_BLOB_BYTES, newId, openBlob, sealBlob, validateArtifactPayload, validateBlobDescriptor, verifyBlob } from '../src/index.js';
import { asBuffer, decode, encode, utf8 } from '../src/codec.js';
import { canonical } from '../src/log.js';

const meta = () => ({ journey: newId(), id: newId(), epoch: 1 });
const hash = async (bytes: Uint8Array) => encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(bytes))));

describe('Stage 1 portable binary blobs', () => {
  for (const size of [0, MAX_BLOB_BYTES - 1, MAX_BLOB_BYTES]) {
    it(`round-trips ${size} raw bytes with exact descriptor and ciphertext lengths`, async () => {
      const raw = new Uint8Array(size);
      for (let i = 0; i < size; i++) raw[i] = i % 251;
      const key = generateJourneyKey(), metadata = meta();
      const { descriptor, ciphertext } = await sealBlob(raw, metadata, key);
      expect(MAX_BLOB_BYTES).toBe(25_000_000);
      expect(validateBlobDescriptor(descriptor)).toBe(true);
      expect(descriptor).toEqual({ v: 1, ...metadata, size, ciphertextSize: size + 16, nonce: descriptor.nonce, digest: await hash(ciphertext) });
      expect(ciphertext).toBeInstanceOf(Uint8Array);
      expect(ciphertext.byteLength).toBe(size + 16);
      const verified = await verifyBlob(ciphertext, descriptor);
      expect(verified).toEqual(descriptor);
      expect(verified).not.toBe(descriptor);
      const opened = await openBlob(ciphertext, descriptor, key);
      expect(opened.byteLength).toBe(size);
      expect(await hash(opened)).toBe(await hash(raw));
    }, 30_000);
  }

  it('rejects limit-plus-one actual raw bytes before encryption, even with a claimed size', async () => {
    const key = generateJourneyKey();
    await expect(sealBlob(new Uint8Array(MAX_BLOB_BYTES + 1), meta(), key)).rejects.toThrow('Invalid blob raw size');
    await expect(sealBlob(new Uint8Array(MAX_BLOB_BYTES + 1), { ...meta(), size: 0 } as never, key)).rejects.toThrow('Invalid blob raw size');
  });

  it('uses fresh nonces, only the supplied byte view, and the documented canonical AAD', async () => {
    const key = generateJourneyKey(), metadata = meta(), raw = new Uint8Array([99, 0, 128, 255, 77]).subarray(1, 4);
    const first = await sealBlob(raw, metadata, key), second = await sealBlob(raw, metadata, key);
    expect(first.descriptor.nonce).not.toBe(second.descriptor.nonce);
    expect(first.descriptor.digest).not.toBe(second.descriptor.digest);
    expect(await openBlob(first.ciphertext, first.descriptor, key)).toEqual(new Uint8Array([0, 128, 255]));
    const imported = await crypto.subtle.importKey('raw', asBuffer(key.key), 'AES-GCM', false, ['decrypt', 'encrypt']);
    const additionalData = asBuffer(utf8(canonical({ v: 1, ...metadata, size: raw.byteLength })));
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(decode(first.descriptor.nonce)), additionalData, tagLength: 128 }, imported, asBuffer(first.ciphertext));
    expect(new Uint8Array(opened)).toEqual(raw);
    const foreign = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(decode(first.descriptor.nonce)), additionalData, tagLength: 128 }, imported, asBuffer(raw)));
    expect(await openBlob(foreign, { ...first.descriptor, digest: await hash(foreign) }, key)).toEqual(raw);
  });

  it('rejects malformed metadata and unknown caller fields rather than emitting them', async () => {
    const key = generateJourneyKey(), metadata = meta();
    for (const changed of [{ ...metadata, journey: 'bad' }, { ...metadata, id: 'bad' }, ...[0, -1, 1.5, NaN, Infinity].map(epoch => ({ ...metadata, epoch })), { ...metadata, filename: '../secret' }, { journey: metadata.journey, epoch: 1 }]) {
      await expect(sealBlob(new Uint8Array(), changed as never, key)).rejects.toThrow();
    }
    const { descriptor, ciphertext } = await sealBlob(new Uint8Array([1]), metadata, key);
    const changes = [
      { ...descriptor, v: 2 }, { ...descriptor, journey: 'bad' }, { ...descriptor, id: 'bad' },
      ...[0, -1, 1.5, NaN, Infinity].map(epoch => ({ ...descriptor, epoch })),
      ...[-1, 1.5, MAX_BLOB_BYTES + 1].map(size => ({ ...descriptor, size, ciphertextSize: size + 16 })),
      ...['', '!', encode(new Uint8Array(11)), encode(new Uint8Array(13))].map(nonce => ({ ...descriptor, nonce })),
      ...['', '!', encode(new Uint8Array(31)), encode(new Uint8Array(33))].map(digest => ({ ...descriptor, digest })),
      { ...descriptor, ciphertextSize: 1 }, { ...descriptor, grants: ['members.manage'] },
      Object.fromEntries(Object.entries(descriptor).filter(([field]) => field !== 'digest')),
    ];
    for (const changed of changes) {
      await expect(verifyBlob(ciphertext, changed)).rejects.toThrow('Invalid blob descriptor');
      await expect(openBlob(ciphertext, changed, key)).rejects.toThrow('Invalid blob descriptor');
    }
    const verified = await verifyBlob(ciphertext, descriptor);
    expect(Object.keys(verified).sort()).toEqual(['ciphertextSize', 'digest', 'epoch', 'id', 'journey', 'nonce', 'size', 'v']);
    expect(verified).not.toHaveProperty('grants');
  });

  it('authenticates journey, blob, epoch, size and nonce independently of the digest', async () => {
    const key = generateJourneyKey(), { descriptor, ciphertext } = await sealBlob(new Uint8Array([1, 2, 3]), meta(), key);
    for (const changed of [{ ...descriptor, journey: newId() }, { ...descriptor, id: newId() }, { ...descriptor, epoch: 2 }, { ...descriptor, nonce: encode(new Uint8Array(12)) }]) {
      await expect(openBlob(ciphertext, changed, { epoch: changed.epoch, key: key.key })).rejects.toThrow();
    }
    // Keep the altered size, actual length and digest consistent: only AAD must reject this.
    const longer = new Uint8Array(ciphertext.length + 1); longer.set(ciphertext);
    await expect(openBlob(longer, { ...descriptor, size: 4, ciphertextSize: 20, digest: await hash(longer) }, key)).rejects.toThrow();
    await expect(openBlob(ciphertext, descriptor, { epoch: 2, key: key.key })).rejects.toThrow('Wrong journey key epoch');
    await expect(openBlob(ciphertext, descriptor, { epoch: 1, key: new Uint8Array(31) })).rejects.toThrow('Wrong journey key epoch');
    await expect(openBlob(ciphertext, descriptor, generateJourneyKey())).rejects.toThrow();
    await expect(sealBlob(new Uint8Array(), { ...meta(), epoch: 2 }, key)).rejects.toThrow('Wrong journey key epoch');
  });

  it('rejects wrong digests, changed binary bytes, truncation and oversized ciphertext', async () => {
    const key = generateJourneyKey(), { descriptor, ciphertext } = await sealBlob(new Uint8Array([1, 2, 3]), meta(), key);
    const changed = ciphertext.slice(); changed[0] ^= 1;
    for (const bytes of [ciphertext.subarray(0, ciphertext.length - 1), new Uint8Array(ciphertext.length + 1), new Uint8Array(MAX_BLOB_BYTES + 17)]) {
      await expect(verifyBlob(bytes, descriptor)).rejects.toThrow('Invalid blob ciphertext size');
      await expect(openBlob(bytes, descriptor, key)).rejects.toThrow('Invalid blob ciphertext size');
    }
    for (const [bytes, desc] of [[changed, descriptor], [ciphertext, { ...descriptor, digest: encode(new Uint8Array(32)) }]] as const) {
      await expect(verifyBlob(bytes, desc)).rejects.toThrow('Invalid blob ciphertext digest');
      await expect(openBlob(bytes, desc, key)).rejects.toThrow('Invalid blob ciphertext digest');
    }
    await expect(openBlob(changed, { ...descriptor, digest: await hash(changed) }, key)).rejects.toThrow();
  });

  it('keeps the 1 MiB JSON payload cap separate from the binary limit', () => {
    const payload = { title: '', tags: [], content: { kind: 'document', markdown: '' }, attachments: [] };
    const overhead = utf8(JSON.stringify(payload)).length;
    payload.content.markdown = 'x'.repeat(MAX_ARTIFACT_PAYLOAD_BYTES - overhead);
    expect(MAX_ARTIFACT_PAYLOAD_BYTES).toBe(1_048_576);
    expect(utf8(JSON.stringify(payload))).toHaveLength(MAX_ARTIFACT_PAYLOAD_BYTES);
    expect(validateArtifactPayload(payload)).toEqual({ ok: true });
    payload.content.markdown += 'x';
    expect(validateArtifactPayload(payload).ok).toBe(false);
    payload.content.markdown = 'é'.repeat(MAX_ARTIFACT_PAYLOAD_BYTES / 2);
    expect(validateArtifactPayload(payload).ok).toBe(false);
  });
});
