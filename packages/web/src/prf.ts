export function prfOutput(value: unknown): Uint8Array | null {
  let bytes: Uint8Array;
  if (typeof value === 'string') {
    try { bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
    catch { return null; }
  } else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    bytes = new Uint8Array(value as ArrayBuffer);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else return null;
  if (bytes.length !== 32) return null;
  return new Uint8Array(bytes);
}
