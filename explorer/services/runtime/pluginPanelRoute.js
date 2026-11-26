import { readPluginPanelRequest } from '../../shared/ui/plugin-panel-navigation.js';
import { openPluginPanel } from '../../web-components/pages/file-exp/file-exp-application-plugins.js';

export async function openPluginPanelFromLocation({ location, openModal }) {
    const request = readPluginPanelRequest(location);
    if (!request) return false;
    const opening = openPluginPanel(request.pluginKey, { panelNavigation: { path: request.path } }, openModal);
    const dialog = await opening?.opened;
    if (dialog === null) throw new Error('This plugin panel could not be opened. Please try again.');
    return true;
}
