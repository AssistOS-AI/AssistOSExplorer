const encode = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = (value) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
let controller;
window.addEventListener('pagehide', () => {
    controller?.abort();
    document.querySelectorAll('input').forEach((input) => { input.value = ''; });
});
document.querySelectorAll('[data-google-passkey]').forEach((button) => {
    button.form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = button.form;
        controller = new AbortController();
        button.disabled = true;
        try {
            const response = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), signal: controller.signal, credentials: 'same-origin' });
            if (!response.ok) throw new Error();
            const result = await response.json();
            const options = result.publicKey;
            options.challenge = decode(options.challenge);
            options.allowCredentials = (options.allowCredentials || []).map((item) => ({ ...item, id: decode(item.id) }));
            const credential = await navigator.credentials.get({ publicKey: options, signal: controller.signal });
            if (controller.signal.aborted) return;
            const assertion = { id: credential.id, rawId: encode(credential.rawId), type: credential.type,
                response: { clientDataJSON: encode(credential.response.clientDataJSON), authenticatorData: encode(credential.response.authenticatorData), signature: encode(credential.response.signature),
                    userHandle: credential.response.userHandle ? encode(credential.response.userHandle) : null } };
            for (const [name, value] of Object.entries({ method: 'passkey', assertion: JSON.stringify(assertion) })) {
                const input = document.createElement('input');
                input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
            }
            const target = new URL(form.action);
            target.pathname = target.pathname.replace(/challenge$/, 'authenticate');
            form.action = target.href;
            form.submit();
        } catch {
            document.querySelector('[data-google-error]').textContent = 'Unable to authenticate with this passkey. Start again or use another existing credential.';
            button.disabled = false;
        }
    });
});
