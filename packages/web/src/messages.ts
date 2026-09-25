/** Words a person sees when a request fails. Server codes stay stable; this is the only place they become text. */
export const EXPIRED_LINK = 'Sign-in links work once and expire after 15 minutes. Ask for a new one.';
const messages: Record<string, string> = {
  unauthorized: 'Your sign-in has ended. Sign in again to continue.',
  forbidden: 'You don\'t have access to do that in this journey.',
  'not-found': 'We couldn\'t find that. It may have expired or been removed.',
  conflict: 'Something changed while you were working. Reload and try again.',
  'old-epoch': 'This journey\'s key has changed. Reload to get the new one.',
  'too-large': 'That is too large to save. Items can be up to 1 MB.',
  'invalid-request': 'Something about that request wasn\'t right. Check it and try again.',
  csrf: 'This page is out of date. Reload and try again.',
  'rate-limited': 'Too many attempts. Please wait a minute and try again.',
  internal: 'Something went wrong on our side. Please try again.',
};
export function plainError(code: string | undefined, status: number): string {
  if (code && messages[code]) return messages[code]!;
  if (status === 429) return 'Too many attempts. Please wait a minute and try again.';
  if (status === 401) return messages.unauthorized!;
  if (status === 403) return messages.forbidden!;
  return 'Something went wrong. Please try again.';
}
