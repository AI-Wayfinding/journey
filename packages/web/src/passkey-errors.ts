export function passkeyError(cause: unknown, action: 'sign-in' | 'add' = 'sign-in'): string {
  const name = cause && typeof cause === 'object' && 'name' in cause ? String(cause.name) : '';
  if (name === 'InvalidStateError') return action === 'add' ? 'This passkey is already added.' : 'This passkey cannot sign you in. Use a backup code if you lost your passkey.';
  if (name === 'NotAllowedError' || name === 'AbortError' || name === 'TimeoutError') return action === 'add' ? 'No passkey was added. Try again.' : "No passkey was used. If you removed it or it's on another device, use a backup code.";
  if (name === 'SecurityError') return 'Passkeys are not available on this page. Open Wayfinding at its secure address.';
  if (typeof DOMException !== 'undefined' && cause instanceof DOMException) return 'This passkey did not work. Try again or use a backup code.';
  return cause instanceof Error && !/webauthn|w3\.org|operation either timed out/i.test(cause.message) ? cause.message : 'This passkey did not work. Try again or use a backup code.';
}
