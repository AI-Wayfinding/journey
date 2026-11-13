import { Refused } from '../commands.ts';

// Only fixed, actionable copy crosses the HTML boundary. Refused alone is not a safety guarantee.
const safeMessages = [
 'A fresh sign-in is required to start recovery',
 'Confirm removal of all connections',
 'Account identity log capacity reached; recovery was not started',
 'Complete onboarding before using the console',
 'Complete onboarding before using browser controls',
 'Wait the full 72 hours',
 'Account recovery requires the full 72 hours',
 'Sign in again after the recovery deadline',
 'Sign in again before creating your first passkey',
 'Keep your last passkey; use account recovery to remove all connections',
 'Set your name and create a trusted browser connection first',
 'Onboarding already complete',
 'Fresh wrapping passkey assertion required to confirm recovery code',
 'Wrapping passkey required',
 'Use your recovery code',
 'An existing passkey assertion or recovery code is required',
 'Existing passkey required',
 'Fresh passkey registration required',
 'Fresh authorized registration required',
 'Passkey registration refused',
 'Passkey already registered',
 'Passkey capacity reached',
 'Browser capacity reached',
 'Browser device revoked',
 'Registered wrapping passkey required',
 'Use your unlocked browser connection to publish sealed offers with their journey settings',
 'Use your unlocked browser connection to decide sealed requests',
 'Offer changed; reload before removing a rule',
 'Invalid form JSON',
 'Form too large',
 'Duplicate form field',
 'CSRF token required',
] as const;
export function consoleRefusal(error: unknown): string {
 return error instanceof Refused ? safeMessages.find(message => message === error.message) ?? 'Check the form or sign in again.' : 'Check the form or sign in again.';
}
