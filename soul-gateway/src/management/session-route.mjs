import { sendJson } from '../core/responses.mjs';
import { managementUserView } from './management-user.mjs';

export async function handleManagementMe(ctx) {
    sendJson(ctx.res, 200, {
        authenticated: true,
        source: ctx.managementAuth?.source || 'router-sso',
        user: managementUserView(ctx.managementAuth),
    });
}
