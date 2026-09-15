import { getSecret } from './settings.mjs';

function normalizeEmail(value, field = 'email') {
    const email = String(value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new Error(`${field} must be a valid email address.`);
    }
    return email;
}

async function getConfig() {
    const apiKey = await getSecret('MAILJET_API_KEY');
    const apiSecret = await getSecret('MAILJET_API_SECRET');
    const fromEmail = await getSecret('MAILJET_FROM_EMAIL');
    const fromName = await getSecret('MAILJET_FROM_NAME') || 'Ploinky';
    return { apiKey, apiSecret, fromEmail, fromName };
}

function providerMessageId(payload) {
    const to = payload?.Messages?.[0]?.To?.[0];
    return String(to?.MessageID || to?.MessageUUID || payload?.Messages?.[0]?.MessageID || '');
}

async function sendMailjetMessage(message) {
    const config = await getConfig();
    const missing = Object.entries({
        MAILJET_API_KEY: config.apiKey,
        MAILJET_API_SECRET: config.apiSecret,
        MAILJET_FROM_EMAIL: config.fromEmail,
    }).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
        throw new Error(`Missing EmailAgent settings: ${missing.join(', ')}.`);
    }

    const auth = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');
    const response = await fetch('https://api.mailjet.com/v3.1/send', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ Messages: [message] }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload?.ErrorMessage || payload?.Messages?.[0]?.Errors?.[0]?.ErrorMessage || `Mailjet failed with ${response.status}.`);
    }
    return { providerMessageId: providerMessageId(payload) };
}

export async function providerStatus() {
    const config = await getConfig();
    return {
        configured: Boolean(config.apiKey && config.apiSecret && config.fromEmail),
        fromEmail: config.fromEmail || '',
    };
}

export async function sendText(input = {}) {
    const config = await getConfig();
    const to = normalizeEmail(input.to, 'to');
    const subject = String(input.subject || '').trim();
    const text = String(input.text || '');
    const html = input.html === undefined || input.html === null ? '' : String(input.html);
    if (!subject) throw new Error('subject is required.');
    if (!text && !html) throw new Error('text or html is required.');

    return sendMailjetMessage({
        From: { Email: normalizeEmail(config.fromEmail, 'fromEmail'), Name: config.fromName },
        To: [{ Email: to }],
        Subject: subject,
        ...(text ? { TextPart: text } : {}),
        ...(html ? { HTMLPart: html } : {}),
    });
}

export async function sendTemplate(input = {}) {
    const config = await getConfig();
    const to = normalizeEmail(input.to, 'to');
    const templateId = Number(input.templateId);
    if (!Number.isFinite(templateId) || templateId <= 0) {
        throw new Error('templateId is required.');
    }

    return sendMailjetMessage({
        From: { Email: normalizeEmail(config.fromEmail, 'fromEmail'), Name: config.fromName },
        To: [{ Email: to }],
        TemplateID: templateId,
        TemplateLanguage: true,
        Variables: input.variables && typeof input.variables === 'object' ? input.variables : {},
    });
}
