// Same system-font, semantic form baseline as packages/apps/src/style.css.
export const style = `:root{font:15px/1.5 system-ui,sans-serif;color-scheme:light dark}body{margin:0 auto;padding:1rem;max-width:60rem}p[role=note]{border:1px solid currentColor;padding:.65rem;font-size:.9rem}h1{font-size:1.5rem}h2{font-size:1.1rem}section,form{margin:1rem 0}label{display:block;margin:.5rem 0}input,select,button{font:inherit;padding:.35rem;max-width:100%;box-sizing:border-box}button{margin-right:.5rem}ul{padding-left:1.2rem}li{margin:.75rem 0;overflow-wrap:anywhere}fieldset{border:1px solid currentColor;margin:1rem 0}small{display:block;margin-left:1.5rem}nav{display:flex;gap:1rem;flex-wrap:wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere}#status{min-height:1.5em}:focus-visible{outline:3px solid Highlight;outline-offset:3px}`;
export const webauthn = `
const decode = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const encode = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
for (const form of document.querySelectorAll('form[data-ceremony]')) form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button'), status = document.getElementById('status');
  button.disabled = true;
  try {
    if (!navigator.credentials || !window.PublicKeyCredential) throw new Error('Passkeys need a WebAuthn browser.');
    const fields = new FormData(form), csrf = fields.get('csrf');
    const change = fields.has('change') ? JSON.parse(fields.get('change')) : undefined;
    async function post(path, body) {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin', redirect: 'follow', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf, ...body }) });
      if (!response.ok) throw new Error('The request was refused. Check the form or sign in again.');
      return response;
    }
    const options = await (await post(form.dataset.options, change ? { change } : {})).json();
    options.challenge = decode(options.challenge);
    const registering = form.dataset.ceremony === 'register';
    if (registering) { options.user.id = decode(options.user.id); options.excludeCredentials = (options.excludeCredentials || []).map(c => ({ ...c, id: decode(c.id) })); }
    else options.allowCredentials = options.allowCredentials.map(c => ({ ...c, id: decode(c.id) }));
    const result = registering ? await navigator.credentials.create({ publicKey: options }) : await navigator.credentials.get({ publicKey: options });
    if (!result) throw new Error('Passkey confirmation was cancelled.');
    const credential = { id: result.id, rawId: encode(result.rawId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: encode(result.response.clientDataJSON) } };
    if (registering) { credential.response.attestationObject = encode(result.response.attestationObject); credential.response.transports = result.response.getTransports?.() || []; }
    else { credential.response.authenticatorData = encode(result.response.authenticatorData); credential.response.signature = encode(result.response.signature); if (result.response.userHandle) credential.response.userHandle = encode(result.response.userHandle); }
    const response = await post(form.action, registering ? { credential } : { change, assertion: credential });
    const destination = new URL(response.url);
    if (destination.origin !== location.origin) throw new Error('Unexpected response.');
    location.assign(destination.pathname);
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Passkey confirmation failed.'; }
  finally { button.disabled = false; }
});`;
