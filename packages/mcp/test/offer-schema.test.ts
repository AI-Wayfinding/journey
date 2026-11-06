import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateData } from '../src/offers.ts';

test('offers: schema checks property types, nested arrays and enums rather than just required keys', () => {
  const schema = { type: 'object', properties: { question: { type: 'string', minLength: 2 }, choices: { type: 'array', items: { type: 'integer', minimum: 1 } }, mode: { enum: ['short', 'long'] } }, required: ['question'], additionalProperties: false };
  validateData({ question: 'ok', choices: [1], mode: 'short' }, schema, 'input');
  for (const input of [{ question: 7 }, { question: 'x' }, { question: 'ok', choices: [0] }, { question: 'ok', choices: ['1'] }, { question: 'ok', mode: 'other' }, { question: 'ok', hidden: true }]) {
    assert.throws(() => validateData(input, schema, 'input'));
  }
});


test('offers: unsupported schema constraints are refused rather than silently ignored', async () => {
  const { offerDefinitionSchema } = await import('../src/offers.ts');
  for (const extra of [{ $ref: 'https://example.test/schema' }, { pattern: '^safe$' }, { allOf: [] }, { type: ['object', 'null'] }]) {
    assert.equal(offerDefinitionSchema.safeParse({ id: 'unsafe', name: 'Unsafe', description: '', inputSchema: { type: 'object', ...extra } }).success, false);
  }
  assert.equal(offerDefinitionSchema.safeParse({ id: 'unsafe', name: 'Unsafe', description: '', inputSchema: { type: 'object', properties: { question: { type: ['string'] } } } }).success, false);
});
