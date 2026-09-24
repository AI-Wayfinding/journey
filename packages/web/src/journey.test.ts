import { describe, expect, it } from 'vitest';
import type { ProtocolRecord } from '@ai-wayfinding/core';
import { itemVersions } from './journey.js';

const item = (id: string, replaces?: string): ProtocolRecord => ({ type: 'item', typeVersion: 1, body: { id, itemType: 'note', title: id, body: id, author: 'person', authoredBy: 'human', created: '2026-08-22T00:00:00Z', tags: [], ...(replaces ? { replaces } : {}) } });
describe('decrypted item view', () => {
  it('follows multiple edits to the original item, keeps comments and deletion together', () => {
    const records: ProtocolRecord[] = [item('first'), item('second', 'first'), item('third', 'second'), { type: 'comment', typeVersion: 1, body: { id: 'comment', item: 'first', onVersion: 'first', author: 'person', authoredBy: 'human', at: '2026-08-22T00:00:00Z', body: 'Reply' } }];
    expect(itemVersions(records)).toMatchObject([{ root: 'first', item: { title: 'third' }, versions: [{ id: 'first' }, { id: 'second' }, { id: 'third' }], comments: [{ type: 'comment' }], deleted: false }]);
    records.push({ type: 'delete', typeVersion: 1, body: { target: 'first' } });
    expect(itemVersions(records)[0]?.deleted).toBe(true);
  });
  it('does not display an orphan edit as a new item', () => {
    expect(itemVersions([item('orphan', 'missing')])).toEqual([]);
  });
});
