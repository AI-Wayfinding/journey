export const encode = (bytes: Uint8Array): string => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
export const decode = (text: string): Uint8Array => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export const asBuffer = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer;
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const text = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
