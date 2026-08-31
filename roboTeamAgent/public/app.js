const config = globalThis.ROBOTEAM_CONFIG || {};
const basePath = config.publicBasePath || './';
const routeKey = config.routeKey || 'roboTeamAgent';
const profilesList = document.querySelector('#profilesList');
const profileTemplate = document.querySelector('#profileTemplate');
const profileCount = document.querySelector('#profileCount');
const createForm = document.querySelector('#createForm');
const formMessage = document.querySelector('#formMessage');
const refreshButton = document.querySelector('#refreshButton');

function endpoint(relativePath) {
    return new URL(relativePath.replace(/^\/+/, ''), new URL(basePath, location.origin)).toString();
}

async function browserMutationToken() {
    const tokenUrl = new URL('/auth/token', location.origin);
    tokenUrl.searchParams.set('mutationRoute', routeKey);
    const response = await fetch(tokenUrl, { credentials: 'include', cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    const proof = payload.browserMutation;
    if (!response.ok || !proof?.csrfToken || proof.routeKey !== routeKey) {
        throw new Error('Could not obtain the Ploinky browser mutation proof. Refresh the page and sign in again.');
    }
    return proof.csrfToken;
}

async function api(relativePath, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('accept', 'application/json');
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        headers.set('x-ploinky-browser-csrf-token', await browserMutationToken());
    }
    const response = await fetch(endpoint(relativePath), {
        ...options,
        method,
        headers,
        credentials: 'include',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
}

function initials(name) {
    return String(name || 'R')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join('');
}

function renderProfiles(profiles) {
    profilesList.replaceChildren();
    profileCount.textContent = `${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'}`;
    if (!profiles.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<h3>No robot profiles yet</h3><p>Create the first specialized virtual employee above.</p>';
        profilesList.append(empty);
        return;
    }

    for (const profile of profiles) {
        const card = profileTemplate.content.firstElementChild.cloneNode(true);
        card.dataset.profileId = profile.id;
        card.querySelector('.avatar').textContent = initials(profile.name);
        card.querySelector('h3').textContent = profile.name;
        card.querySelector('.specialization').textContent = profile.specialization || 'General-purpose virtual employee';
        card.querySelector('.profile-id').textContent = profile.id;
        const state = card.querySelector('.desktop-state');
        state.textContent = profile.desktop.state;
        state.classList.add(`state-${profile.desktop.state}`);
        const stopButton = card.querySelector('.stop-desktop');
        stopButton.hidden = profile.desktop.state === 'stopped';

        card.querySelector('.open-desktop').addEventListener('click', async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            button.textContent = 'Starting…';
            try {
                const result = await api(`api/profiles/${profile.id}/desktop/start`, { method: 'POST', body: {} });
                window.open(result.profile.desktopUrl, `_roboteam_${profile.id}`);
                await loadProfiles();
            } catch (error) {
                formMessage.textContent = error.message;
                formMessage.className = 'message error';
            } finally {
                button.disabled = false;
                button.textContent = 'Open desktop';
            }
        });

        stopButton.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
                await api(`api/profiles/${profile.id}/desktop/stop`, { method: 'POST', body: {} });
                await loadProfiles();
            } catch (error) {
                formMessage.textContent = error.message;
                formMessage.className = 'message error';
                button.disabled = false;
            }
        });
        profilesList.append(card);
    }
}

async function loadProfiles() {
    refreshButton.disabled = true;
    try {
        const result = await api('api/profiles');
        renderProfiles(result.profiles || []);
    } catch (error) {
        profilesList.innerHTML = `<div class="empty-state error"><h3>Profiles unavailable</h3><p>${escapeHtml(error.message)}</p></div>`;
    } finally {
        refreshButton.disabled = false;
    }
}

function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = String(value || '');
    return node.innerHTML;
}

createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = createForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    formMessage.textContent = '';
    const data = new FormData(createForm);
    try {
        await api('api/profiles', {
            method: 'POST',
            body: {
                name: data.get('name'),
                specialization: data.get('specialization'),
            },
        });
        createForm.reset();
        formMessage.textContent = 'Robot profile created.';
        formMessage.className = 'message success';
        await loadProfiles();
    } catch (error) {
        formMessage.textContent = error.message;
        formMessage.className = 'message error';
    } finally {
        submit.disabled = false;
    }
});

refreshButton.addEventListener('click', loadProfiles);
await loadProfiles();
