export function prfOutput(value: unknown): Uint8Array | null {
  let bytes: Uint8Array;
  if (typeof value === 'string') {
    try { bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
    catch { return null; }
  } else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    bytes = new Uint8Array(value as ArrayBuffer);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (value && typeof value === 'object') {
    // Some password-manager extensions (seen with 1Password) return PRF bytes as a plain array
    // or an array-like object from their own script world rather than an ArrayBuffer.
    const like = value as { length?: unknown; byteLength?: unknown; [index: number]: unknown };
    const size = typeof like.length === 'number' ? like.length : typeof like.byteLength === 'number' ? like.byteLength : Object.keys(like).filter(k => /^\d+$/.test(k)).length;
    try { bytes = like.byteLength !== undefined && like.length === undefined ? new Uint8Array(like as unknown as ArrayBuffer) : Uint8Array.from({ length: size }, (_, i) => { const n = like[i]; if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) throw new Error('not a byte'); return n; }); }
    catch { return null; }
  } else return null;
  if (bytes.length !== 32) return null;
  return new Uint8Array(bytes);
}
