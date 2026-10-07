import { expect, type Page, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { importSigningKey, newId, sealControlLabels, signControlProof, unwrapJourneyKey, verifyControlProofs } from '@ai-wayfinding/core';
import type { ControlProof, Envelope, JsonObject, Member } from '@ai-wayfinding/core';

export const headers = { 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1' };
export async function createTrip(page: Page, name = 'Artifacts journey') {
  await page.getByRole('link', { name: 'Start a journey' }).first().click();
  await page.getByLabel('Journey name').fill(name); await page.getByRole('button', { name: 'Create journey' }).click();
  const recovery = (await page.locator('#recovery-copy-value').textContent())!;
  await page.getByLabel('I have saved my recovery key somewhere safe.').check(); await page.getByRole('button', { name: 'Continue to journey' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const path = new URL(page.url()).pathname, id = path.split('/').at(-1)!;
  return { path, id, recovery };
}
export async function principal(page: Page, id: string): Promise<string> {
  const data = await (await page.request.get('/v1/journeys', { headers })).json();
  return data.journeys.find((j: { id: string }) => j.id === id).principal;
}
/** Read the test person's existing non-extractable browser wrapping key, not a production test hook. */
export async function personSecrets(page: Page): Promise<{ identity: string; signing: string }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('wayfinding-person-keys', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const saved = await new Promise<{ key: CryptoKey; sealed: { identity: string; signing: string } }>((resolve, reject) => { const r = db.transaction('person').objectStore('person').get('current'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close();
    const decrypt = async (field: string, value: string) => {
      const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode('wayfinding/person-keys/v1/' + field) }, saved.key, bytes.slice(12)));
    };
    return { identity: await decrypt('identity', saved.sealed.identity), signing: JSON.parse(await decrypt('signing', saved.sealed.signing)).privateKey as string };
  });
}
export async function controls(page: Page, id: string): Promise<{ proof: ControlProof; envelope: Envelope }[]> {
  const response = await page.request.get(`/v1/journeys/${id}/log`, { headers: { ...headers, 'X-Principal': await principal(page, id) } });
  expect(response.ok()).toBeTruthy(); return (await response.json()).log.map((row: { proof: ControlProof; envelope: Envelope }) => ({ proof: row.proof, envelope: row.envelope }));
}
export async function change(page: Page, id: string, type: string, body: JsonObject, extraHeaders: Record<string, string> = {}) {
  const actor = await principal(page, id), secrets = await personSecrets(page), rows = await controls(page, id);
  const verified = await verifyControlProofs(rows.map(c => c.proof), rows.map(c => c.envelope), { journey: id, creator: rows[0]!.proof.body.creator as Member });
  if (!verified.ok) throw new Error(verified.error.message);
  const wraps = await (await page.request.get(`/v1/journeys/${id}/wraps/me`, { headers: { ...headers, 'X-Principal': actor } })).json();
  const own = wraps.wraps.find((w: { epoch: number }) => w.epoch === verified.state.currentEpoch);
  const key = await unwrapJourneyKey({ epoch: own.epoch, recipient: actor, ciphertext: own.wrap }, secrets.identity);
  const at = new Date().toISOString(), entry = { v: 1 as const, seq: verified.state.lastSeq + 1, prev: verified.state.lastHash, at, actor, type, body };
  const envelope = await sealControlLabels(entry, { id: newId(), journey: id, seq: entry.seq, epoch: key.epoch, createdAt: at }, key);
  const proof = await signControlProof(entry, envelope, id, await importSigningKey(secrets.signing));
  const response = await page.request.post(`/v1/journeys/${id}/log`, { headers: { ...headers, ...extraHeaders, 'X-Wayfinding': '1', Origin: new URL(page.url()).origin, 'X-Principal': actor }, data: { control: { proof, envelope } } });
  expect(response.status(), await response.text()).toBe(201);
}
export async function joinTrip(owner: Page, guest: Page, path: string) {
  await owner.goto(path + '/members'); await owner.getByRole('button', { name: 'Copy link instead' }).click();
  await guest.goto((await owner.locator('#invite-copy-value').textContent())!); await guest.getByRole('button', { name: 'Ask to join' }).click();
  await expect(guest.getByRole('heading', { name: 'Waiting for a member to let you in' })).toBeVisible();
  await owner.reload(); await owner.getByRole('button', { name: 'Let in' }).click();
  await expect(guest).toHaveURL(new RegExp(path + '$'));
}
export async function downloadBytes(download: Download): Promise<Buffer> {
  const path = await download.path(); if (!path) throw new Error('No local download'); return readFile(path);
}
