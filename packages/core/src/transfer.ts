import type { AgeIdentity, AgeRecipient } from './keys.js';
import { openIdentity, sealIdentity } from './keys.js';
import { open } from './envelope.js';
import type { Envelope } from './envelope.js';
import { verifyLog } from './log.js';
import type { LogEntry, LogState } from './log.js';
import { unwrapJourneyKey } from './teamKey.js';
import type { KeyWrap } from './teamKey.js';
import { parseRecord } from './items.js';
export interface JourneyArchive { log: LogEntry[]; envelopes: Envelope[]; wraps: KeyWrap[] }
export async function exportJourney(log: LogEntry[], envelopes: Envelope[], wraps: KeyWrap[], recipients: AgeRecipient[]): Promise<string> {
  return sealIdentity(JSON.stringify({ log, envelopes, wraps }), recipients);
}
export async function importJourney(ciphertext: string, identities: AgeIdentity[]): Promise<{ archive: JourneyArchive; state: LogState }> {
  const parsed: unknown = JSON.parse(await openIdentity(ciphertext, identities));
  if (!parsed || typeof parsed !== 'object' || !('log' in parsed) || !Array.isArray(parsed.log) || !('envelopes' in parsed) || !Array.isArray(parsed.envelopes) || !('wraps' in parsed) || !Array.isArray(parsed.wraps)) throw new Error('Invalid journey archive');
  // Untrusted archive: verify its signed history before using its wraps or contents.
  const archive = { log: parsed.log as LogEntry[], envelopes: parsed.envelopes as Envelope[], wraps: parsed.wraps as KeyWrap[] };
  const verified = await verifyLog(archive.log);
  if (!verified.ok) throw new Error(verified.error.code + ': ' + verified.error.message);
  for (const envelope of archive.envelopes) {
    if (!envelope?.outside || envelope.outside.journey !== verified.state.journey || envelope.outside.epoch > verified.state.currentEpoch || !Number.isSafeInteger(envelope.outside.epoch)) throw new Error('Invalid archive envelope metadata');
    let opened = false;
    for (const wrap of archive.wraps.filter(w => w.epoch === envelope.outside.epoch)) {
      for (const identity of identities) {
        try {
          const key = await unwrapJourneyKey(wrap, identity);
          parseRecord(await open(envelope, key));
          opened = true;
          break;
        } catch { /* try another permitted identity / wrap */ }
      }
      if (opened) break;
    }
    if (!opened) throw new Error('No valid key or ciphertext for archive envelope');
  }
  return { archive, state: verified.state };
}
