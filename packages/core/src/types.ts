/** JSON values preserve extensions at each protocol boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue | undefined };
export type ProtocolRecord = { type: string; typeVersion: number; body: JsonObject } & JsonObject;
export type Validation = { ok: true } | { ok: false; reason: string };
