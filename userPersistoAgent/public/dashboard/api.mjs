const MANAGEMENT_PATHS = Object.freeze({
    userpersisto_user_list: 'users/list',
    userpersisto_user_update: 'users/update',
    userpersisto_user_roles_update: 'users/roles',
    userpersisto_user_delete: 'users/delete',
    userpersisto_roles_list: 'roles/list',
    userpersisto_role_create: 'roles/create',
    userpersisto_role_update: 'roles/update',
    userpersisto_role_delete: 'roles/delete',
    userpersisto_oidc_clients_list: 'applications/list',
    userpersisto_oidc_client_create: 'applications/create',
    userpersisto_oidc_client_update: 'applications/update',
    userpersisto_oidc_client_delete: 'applications/delete',
    userpersisto_oidc_client_rotate_secret: 'applications/rotate',
    userpersisto_oidc_status: 'applications/status',
    userpersisto_auth_policy_get: 'policy/get',
    userpersisto_auth_policy_set: 'policy/set',
    userpersisto_google_status: 'google/status',
});

export async function callManagementTool(name, args = {}) {
    const profile = name === 'userpersisto_profile_get';
    const path = Object.hasOwn(MANAGEMENT_PATHS, name) ? MANAGEMENT_PATHS[name] : null;
    if (!profile && !path) throw new Error('Unknown account action');
    const response = await fetch(new URL(profile ? 'api/profile' : `api/admin/${path}`, import.meta.url), {
        method: profile ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(!profile ? { 'Content-Type': 'application/json' } : {}) },
        ...(!profile ? { body: JSON.stringify(args) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true || payload.result?.ok === false) {
        const error = new Error(payload.error || payload.result?.error || 'Unable to complete this request.');
        error.statusCode = response.status;
        error.code = payload.error;
        error.payload = payload;
        throw error;
    }
    return profile ? payload.profile : payload.result;
}

export function updateAccountNavigation(document, profile) {
    (document.querySelectorAll?.('[data-capability]') || []).forEach((link) => {
        link.hidden = !profile?.capabilities?.includes(link.dataset.capability);
    });
    const parameters = new URLSearchParams(document.defaultView?.location?.search || '');
    const view = parameters.get('view');
    const configured = view === 'account' || view === 'administration';
    (document.querySelectorAll?.('.account-navigation a') || []).forEach((link) => {
        const capability = link.dataset.capability;
        const allowed = !capability || profile?.capabilities?.includes(capability);
        link.hidden = !allowed || view === 'account'
            || (view === 'administration' && !capability);
        const destination = new URL(link.getAttribute('href'), document.baseURI);
        if (destination.origin !== new URL(document.baseURI).origin) return;
        if (configured) destination.searchParams.set('view', view);
        if (parameters.get('showSignOut') === '0') destination.searchParams.set('showSignOut', '0');
        link.setAttribute('href', destination.pathname + destination.search + destination.hash);
    });
}
