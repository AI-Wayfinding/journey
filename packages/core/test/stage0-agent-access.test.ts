import { expect, it } from 'vitest';
import { canReadContent, canWriteContent, renewAgentEntry } from '../src/index.js';
import { person, agent, genesis, append, state, rejected } from './stage0-fixture.js';
it('inherits live adding-person access and ignores historical agent scope', async () => {
  const guide = await person(), owner = await person(), writer = await agent(owner.member.id), reader = await agent(owner.member.id, 'read');
  let log = await append(await genesis(guide), guide, 'member.add', { member: owner.member, grants: [], kind: 'person' });
  for (const bot of [writer, reader]) log = await append(log, owner, 'member.add', { member: bot.member, grants: [], kind: 'agent' });
  expect(canWriteContent(await state(log), writer.member.id)).toBe(true);
  for (const role of ['read-only', 'read-write']) {
    log = await append(log, guide, 'member.role', { member: owner.member.id, role });
    expect(canWriteContent(await state(log), writer.member.id)).toBe(role === 'read-write');
    expect(canWriteContent(await state(log), reader.member.id)).toBe(role === 'read-write');
  }
  await rejected(await append(log, guide, 'member.role', { member: reader.member.id, role: 'read-write' }));
  const renewed = await renewAgentEntry(await state(log), reader.member.id, owner.member.id, owner.key, '2028-01-01T00:00:00.000Z');
  log.push(renewed); expect(canWriteContent(await state(log), reader.member.id)).toBe(true);
  const current = await state(log); current.members[owner.member.id]!.member.expiresAt = '2000-01-01T00:00:00.000Z';
  expect(canReadContent(current, writer.member.id)).toBe(false);
  delete current.members[owner.member.id]; expect(canReadContent(current, reader.member.id)).toBe(false);
  log = await append(log, guide, 'member.remove', { member: owner.member.id });
  expect(canReadContent(await state(log), writer.member.id)).toBe(false);
});
