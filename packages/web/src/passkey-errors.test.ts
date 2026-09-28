import { describe, expect, it } from 'vitest';
import { passkeyError } from './passkey-errors.js';

describe('passkey errors', () => {
  it('never shows raw WebAuthn errors or specification links', () => {
    for (const name of ['NotAllowedError', 'AbortError', 'InvalidStateError', 'SecurityError', 'TimeoutError']) {
      const raw = new DOMException('The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.', name);
      const message = passkeyError(raw);
      expect(message).not.toContain('w3.org');
      expect(message).not.toContain('operation either timed out');
      expect(message.toLowerCase()).toContain('passkey');
    }
    expect(passkeyError(new DOMException('duplicate', 'InvalidStateError'), 'add')).toBe('This passkey is already added.');
  });
});
