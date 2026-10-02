import { expect, type Page } from '@playwright/test';
import { importSigningKey, newId, readControlProof, sealArtifactPayload, sealProjectPayload, signControlProof, unwrapJourneyKey, verifyControlProofs } from '@ai-wayfinding/core';
import type { ArtifactActionType, JsonObject, Member, ProjectActionType } from '@ai-wayfinding/core';
import { controls, headers, personSecrets, principal } from './stage1-fixtures.js';

export async function stored(page: Page, id: string) {
  const actor = await principal(page, id), secrets = await personSecrets(page), rows = await controls(page, id);
  const response = await page.request.get(`/v1/journeys/${id}/wraps/me`, { headers: { ...headers, 'X-Principal': actor } });
  expect(response.ok()).toBe(true);
  const wraps = (await response.json()).wraps as { epoch: number; wrap: string }[];
  const keys = await Promise.all(wraps.map(w => unwrapJourneyKey({ epoch: w.epoch, recipient: actor, ciphertext: w.wrap }, secrets.identity)));
  const checked = await verifyControlProofs(rows.map(c => c.proof), rows.map(c => c.envelope), { journey: id, creator: rows[0]!.proof.body.creator as Member }, keys);
  if (!checked.ok) throw new Error(checked.error.message);
  return { actor, rows, state: checked.state, key: keys.find(k => k.epoch === checked.state.currentEpoch)!, keys, secrets };
}
/** Deliberately bypass browser availability to supply forbidden input to the real server. */
export async function attempt(page: Page, id: string, type: ProjectActionType | ArtifactActionType, body: JsonObject, payload: JsonObject = {}) {
  const current = await stored(page, id), at = new Date().toISOString(), seq = current.state.lastSeq + 1;
  const outside = { id: newId(), journey: id, seq, epoch: current.key.epoch, createdAt: at };
  const envelope = type === 'artifact.create' || type === 'artifact.comment' || type === 'artifact.version' || type === 'artifact.delete'
    ? await sealArtifactPayload(type, body, payload, outside, current.key)
    : await sealProjectPayload(type, body, payload, outside, current.key);
  const proof = await signControlProof({ v: 1, seq, prev: current.state.lastHash, at, actor: current.actor, type, body }, envelope, id, await importSigningKey(current.secrets.signing));
  return page.request.post(`/v1/journeys/${id}/log`, { headers: { ...headers, 'X-Wayfinding': '1', Origin: 'http://localhost:18787', 'X-Principal': current.actor }, data: { control: { proof, envelope } } });
}
export async function createProjectReload(page: Page, path: string, purpose: string) {
  await page.goto(path + '/projects'); await page.getByLabel('Purpose', { exact: true }).fill(purpose);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9A-Z]+$/); await page.reload();
  await expect(page.locator('#project-purpose-text')).toHaveText(purpose);
  return { path: new URL(page.url()).pathname, id: new URL(page.url()).pathname.split('/').at(-1)! };
}
export async function participateReload(page: Page, type: 'Join' | 'Leave') {
  await page.getByRole('button', { name: type + ' project', exact: true }).click();
  await expect(page.getByRole('button', { name: (type === 'Join' ? 'Leave' : 'Join') + ' project', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: (type === 'Join' ? 'Leave' : 'Join') + ' project', exact: true })).toBeVisible();
}
export async function stateReload(page: Page, state: string) {
  await page.locator('#project-state-choice').selectOption(state); await page.getByRole('button', { name: 'Save state' }).click();
  await expect(page.locator('#project-state')).toContainText(state.replace(/-/g, ' ')); await page.reload();
  await expect(page.locator('#project-state')).toContainText(state.replace(/-/g, ' '));
}
export async function placeReload(page: Page, artifactPath: string, project = '') {
  await page.goto(artifactPath); await page.getByLabel('Place saved artifact in').selectOption(project);
  await page.getByRole('button', { name: 'Save placement' }).click();
  await expect(page.locator('#placement-history li').last()).toContainText('→ ' + (project || 'main')); await page.reload();
  await expect(page.locator('#placement-history li').last()).toContainText('→ ' + (project || 'main'));
}
export async function purposeHistory(page: Page, id: string, project: string): Promise<string[]> {
  const current = await stored(page, id);
  return Promise.all(current.rows.filter(c => c.proof.body.project === project && ['project.create', 'project.purpose'].includes(c.proof.type)).map(async c => String((await readControlProof(c.proof, c.envelope, current.keys.find(k => k.epoch === c.envelope.outside.epoch))).entry.body.purpose)));
}
