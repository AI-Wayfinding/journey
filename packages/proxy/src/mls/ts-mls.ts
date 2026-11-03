import {
  createGroup, joinGroup, createCommit, createApplicationMessage,
  processPrivateMessage, processPublicMessage, generateKeyPackage,
  defaultCapabilities, emptyPskIndex,
  getCiphersuiteImpl, getCiphersuiteFromName, encodeMlsMessage,
  decodeMlsMessage, encodeGroupState, decodeGroupState, zeroOutUint8Array,
} from 'ts-mls'
import type {ClientState, KeyPackage, PrivateKeyPackage, Proposal} from 'ts-mls'
import {defaultClientConfig} from 'ts-mls/clientConfig.js'
import type {MlsGroup, MlsCommit} from './group.ts'

const suite = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
const library = Object.freeze({name: 'ts-mls', version: '1.6.4'})
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', {fatal: true})

function decode<T>(decoder: (b: Uint8Array, offset: number) => [T, number] | undefined, bytes: Uint8Array): T {
  const result = decoder(bytes, 0)
  if (!result || result[1] !== bytes.length) throw new Error('Invalid or trailing MLS bytes')
  return result[0]
}

function keyPackage(bytes: Uint8Array): KeyPackage {
  const msg = decode(decodeMlsMessage, bytes)
  if (msg.version !== 'mls10' || msg.wireformat !== 'mls_key_package' || msg.keyPackage.cipherSuite !== suite) {
    throw new Error('Expected an MLS 1.0 key package for the configured ciphersuite')
  }
  return msg.keyPackage
}

// MLS uses uint64 epochs internally. No unsafe integer crosses this boundary,
// including epochs in imported history, credentials' lifetimes, or wire input.
function checkNumbers(value: unknown): void {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('MLS value must be below 2^53')
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('MLS value must be below 2^53')
  } else if (value instanceof Map) {
    for (const [key, item] of value) { checkNumbers(key); checkNumbers(item) }
  } else if (value instanceof Uint8Array) {
    return
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) checkNumbers(item)
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MLS state record')
  return value as Record<string, unknown>
}
function byteArray(value: unknown): Uint8Array {
  if (!Array.isArray(value) || !value.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error('Invalid MLS state bytes')
  }
  return new Uint8Array(value)
}
function privateKeys(value: unknown): PrivateKeyPackage {
  const v = record(value)
  const keys = {
    initPrivateKey: byteArray(v.initPrivateKey),
    hpkePrivateKey: byteArray(v.hpkePrivateKey),
    signaturePrivateKey: byteArray(v.signaturePrivateKey),
  }
  // HPKE uses raw X25519 secrets; Web Crypto exports Ed25519 as PKCS8.
  if (keys.initPrivateKey.length !== 32 || keys.hpkePrivateKey.length !== 32 || keys.signaturePrivateKey.length !== 48) {
    throw new Error('Invalid MLS private key length')
  }
  return keys
}
function erase(keys: PrivateKeyPackage | undefined): void {
  if (keys) Object.values(keys).forEach(zeroOutUint8Array)
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Creates an unused local member; create() or a welcome establishes the group. */
export async function createMlsGroup(identity: Uint8Array): Promise<MlsGroup> {
  if (!identity.length) throw new Error('MLS identity must not be empty')
  const credential = {credentialType: 'basic' as const, identity: identity.slice()}
  const cs = await getCiphersuiteImpl(getCiphersuiteFromName(suite))
  // The library's default notAfter is 2^63-1, outside our numeric boundary.
  const now = Math.floor(Date.now() / 1000)
  const lifetime = {notBefore: BigInt(now - 60), notAfter: BigInt(now + 2_628_000)}
  const generated = await generateKeyPackage(credential, defaultCapabilities(), lifetime, [], cs)
  let publicPackage = generated.publicPackage
  let pendingKeys: PrivateKeyPackage | undefined = generated.privatePackage
  let state: ClientState | undefined
  let used = false
  let queue: Promise<void> = Promise.resolve()

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation)
    queue = result.then(() => {}, () => {})
    return result
  }
  function unused(): void {
    if (used) throw new Error('MLS member is already initialized')
  }
  function checked(s: ClientState): ClientState {
    checkNumbers(s)
    if (s.groupContext.cipherSuite !== suite) throw new Error('Wrong MLS state ciphersuite')
    return s
  }
  function cloneState(): ClientState {
    if (!state) throw new Error('MLS group has not been created or joined')
    if (state.groupActiveState.kind !== 'active') throw new Error('MLS member is not active')
    return checked({...decode(decodeGroupState, encodeGroupState(state)), clientConfig: defaultClientConfig})
  }
  function install(s: ClientState, consumed: Uint8Array[]): void {
    checked(s)
    consumed.forEach(zeroOutUint8Array)
    state = s
    used = true
  }
  function finishJoin(s: ClientState): void {
    checked(s)
    state = s
    used = true
    erase(pendingKeys)
    pendingKeys = undefined
  }
  async function change(s: ClientState, proposals: Proposal[]): Promise<MlsCommit> {
    if (s.groupContext.epoch >= BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('MLS epoch would reach 2^53')
    const result = await createCommit({state: s, cipherSuite: cs}, {extraProposals: proposals, ratchetTreeExtension: true})
    const commit = encodeMlsMessage(result.commit)
    const welcome = result.welcome === undefined ? undefined : encodeMlsMessage({
      version: 'mls10', wireformat: 'mls_welcome', welcome: result.welcome,
    })
    install(result.newState, result.consumed)
    return {commit, welcome, epoch: Number(result.newState.groupContext.epoch)}
  }

  return {
    audited: false,
    library,
    get epoch() { return state ? Number(state.groupContext.epoch) : null },
    keyPackage() {
      return encodeMlsMessage({version: 'mls10', wireformat: 'mls_key_package', keyPackage: publicPackage})
    },
    create(groupId) {
      const id = groupId.slice()
      return serial(async () => {
        unused()
        if (!id.length) throw new Error('MLS group ID must not be empty')
        if (!pendingKeys) throw new Error('Missing MLS join keys')
        // Clone so deleting the one-time join keys cannot erase the live state.
        finishJoin(await createGroup(id, structuredClone(publicPackage), structuredClone(pendingKeys), [], cs))
      })
    },
    add(bytes) {
      const input = bytes.slice()
      return serial(async () => {
        const kp = keyPackage(input)
        checkNumbers(kp)
        return change(cloneState(), [{proposalType: 'add', add: {keyPackage: kp}}])
      })
    },
    remove(bytes) {
      const input = bytes.slice()
      return serial(async () => {
        const kp = keyPackage(input)
        checkNumbers(kp)
        const s = cloneState()
        const index = s.ratchetTree.findIndex(node => node?.nodeType === 'leaf' &&
          sameBytes(node.leaf.signaturePublicKey, kp.leafNode.signaturePublicKey))
        if (index < 0) throw new Error('MLS key package is not a current member')
        return change(s, [{proposalType: 'remove', remove: {removed: index / 2}}])
      })
    },
    commit() { return serial(() => change(cloneState(), [])) },
    processHandshake(bytes) {
      const input = bytes.slice()
      return serial(async () => {
        const msg = decode(decodeMlsMessage, input)
        checkNumbers(msg)
        if (msg.version !== 'mls10') throw new Error('Expected MLS 1.0')
        if (msg.wireformat === 'mls_welcome') {
          unused()
          if (!pendingKeys) throw new Error('Missing MLS join keys')
          if (msg.welcome.cipherSuite !== suite) throw new Error('Wrong welcome ciphersuite')
          finishJoin(await joinGroup(msg.welcome, structuredClone(publicPackage), structuredClone(pendingKeys), emptyPskIndex, cs))
        } else if (msg.wireformat === 'mls_private_message') {
          const result = await processPrivateMessage(cloneState(), msg.privateMessage, emptyPskIndex, cs)
          if (result.kind !== 'newState') throw new Error('Expected an MLS handshake, not an application')
          install(result.newState, result.consumed)
        } else if (msg.wireformat === 'mls_public_message') {
          const result = await processPublicMessage(cloneState(), msg.publicMessage, emptyPskIndex, cs)
          install(result.newState, result.consumed)
        } else throw new Error('Expected an MLS welcome, commit or proposal')
      })
    },
    seal(plaintext) {
      const input = plaintext.slice()
      return serial(async () => {
        const result = await createApplicationMessage(cloneState(), input, cs)
        const message = encodeMlsMessage({version: 'mls10', wireformat: 'mls_private_message', privateMessage: result.privateMessage})
        install(result.newState, result.consumed)
        return message
      })
    },
    open(bytes) {
      const input = bytes.slice()
      return serial(async () => {
        const msg = decode(decodeMlsMessage, input)
        checkNumbers(msg)
        if (msg.version !== 'mls10' || msg.wireformat !== 'mls_private_message') throw new Error('Expected an MLS private application message')
        const result = await processPrivateMessage(cloneState(), msg.privateMessage, emptyPskIndex, cs)
        if (result.kind !== 'applicationMessage') throw new Error('Expected an MLS application, not a handshake')
        install(result.newState, result.consumed)
        return result.message.slice()
      })
    },
    exportState() {
      return serial(async () => textEncoder.encode(JSON.stringify({
        format: 'wayfinding-mls-state', version: 1, library: 'ts-mls@1.6.4',
        keyPackage: Array.from(encodeMlsMessage({version: 'mls10', wireformat: 'mls_key_package', keyPackage: publicPackage})),
        privateKeys: pendingKeys ? {
          initPrivateKey: Array.from(pendingKeys.initPrivateKey),
          hpkePrivateKey: Array.from(pendingKeys.hpkePrivateKey),
          signaturePrivateKey: Array.from(pendingKeys.signaturePrivateKey),
        } : null,
        groupState: state ? Array.from(encodeGroupState(state)) : null,
      })))
    },
    importState(bytes) {
      const input = bytes.slice()
      return serial(async () => {
        unused()
        const parsed: unknown = JSON.parse(textDecoder.decode(input))
        const v = record(parsed)
        if (v.format !== 'wayfinding-mls-state' || v.version !== 1 || v.library !== 'ts-mls@1.6.4') throw new Error('Unsupported MLS state format')
        const kp = keyPackage(byteArray(v.keyPackage))
        checkNumbers(kp)
        const keys = v.privateKeys === null ? undefined : privateKeys(v.privateKeys)
        const restored = v.groupState === null ? undefined : checked({
          ...decode(decodeGroupState, byteArray(v.groupState)), clientConfig: defaultClientConfig,
        })
        if ((restored === undefined) === (keys === undefined)) throw new Error('MLS state must contain either join keys or group state')
        erase(pendingKeys)
        publicPackage = kp
        pendingKeys = keys
        state = restored
        // Pending imported keys still need exactly one create/welcome operation.
        used = restored !== undefined
      })
    },
  }
}
