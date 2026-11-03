/** Opaque MLS wire messages. The welcome includes the public ratchet tree. */
export interface MlsCommit {
  readonly commit: Uint8Array
  readonly welcome?: Uint8Array
  readonly epoch: number
}

/**
 * One local member in one group. Methods serialize state transitions; rejection
 * leaves state unchanged. Add/remove commit immediately, so do not process your
 * own commit again. Deliver commits in order before that epoch's applications.
 * Basic credential identities are labels, not verified account identities:
 * callers must authenticate the key-package owner before adding them.
 */
export interface MlsGroup {
  readonly audited: false
  readonly library: {readonly name: string; readonly version: string}
  /** null until created or joined; otherwise a natural strictly below 2^53. */
  readonly epoch: number | null
  /** The public, single-use key package. Never contains private key material. */
  keyPackage(): Uint8Array
  create(groupId: Uint8Array): Promise<void>
  add(keyPackage: Uint8Array): Promise<MlsCommit>
  /** Finds the current leaf by the original key package's signature public key. */
  remove(keyPackage: Uint8Array): Promise<MlsCommit>
  /** An update commit with no membership change. */
  commit(): Promise<MlsCommit>
  /** Join with a welcome, or apply another member's commit/proposal. */
  processHandshake(message: Uint8Array): Promise<void>
  seal(plaintext: Uint8Array): Promise<Uint8Array>
  open(message: Uint8Array): Promise<Uint8Array>
  /**
   * Secret, versioned implementation-specific bytes. Protect at rest; never
   * relay them. Persist after each transition. Restoring an old snapshot risks
   * key/nonce reuse; import only the latest snapshot, into an unused instance.
   */
  exportState(): Promise<Uint8Array>
  importState(state: Uint8Array): Promise<void>
}
