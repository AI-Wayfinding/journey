import { ARTIFACT_FORMAT, MAX_BLOB_BYTES, artifactTypeHash, canonical, canWriteContent, newId, openBlob, readArtifactPayload, sealArtifactPayload, sealBlob, signControlProof, verifyControlProofs } from '@ai-wayfinding/core';
import type { ArtifactActionType, ArtifactAttachment, ArtifactPayload, ArtifactState, BlobDescriptor, JsonObject, Member } from '@ai-wayfinding/core';
import { ApiError, api, currentKey, INTERFACE_VERSION, verifiedJourney } from './journey.js';
import type { JourneyContext, SignedControl } from './journey.js';
import { plainError } from './messages.js';

export interface ArtifactVersion { id: string; actor: string; at: string; payload: ArtifactPayload }
export interface ArtifactComment { id: string; actor: string; at: string; text: string; onVersion?: string }
export interface ArtifactView { state: ArtifactState; versions: ArtifactVersion[]; comments: ArtifactComment[] }
/** The context's signed chain has already been verified; encrypted content never supplies attribution. */
export async function artifactViews(ctx: JourneyContext): Promise<ArtifactView[]> {
  currentKey(ctx);
  const views: ArtifactView[] = [];
  for (const state of Object.values(ctx.state.artifacts?.items ?? {})) {
    if (state.deleted) continue;
    const versions: ArtifactVersion[] = [], comments: ArtifactComment[] = [];
    for (const { proof, envelope } of ctx.controls) {
      if (proof.body.artifact !== state.id || proof.type === 'artifact.delete') continue;
      const key = ctx.epochs.get(envelope.outside.epoch);
      if (!key) throw new Error('An earlier artifact key is unavailable.');
      const record = await readArtifactPayload(proof, envelope, key);
      if (proof.type === 'artifact.comment') comments.push({ id: String(proof.body.comment), actor: proof.actor, at: proof.at, text: String(record.body.text), ...(proof.body.onVersion === undefined ? {} : { onVersion: String(proof.body.onVersion) }) });
      else versions.push({ id: String(proof.body.version), actor: proof.actor, at: proof.at, payload: record.body as ArtifactPayload });
    }
    views.push({ state, versions, comments });
  }
  currentKey(ctx);
  return views;
}
export function artifactText(payload: ArtifactPayload): string {
  const c = payload.content;
  switch (c.kind) {
    case 'skill': return c.skill;
    case 'prompt': return c.text;
    case 'document': return c.markdown;
    case 'link': return `${c.url}\n${c.summary}\n${c.notes}`;
    case 'data': return c.text ?? 'Download the original data file.';
    default: return 'Download the original file.';
  }
}
async function writer(ctx: JourneyContext): Promise<JourneyContext> {
  const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
  if (!canWriteContent(latest.state, ctx.principal)) throw new Error('This journey is read-only for you, or a key update is pending.');
  return latest;
}
async function binaryResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    throw new ApiError(plainError(error?.error?.code, response.status), response.status);
  }
  return response;
}
function blobHeaders(ctx: JourneyContext): Record<string, string> {
  return { 'X-Client-Version': INTERFACE_VERSION, 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': ARTIFACT_FORMAT, 'X-Principal': ctx.principal };
}
/** Reject oversized files before reading or staging; upload only binary ciphertext. */
export async function uploadAttachment(ctx: JourneyContext, file: File, path?: string): Promise<ArtifactAttachment> {
  if (file.size > MAX_BLOB_BYTES) throw new Error('Files can be at most 25,000,000 bytes (25 MB).');
  const latest = await writer(ctx);
  const stage = await api<{ id: string; journey: string; epoch: number; size: number }>(`/journeys/${ctx.id}/blobs`, 'POST', { size: file.size }, ctx.principal);
  if (stage.journey !== ctx.id || stage.size !== file.size || stage.epoch !== latest.state.currentEpoch) throw new Error('Journey key changed. Reload before uploading.');
  const encrypted = await sealBlob(new Uint8Array(await file.arrayBuffer()), { journey: ctx.id, id: stage.id, epoch: stage.epoch }, currentKey(latest));
  await binaryResponse(await fetch(`/v1/journeys/${ctx.id}/blobs/${stage.id}`, { method: 'PUT', credentials: 'same-origin', headers: { ...blobHeaders(ctx), 'X-Wayfinding': '1', 'Content-Type': 'application/octet-stream', 'X-Blob-Descriptor': JSON.stringify(encrypted.descriptor) }, body: new Uint8Array(encrypted.ciphertext).buffer }));
  return { blob: encrypted.descriptor, name: file.name, mime: file.type || 'application/octet-stream', ...(path === undefined ? {} : { path }) };
}
export async function attachmentBytes(ctx: JourneyContext, attachment: ArtifactAttachment, signal?: AbortSignal): Promise<Uint8Array> {
  const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
  const descriptor: BlobDescriptor = attachment.blob;
  if (descriptor.journey !== ctx.id) throw new Error('Wrong attachment journey.');
  const response = await binaryResponse(await fetch(`/v1/journeys/${ctx.id}/blobs/${descriptor.id}`, { credentials: 'same-origin', cache: 'no-store', signal, headers: blobHeaders(ctx) }));
  if (canonical(JSON.parse(response.headers.get('X-Blob-Descriptor') ?? 'null')) !== canonical(descriptor)) throw new Error('Attachment descriptor mismatch.');
  const key = latest.epochs.get(descriptor.epoch);
  currentKey(latest);
  if (!key) throw new Error('Attachment key unavailable.');
  const bytes = await openBlob(new Uint8Array(await response.arrayBuffer()), descriptor, key);
  currentKey(latest);
  return bytes;
}
export function downloadAttachment(name: string, bytes: Uint8Array): void {
  const href = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'application/octet-stream' }));
  const link = document.createElement('a'); link.href = href;
  link.download = name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '_') || 'attachment';
  link.click(); setTimeout(() => URL.revokeObjectURL(href), 5000);
}
async function commit(ctx: JourneyContext, type: ArtifactActionType, body: JsonObject, payload: JsonObject): Promise<void> {
  const latest = await writer(ctx), key = currentKey(latest);
  const at = new Date().toISOString(), seq = latest.state.lastSeq + 1;
  const envelope = await sealArtifactPayload(type, body, payload, { id: newId(), journey: ctx.id, seq, epoch: key.epoch, createdAt: at }, key);
  const proof = await signControlProof({ v: 1, seq, prev: latest.state.lastHash, at, actor: ctx.principal, type, body }, envelope, ctx.id, ctx.keys.signingPrivateKey);
  const controls: SignedControl[] = [...latest.controls, { proof, envelope }];
  const checked = await verifyControlProofs(controls.map(c => c.proof), controls.map(c => c.envelope), { journey: ctx.id, creator: controls[0]!.proof.body.creator as Member }, [...latest.epochs.values()]);
  if (!checked.ok) throw new Error(checked.error.message === 'Artifact predecessor, attribution or reference conflict' ? 'Something changed while you were working. Reload and try again.' : checked.error.message);
  await api(`/journeys/${ctx.id}/log`, 'POST', { control: { proof, envelope } }, ctx.principal);
}
export async function saveArtifact(ctx: JourneyContext, payload: ArtifactPayload, previous?: { id: string; author: string; head: string }): Promise<string> {
  const id = previous?.id ?? newId();
  await commit(ctx, previous ? 'artifact.version' : 'artifact.create', { format: ARTIFACT_FORMAT, artifact: id, author: previous?.author ?? ctx.principal, actor: ctx.principal, version: newId(), typeHash: await artifactTypeHash(payload.content.kind), blobs: payload.attachments.map(a => a.blob), ...(previous ? { predecessor: previous.head } : {}) }, payload);
  return id;
}
export async function commentArtifact(ctx: JourneyContext, view: ArtifactView, text: string): Promise<void> {
  await commit(ctx, 'artifact.comment', { format: ARTIFACT_FORMAT, artifact: view.state.id, author: view.state.author, actor: ctx.principal, comment: newId(), onVersion: view.state.head }, { text });
}
export async function deleteArtifact(ctx: JourneyContext, view: ArtifactView): Promise<void> {
  await commit(ctx, 'artifact.delete', { format: ARTIFACT_FORMAT, artifact: view.state.id, author: view.state.author, actor: ctx.principal }, {});
}
