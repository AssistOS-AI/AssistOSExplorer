import { stdin, stdout, env, exit } from 'node:process';
import { getSettings, saveSettings, getSecret } from '../lib/settings.mjs';
import { sendText, sendTemplate, providerStatus } from '../lib/mailjet.mjs';
import { assertEmailToolAuthorized, authInfoFromEnvelope } from './invocation-context.mjs';

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
const name = env.TOOL_NAME || payload.name;
const args = payload.input ?? payload.arguments ?? {};

const HANDLERS = {
    email_config_get: () => getSettings(),
    email_config_set: async () => {
        await saveSettings(args);
        return getSettings();
    },
    email_provider_status: () => providerStatus(),
    email_auth_code_status: async () => {
        const status = await providerStatus();
        const templateId = await getSecret('EMAIL_AUTH_CODE_TEMPLATE_ID');
        // Internal callers need one availability bit, never provider settings,
        // sender addresses or credentials. This probe does not send email.
        return { available: status.configured && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(status.fromEmail)
            && (!templateId || (Number.isFinite(Number(templateId)) && Number(templateId) > 0)) };
    },
    email_send_text: () => sendText({ to: args.to, subject: args.subject, text: args.text, html: args.html }),
    email_send_template: () => sendTemplate({ to: args.to, templateId: args.templateId, variables: args.variables || {} }),
    email_send_test: () => sendText({ to: args.to, subject: 'EmailAgent test', text: 'EmailAgent test email.' }),
    email_send_auth_code: async () => {
        const templateId = await getSecret('EMAIL_AUTH_CODE_TEMPLATE_ID');
        const result = templateId
            ? await sendTemplate({ to: args.to, templateId, variables: { code: args.code } })
            : await sendText({ to: args.to, subject: 'Your authentication code', text: `Your authentication code is: ${args.code}` });
        return { providerMessageId: result.providerMessageId, correlationId: args.correlationId || '' };
    },
};

try {
    assertEmailToolAuthorized(name, await authInfoFromEnvelope(payload));
    const handler = HANDLERS[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    stdout.write(JSON.stringify(await handler() ?? {}));
} catch (error) {
    stdout.write(JSON.stringify({ error: error.message }));
    exit(1);
}
