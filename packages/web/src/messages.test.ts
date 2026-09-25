import { describe, expect, it } from 'vitest';
import { EXPIRED_LINK, plainError } from './messages.js';

describe('plain error messages', () => {
  it('never shows a bare server code', () => {
    for (const code of ['unauthorized', 'forbidden', 'not-found', 'conflict', 'old-epoch', 'too-large', 'invalid-request', 'csrf', 'internal', 'rate-limited', undefined]) {
      const message = plainError(code, 400);
      expect(message).not.toBe(code);
      expect(message).toMatch(/[A-Z].*\.$/);
    }
  });
  it('explains session and access problems plainly', () => {
    expect(plainError('unauthorized', 401)).toContain('Sign in');
    expect(plainError('forbidden', 403)).toContain('access');
    expect(plainError(undefined, 429)).toContain('wait');
  });
  it('describes an expired sign-in link', () => {
    expect(EXPIRED_LINK).toContain('15 minutes');
  });
});
