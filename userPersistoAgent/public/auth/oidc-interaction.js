const encode = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = (value) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));

document.querySelectorAll('[data-passkey]').forEach((button) => {
    button.form.addEventListener('submit', async (event) => {
        event.preventDefault();
        button.disabled = true;
        const form = button.form;
        try {
            const response = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin' });
            if (!response.ok) throw new Error('Unable to start passkey sign-in.');
            const result = await response.json();
            const options = result.publicKey;
            options.challenge = decode(options.challenge);
            options.allowCredentials = (options.allowCredentials || []).map((item) => ({ ...item, id: decode(item.id) }));
            const credential = await navigator.credentials.get({ publicKey: options });
            const assertion = { id: credential.id, rawId: encode(credential.rawId), type: credential.type,
                response: { clientDataJSON: encode(credential.response.clientDataJSON), authenticatorData: encode(credential.response.authenticatorData), signature: encode(credential.response.signature),
                    userHandle: credential.response.userHandle ? encode(credential.response.userHandle) : null } };
            const input = document.createElement('input');
            input.type = 'hidden'; input.name = 'assertion'; input.value = JSON.stringify(assertion); form.appendChild(input);
            form.action = form.action.replace(/passkey-options$/, 'passkey-verify');
            form.submit();
        } catch (error) {
            form.querySelector('[data-passkey-error]').textContent = error.message || 'Unable to sign in with this passkey.';
            button.disabled = false;
        }
    });
});

document.querySelectorAll('[data-google]').forEach((button) => {
    button.form.addEventListener('submit', async (event) => {
        event.preventDefault();
        button.disabled = true;
        try {
            const response = await fetch(button.form.action, { method: 'POST', body: new URLSearchParams(new FormData(button.form)), credentials: 'same-origin' });
            const result = await response.json();
            if (!response.ok || !result.authorizationUrl) throw new Error('Unable to continue with Google. Try another sign-in method.');
            window.location.assign(result.authorizationUrl);
        } catch {
            button.disabled = false;
            let error = button.form.querySelector('[role="alert"]');
            if (!error) {
                error = document.createElement('p');
                error.setAttribute('role', 'alert');
                button.form.append(error);
            }
            error.textContent = 'Unable to continue with Google. Try another sign-in method.';
        }
    });
    button.disabled = false;
});
