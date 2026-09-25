/**
 * The sign-in email. Written to read as an expected, transactional message:
 * it says why the person got it, when the link expires, and what to do if
 * they did not ask. The HTML never contains the recipient address or any
 * input other than the link, which the server builds itself.
 */
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

export function magicLinkEmail(link: string): { text: string; html: string } {
  const text = [
    'You asked to sign in to Wayfinding journeys at app.wayfinding.support.',
    '',
    'Open this link to sign in:',
    link,
    '',
    'The link works once and expires in 15 minutes.',
    '',
    "If you didn't ask to sign in, you can ignore this email. Nobody can sign in without this link and your passkey.",
    '',
    'Wayfinding · wayfinding.support',
  ].join('\n');
  const href = escapeHtml(link);
  const html = `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#f4f1ea;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#14213d;"><table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #14213d;"><tr><td style="padding:28px;"><p style="margin:0 0 16px;font-size:18px;font-weight:600;">Sign in to Wayfinding</p><p style="margin:0 0 20px;font-size:15px;line-height:1.5;">You asked to sign in to Wayfinding journeys at app.wayfinding.support.</p><p style="margin:0 0 20px;"><a href="${href}" style="display:inline-block;padding:12px 20px;background:#14213d;color:#ffffff;text-decoration:none;font-size:15px;">Sign in</a></p><p style="margin:0 0 16px;font-size:14px;line-height:1.5;">The link works once and expires in 15 minutes.</p><p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#4a5568;">If you didn't ask to sign in, you can ignore this email. Nobody can sign in without this link and your passkey.</p><p style="margin:0;font-size:12px;color:#4a5568;">If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all;">${href}</span></p></td></tr></table><p style="max-width:520px;margin:12px auto 0;font-size:12px;color:#4a5568;">Wayfinding · wayfinding.support</p></body></html>`;
  return { text, html };
}
