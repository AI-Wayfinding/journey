// Same system-font, semantic form baseline as packages/apps/src/style.css.
import { workspaceStyle } from '../../../apps/src/polish-style.ts';
export const style = `:root{font:15px/1.5 system-ui,sans-serif;color-scheme:light dark}body{margin:0 auto;padding:1rem;max-width:60rem}p[role=note]{border:1px solid currentColor;padding:.65rem;font-size:.9rem}h1{font-size:1.5rem}h2{font-size:1.1rem}section,form{margin:1rem 0}label{display:block;margin:.5rem 0}input,select,button{font:inherit;padding:.35rem;max-width:100%;box-sizing:border-box}button{margin-right:.5rem}ul{padding-left:1.2rem}li{margin:.75rem 0;overflow-wrap:anywhere}fieldset{border:1px solid currentColor;margin:1rem 0}small{display:block;margin-left:1.5rem}nav{display:flex;gap:1rem;flex-wrap:wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere}#status{min-height:1.5em}:focus-visible{outline:3px solid Highlight;outline-offset:3px}.notice{padding:.5rem .75rem;border-left:4px solid #2e7d32;background:color-mix(in srgb,#2e7d32 12%,transparent)}.passkeys{list-style:none;padding:0}.passkey{display:grid;gap:.25rem;padding:.75rem 0;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent)}.passkey .meta{opacity:.75;font-size:.9em}` + workspaceStyle;
export const webauthn = `
const decode = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const encode = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
for (const form of document.querySelectorAll('form[data-ceremony]')) form.addEventListener('submit', async event => {
  const consent = form.dataset.ceremony === 'consent';
  if (consent && (event.submitter?.value === 'deny' || !new FormData(form).getAll('capabilities').includes('device.keys'))) return;
  event.preventDefault();
  const button = form.querySelector('button'), status = document.getElementById('status');
  button.disabled = true;
  try {
    if (!navigator.credentials || !window.PublicKeyCredential) throw new Error('Passkeys need a WebAuthn browser.');
    const fields = new FormData(form), csrf = fields.get('csrf');
    const change = fields.has('change') ? JSON.parse(fields.get('change')) : undefined;
    async function post(path, body) {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin', redirect: 'follow', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf, ...body }) });
      if (!response.ok) { const reason = response.status === 409 ? (await response.json().catch(() => ({}))).error : undefined; throw new Error(reason || 'The request was refused. Check the form or sign in again.'); }
      return response;
    }
    const options = await (await post(form.dataset.options, consent ? { request: fields.get('request'), decision: 'allow', name: fields.get('name'), capabilities: fields.getAll('capabilities'), journeys: fields.getAll('journeys') } : change ? { change } : {})).json();
    options.challenge = decode(options.challenge);
    const registering = form.dataset.ceremony === 'register';
    if (registering) { options.user.id = decode(options.user.id); options.excludeCredentials = (options.excludeCredentials || []).map(c => ({ ...c, id: decode(c.id) })); }
    else options.allowCredentials = options.allowCredentials.map(c => ({ ...c, id: decode(c.id) }));
    const result = registering ? await navigator.credentials.create({ publicKey: options }) : await navigator.credentials.get({ publicKey: options });
    if (!result) throw new Error('Passkey confirmation was cancelled.');
    const credential = { id: result.id, rawId: encode(result.rawId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: encode(result.response.clientDataJSON) } };
    if (registering) { credential.response.attestationObject = encode(result.response.attestationObject); credential.response.transports = result.response.getTransports?.() || []; }
    else { credential.response.authenticatorData = encode(result.response.authenticatorData); credential.response.signature = encode(result.response.signature); if (result.response.userHandle) credential.response.userHandle = encode(result.response.userHandle); }
    if (consent) {
      // Freeze the exact fields signed by this ceremony, even if the form changed while the prompt was open.
      for (const element of [...form.elements]) element.disabled = true;
      for (const [name, value] of [...fields, ['decision', 'allow'], ['assertion', JSON.stringify(credential)]]) {
        const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
      }
      HTMLFormElement.prototype.submit.call(form);
      return;
    }
    const response = await post(form.action, registering ? { credential } : { change, assertion: credential });
    const destination = new URL(response.url);
    if (destination.origin !== location.origin) throw new Error('Unexpected response.');
    location.assign(destination.pathname + destination.search);
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Passkey confirmation failed.'; }
  finally { button.disabled = false; }
});`;

// Landing page: top bar with an account menu on the right.
export const landingStyle = '.top{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.5rem 0;border-bottom:1px solid currentColor}.brand{font-weight:600;text-decoration:none}.account{position:relative}details.account summary{cursor:pointer;list-style:none;border:1px solid currentColor;border-radius:999px;padding:.25rem .75rem}details.account>div{position:absolute;right:0;top:2.2rem;display:flex;flex-direction:column;gap:.5rem;min-width:11rem;padding:.75rem;border:1px solid currentColor;background:Canvas;z-index:1}details.account form{margin:0}a.account{border:1px solid currentColor;border-radius:999px;padding:.25rem .75rem;text-decoration:none}a.button{display:inline-block;border:1px solid currentColor;border-radius:.4rem;padding:.45rem .9rem;text-decoration:none;font-weight:600}code{overflow-wrap:anywhere}.top nav{display:flex;gap:1rem;flex:1}.top nav a{text-decoration:none}.top nav a:hover{text-decoration:underline}main>section{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:.6rem;padding:.25rem 1rem;margin:1rem 0}main>section>ul{list-style:none;padding:0}main>section>ul>li{padding:.5rem 0;margin:0;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}main>section>ul>li:last-child{border-bottom:0}small.id{display:inline;margin:0;opacity:.6;font-size:.8em}.chips{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;padding:0;margin:0}.chips li{margin:0;padding:.15rem .6rem;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);font-size:.9em}dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem}dl.facts dd{margin:0}button{border-radius:.4rem;border:1px solid currentColor;background:transparent;cursor:pointer}button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}nav[aria-label=Journey]{border-bottom:1px solid color-mix(in srgb,currentColor 18%,transparent);padding-bottom:.5rem}a[href="#main"]{position:absolute;left:-999px}a[href="#main"]:focus{left:1rem}';
