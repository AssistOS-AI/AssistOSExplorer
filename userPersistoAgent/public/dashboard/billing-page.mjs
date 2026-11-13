import {UserpersistoBillingPresenter} from './billing.mjs';
import {callManagementTool, updateAccountNavigation} from './api.mjs';
const presenter = new UserpersistoBillingPresenter(document.querySelector('#billing-root'), () => {}, async (name, args) => {
    const result = await callManagementTool(name, args);
    if (name === 'userpersisto_profile_get') updateAccountNavigation(document, result);
    return result;
});
await presenter.beforeRender();
await presenter.afterRender();
addEventListener('pagehide', () => presenter.afterUnload());
