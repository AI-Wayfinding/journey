import { expect, it } from 'vitest';
import { itemDefinitions, newId, parseRecord, serializeRecord, validateItem, type RecordDefinition } from '../src/index.js';

it('validates known item bodies without restricting new itemType values', () => {
  const item = { id: newId(), itemType: 'future-kind', title: 'A', body: 'B', author: newId(), authoredBy: 'mixed', created: '2026-01-01T00:00:00Z', tags: ['x'], extension: { nested: [1, { flag: true }] } };
  expect(validateItem(item)).toEqual({ ok: true });
  expect(validateItem({ ...item, tags: [1] }).ok).toBe(false);
  expect(itemDefinitions.map(d => d.name)).toContain('comment');
});

it('preserves unknown item fields after an edit and unknown record types', () => {
  const raw = { type: 'item', typeVersion: 1, body: { id: newId(), itemType: 'position', title: 'Old', body: 'Body', author: newId(), authoredBy: 'human', created: '2026-01-01', tags: [], extension: { deep: ['unchanged'] } }, newHeader: [true, 4] };
  const parsed = parseRecord(raw);
  expect(parsed.kind).toBe('known');
  if (parsed.kind === 'known') parsed.record.body.title = 'New';
  expect(serializeRecord(parsed)).toEqual({ ...raw, body: { ...raw.body, title: 'New' } });
  const unknown = { type: 'item.future', typeVersion: 99, body: { nested: { future: true } }, flag: 7 };
  const future = parseRecord(unknown);
  expect(future.kind).toBe('unknown');
  expect(serializeRecord(future)).toEqual(unknown);
});

it('applies a registered upgrade on read while keeping unknown fields', () => {
  const definitions: RecordDefinition[] = [
    { name: 'special', version: 1, validate: () => ({ ok: true }) },
    { name: 'special', version: 2, validate: body => body.label ? { ok: true } : { ok: false, reason: 'missing label' }, upgrade: previous => ({ ...previous, label: 'new' }) },
  ];
  const parsed = parseRecord({ type: 'special', typeVersion: 1, body: { extra: { original: 1 } } }, definitions);
  expect(serializeRecord(parsed)).toEqual({ type: 'special', typeVersion: 2, body: { extra: { original: 1 }, label: 'new' } });
});
