import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createMlsGroup} from '../src/mls/ts-mls.ts'
import type {MlsGroup} from '../src/mls/group.ts'

const bytes = (text: string) => new TextEncoder().encode(text)
async function member(name: string): Promise<MlsGroup> {
  return createMlsGroup(bytes(name))
}
async function pair() {
  const alice = await member('alice')
  const bob = await member('bob')
  await alice.create(bytes('journey'))
  const added = await alice.add(bob.keyPackage())
  assert.ok(added.welcome)
  await bob.processHandshake(added.welcome)
  return {alice, bob}
}

test('mls creates a group and reports the unaudited implementation', async () => {
  const alice = await member('alice')
  assert.equal(alice.epoch, null)
  assert.equal(alice.audited, false)
  assert.deepEqual(alice.library, {name: 'ts-mls', version: '1.6.4'})
  await alice.create(bytes('journey'))
  assert.equal(alice.epoch, 0)
  await assert.rejects(alice.create(bytes('again')))
})

test('mls add and seal/open exchange real binary messages in both directions', async () => {
  const {alice, bob} = await pair()
  assert.equal(alice.epoch, 1)
  assert.equal(bob.epoch, 1)
  const plaintext = new Uint8Array([0, 255, 1, 0, 128])
  const ciphertext = await alice.seal(plaintext)
  assert.notDeepEqual(ciphertext, plaintext)
  assert.deepEqual(await bob.open(ciphertext), plaintext)
  assert.deepEqual(await alice.open(await bob.seal(bytes('reply'))), bytes('reply'))
  await assert.rejects(bob.open(ciphertext))
})

test('mls later joiner opens new traffic but cannot open earlier traffic', async () => {
  const {alice, bob} = await pair()
  const before = await alice.seal(bytes('before carol'))
  assert.deepEqual(await bob.open(before), bytes('before carol'))
  const carol = await member('carol')
  const added = await bob.add(carol.keyPackage())
  assert.ok(added.welcome)
  await alice.processHandshake(added.commit)
  await carol.processHandshake(added.welcome)
  assert.equal(carol.epoch, 2)
  await assert.rejects(carol.open(before))
  const after = await alice.seal(bytes('after carol'))
  assert.deepEqual(await carol.open(after), bytes('after carol'))
  assert.deepEqual(await bob.open(after), bytes('after carol'))
})

test('mls removed member really fails to decrypt while remaining members succeed', async () => {
  const {alice, bob} = await pair()
  const carol = await member('carol')
  const added = await alice.add(carol.keyPackage())
  assert.ok(added.welcome)
  await bob.processHandshake(added.commit)
  await carol.processHandshake(added.welcome)
  // Keep a genuine pre-removal state too: no local removed flag can protect it.
  const staleBob = await member('unused')
  await staleBob.importState(await bob.exportState())
  const removed = await alice.remove(bob.keyPackage())
  assert.equal(removed.epoch, 3)
  await carol.processHandshake(removed.commit)
  await bob.processHandshake(removed.commit)
  const ciphertext = await alice.seal(bytes('fresh key after removal'))
  assert.deepEqual(await carol.open(ciphertext), bytes('fresh key after removal'))
  await assert.rejects(staleBob.open(ciphertext))
  await assert.rejects(bob.open(ciphertext))
  await assert.rejects(bob.seal(bytes('not a member')))
})

test('mls state bytes restore pending welcome, send/receive ratchets and replay protection', async () => {
  const alice = await member('alice')
  const pendingBob = await member('bob')
  const bob = await member('discarded')
  await bob.importState(await pendingBob.exportState())
  assert.deepEqual(bob.keyPackage(), pendingBob.keyPackage())
  await alice.create(bytes('journey'))
  const added = await alice.add(bob.keyPackage())
  assert.ok(added.welcome)
  await bob.processHandshake(added.welcome)
  const first = await alice.seal(bytes('one'))
  assert.deepEqual(await bob.open(first), bytes('one'))
  const restoredAlice = await member('discarded')
  const restoredBob = await member('discarded')
  await restoredAlice.importState(await alice.exportState())
  await restoredBob.importState(await bob.exportState())
  assert.equal(restoredAlice.epoch, 1)
  await assert.rejects(restoredBob.open(first))
  assert.deepEqual(await restoredBob.open(await restoredAlice.seal(bytes('two'))), bytes('two'))
  const update = await restoredBob.commit()
  await restoredAlice.processHandshake(update.commit)
  assert.equal(restoredAlice.epoch, 2)
  assert.deepEqual(await restoredAlice.open(await restoredBob.seal(bytes('three'))), bytes('three'))
  await assert.rejects(restoredAlice.importState(await alice.exportState()))
})

test('mls wrong group, tampering, wrong message kind and trailing bytes leave state unchanged', async () => {
  const {alice, bob} = await pair()
  const other = await member('other')
  await other.create(bytes('other journey'))
  const before = await bob.exportState()
  await assert.rejects(bob.open(await other.seal(bytes('foreign'))))
  const ciphertext = await alice.seal(bytes('authentic'))
  const tampered = ciphertext.slice()
  tampered[tampered.length - 1]! ^= 1
  await assert.rejects(bob.open(tampered))
  await assert.rejects(bob.open(new Uint8Array([...ciphertext, 0])))
  await assert.rejects(bob.processHandshake(ciphertext))
  await assert.rejects(bob.add(new Uint8Array([1, 2, 3])))
  assert.deepEqual(await bob.exportState(), before)
  assert.deepEqual(await bob.open(ciphertext), bytes('authentic'))
})

test('mls concurrent sends advance ratchets without losing state or reusing generations', async () => {
  const {alice, bob} = await pair()
  const messages = await Promise.all([alice.seal(bytes('a')), alice.seal(bytes('b')), alice.seal(bytes('c'))])
  assert.notDeepEqual(messages[0], messages[1])
  const plaintexts = await Promise.all(messages.map(message => bob.open(message)))
  assert.deepEqual(plaintexts, [bytes('a'), bytes('b'), bytes('c')])
})


test('mls unsafe epochs and malformed snapshots are refused without installing state', async () => {
  const {encodeMlsMessage, decodeMlsMessage, encodeGroupState, decodeGroupState} = await import('ts-mls')
  const {alice, bob} = await pair()
  const message = await alice.seal(bytes('safe'))
  const decoded = decodeMlsMessage(message, 0)![0]
  assert.equal(decoded.wireformat, 'mls_private_message')
  if (decoded.wireformat !== 'mls_private_message') throw new Error('Wrong fixture format')
  decoded.privateMessage.epoch = 2n ** 53n
  const before = await bob.exportState()
  await assert.rejects(bob.open(encodeMlsMessage(decoded)), RangeError)
  assert.deepEqual(await bob.exportState(), before)

  const snapshot = JSON.parse(new TextDecoder().decode(before))
  const state = decodeGroupState(new Uint8Array(snapshot.groupState), 0)![0]
  state.groupContext.epoch = 2n ** 53n
  snapshot.groupState = Array.from(encodeGroupState(state))
  const fresh = await member('fresh')
  const freshBefore = await fresh.exportState()
  await assert.rejects(fresh.importState(bytes(JSON.stringify(snapshot))), RangeError)
  await assert.rejects(fresh.importState(bytes('{')))
  assert.deepEqual(await fresh.exportState(), freshBefore)
  await fresh.importState(before)
  assert.deepEqual(await fresh.open(message), bytes('safe'))
})

test('mls snapshots copy only named fields and key packages contain no private state', async () => {
  const {decodeMlsMessage} = await import('ts-mls')
  const pending = await member('pending')
  const decoded = decodeMlsMessage(pending.keyPackage(), 0)![0]
  assert.equal(decoded.wireformat, 'mls_key_package')
  assert.equal('privateKeys' in decoded, false)
  const snapshot = JSON.parse(new TextDecoder().decode(await pending.exportState()))
  snapshot.callerGrant = 'must not survive'
  snapshot.privateKeys.callerGrant = 'must not survive'
  const restored = await member('restored')
  await restored.importState(bytes(JSON.stringify(snapshot)))
  const output = JSON.parse(new TextDecoder().decode(await restored.exportState()))
  assert.equal('callerGrant' in output, false)
  assert.equal('callerGrant' in output.privateKeys, false)
  const alice = await member('alice')
  await alice.create(bytes('journey'))
  const add = await alice.add(restored.keyPackage())
  assert.ok(add.welcome)
  await restored.processHandshake(add.welcome)
  assert.deepEqual(await restored.open(await alice.seal(bytes('joined'))), bytes('joined'))
})
