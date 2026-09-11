import crypto from 'node:crypto';
import { credentialVersion } from './credentialVersion.mjs';
import { getStore, flush } from '../store.mjs';
import { getUserByEmail, getUserById, sanitizeUser } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { assertBrowserOriginAllowed } from '../policy.mjs';
import { serialize } from '../serial.mjs';

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_RP_NAME = 'UserPersisto';

function base64urlEncode(value) {
    return Buffer.from(value)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/g, '');
}

function base64urlDecode(value) {
    const text = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
    return Buffer.from(text + '='.repeat((4 - (text.length % 4)) % 4), 'base64');
}

function normalizeRpId(input = {}) {
    const rpId = String(input.rpId || '').trim();
    if (rpId) {
        return rpId;
    }
    const origin = String(input.origin || '').trim();
    if (origin) {
        return new URL(origin).hostname;
    }
    return 'localhost';
}

function normalizeOrigin(input = {}) {
    const origin = String(input.origin || '').trim();
    if (!origin) {
        return '';
    }
    return new URL(origin).origin;
}

function isIpAddress(value) {
    const host = String(value || '').trim();
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
        return true;
    }
    return host.includes(':');
}

function publicRpId(rpId) {
    return isIpAddress(rpId) ? '' : rpId;
}

function assertRpIdMatchesOrigin(rpId, origin) {
    if (!origin) return;
    const hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const normalizedRpId = String(rpId || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === normalizedRpId || (!isIpAddress(normalizedRpId) && hostname.endsWith(`.${normalizedRpId}`))) return;
    throw Object.assign(new Error('WebAuthn relying party id does not match the browser origin.'), {
        code: 'invalid_webauthn_rp_id',
        statusCode: 400,
    });
}

function requireClientData(response = {}, expectedType, challenge, origin) {
    if (typeof response.clientDataJSON !== 'string' || !response.clientDataJSON) {
        throw new Error('Invalid WebAuthn client data.');
    }
    const clientDataBuffer = base64urlDecode(response.clientDataJSON);
    if (base64urlEncode(clientDataBuffer) !== response.clientDataJSON) {
        throw new Error('Invalid WebAuthn client data encoding.');
    }
    const clientData = JSON.parse(clientDataBuffer.toString('utf8'));
    if (!clientData || typeof clientData !== 'object' || Array.isArray(clientData)) {
        throw new Error('Invalid WebAuthn client data.');
    }
    if (clientData.type !== expectedType) {
        throw new Error(`Invalid WebAuthn response type: ${clientData.type || 'missing'}.`);
    }
    if (typeof clientData.challenge !== 'string' || !clientData.challenge || (challenge !== undefined && clientData.challenge !== challenge)) {
        throw new Error('Invalid WebAuthn challenge.');
    }
    if (origin && clientData.origin !== origin) {
        throw new Error('Invalid WebAuthn origin.');
    }
    return { clientData, clientDataBuffer };
}

function readUInt(buffer, offset, length) {
    let value = 0;
    for (let index = 0; index < length; index += 1) {
        value = (value << 8) | buffer[offset + index];
    }
    return value;
}

class CborReader {
    constructor(buffer) {
        this.buffer = Buffer.from(buffer);
        this.offset = 0;
    }

    readByte() {
        if (this.offset >= this.buffer.length) {
            throw new Error('Unexpected end of CBOR data.');
        }
        return this.buffer[this.offset++];
    }

    readLength(additional) {
        if (additional < 24) {
            return additional;
        }
        if (additional === 24) {
            return this.readByte();
        }
        if (additional === 25) {
            const value = readUInt(this.buffer, this.offset, 2);
            this.offset += 2;
            return value;
        }
        if (additional === 26) {
            const value = readUInt(this.buffer, this.offset, 4);
            this.offset += 4;
            return value;
        }
        throw new Error('Unsupported CBOR length.');
    }

    read() {
        const initial = this.readByte();
        const major = initial >> 5;
        const additional = initial & 0x1f;
        if (major === 0) {
            return this.readLength(additional);
        }
        if (major === 1) {
            return -1 - this.readLength(additional);
        }
        if (major === 2) {
            const length = this.readLength(additional);
            const value = this.buffer.subarray(this.offset, this.offset + length);
            this.offset += length;
            return Buffer.from(value);
        }
        if (major === 3) {
            const length = this.readLength(additional);
            const value = this.buffer.subarray(this.offset, this.offset + length).toString('utf8');
            this.offset += length;
            return value;
        }
        if (major === 4) {
            const length = this.readLength(additional);
            const value = [];
            for (let index = 0; index < length; index += 1) {
                value.push(this.read());
            }
            return value;
        }
        if (major === 5) {
            const length = this.readLength(additional);
            const value = new Map();
            for (let index = 0; index < length; index += 1) {
                value.set(this.read(), this.read());
            }
            return value;
        }
        if (major === 7) {
            if (additional === 20) {
                return false;
            }
            if (additional === 21) {
                return true;
            }
            if (additional === 22) {
                return null;
            }
        }
        throw new Error('Unsupported CBOR item.');
    }
}

function decodeCbor(buffer) {
    return new CborReader(buffer).read();
}

function mapGet(map, key) {
    if (!(map instanceof Map)) {
        return undefined;
    }
    return map.get(key);
}

function parseAuthenticatorData(authData) {
    const buffer = Buffer.from(authData);
    if (buffer.length < 37) {
        throw new Error('Invalid authenticator data.');
    }
    const rpIdHash = buffer.subarray(0, 32);
    const flags = buffer[32];
    const counter = buffer.readUInt32BE(33);
    let offset = 37;
    let credential = null;
    if (flags & 0x40) {
        const aaguid = buffer.subarray(offset, offset + 16);
        offset += 16;
        const credentialIdLength = buffer.readUInt16BE(offset);
        offset += 2;
        const credentialId = buffer.subarray(offset, offset + credentialIdLength);
        offset += credentialIdLength;
        const cosePublicKey = buffer.subarray(offset);
        credential = { aaguid, credentialId, cosePublicKey };
    }
    return { rpIdHash, flags, counter, credential };
}

function assertRpIdHash(authData, rpId) {
    const expected = crypto.createHash('sha256').update(rpId).digest();
    if (!crypto.timingSafeEqual(authData.rpIdHash, expected)) {
        throw new Error('Invalid WebAuthn relying party id.');
    }
}

function coseToJwk(cosePublicKey) {
    const map = decodeCbor(cosePublicKey);
    const kty = mapGet(map, 1);
    const alg = mapGet(map, 3);
    if (kty === 2 && alg === -7) {
        const crv = mapGet(map, -1);
        const x = mapGet(map, -2);
        const y = mapGet(map, -3);
        if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) {
            throw new Error('Unsupported EC WebAuthn public key.');
        }
        return {
            alg,
            jwk: {
                kty: 'EC',
                crv: 'P-256',
                x: base64urlEncode(x),
                y: base64urlEncode(y)
            }
        };
    }
    if (kty === 3 && alg === -257) {
        const n = mapGet(map, -1);
        const e = mapGet(map, -2);
        if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) {
            throw new Error('Unsupported RSA WebAuthn public key.');
        }
        return {
            alg,
            jwk: {
                kty: 'RSA',
                n: base64urlEncode(n),
                e: base64urlEncode(e)
            }
        };
    }
    throw new Error(`Unsupported WebAuthn COSE key algorithm: ${alg}.`);
}

function verifySignature({ alg, publicKeyJwk, signature, signedData }) {
    const key = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' });
    const algorithm = alg === -7 ? 'sha256' : 'RSA-SHA256';
    return crypto.verify(algorithm, signedData, key, signature);
}

async function storeChallenge({ userId = '', email = '', type, rpId, origin }) {
    const store = await getStore();
    const challenge = base64urlEncode(crypto.randomBytes(32));
    const challengeId = crypto.randomUUID();
    await store.createAuthChallenge({
        challengeId,
        subject: userId || `email:${email}`,
        purpose: 'webauthn',
        codeHash: challenge,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
        attempts: 0,
        correlationId: JSON.stringify({ type, rpId, origin, email })
    });
    await flush();
    return { challengeId, challenge };
}

async function challengeMatches(record, { challenge, challengeKey, type, userId = '' }) {
    if (!record || record.purpose !== 'webauthn') {
        return false;
    }
    if (challengeKey && record.challengeId !== challengeKey) {
        return false;
    }
    if (challenge && record.codeHash !== challenge) {
        return false;
    }
    if (userId && record.subject !== userId) {
        return false;
    }
    const metadata = JSON.parse(record.correlationId || '{}');
    return metadata.type === type;
}

async function findChallenge({ challenge, challengeKey, type, userId = '' }) {
    const store = await getStore();
    if (challengeKey) {
        const record = await store.getAuthChallengeByChallengeId(challengeKey);
        return (await challengeMatches(record, { challenge, challengeKey, type, userId })) ? record : null;
    }
    const pageSize = 500;
    let start = 0;
    while (true) {
        const selected = await store.select('authChallenge', { purpose: 'webauthn' }, { start, pageSize });
        const objects = selected.objects || [];
        for (const record of objects) {
            if (await challengeMatches(record, { challenge, type, userId })) return record;
        }
        start += objects.length;
        const totalCount = Number(selected.filteredCount ?? selected.totalCount);
        if (!objects.length || (Number.isFinite(totalCount) && start >= totalCount) || objects.length < pageSize) return null;
    }
}

function consumeChallenge({ challenge, challengeKey, type, userId = '' }) {
    const lockKey = String(challengeKey || challenge || `${type}:${userId}`);
    return serialize(`webauthn-challenge:${lockKey}`, async () => {
        const store = await getStore();
        const record = await findChallenge({ challenge, challengeKey, type, userId });
        if (!record) throw new Error('WebAuthn challenge not found.');
        if (new Date(record.expiresAt).getTime() < Date.now()) {
            await store.deleteAuthChallenge(record.id);
            await flush();
            throw new Error('WebAuthn challenge expired.');
        }
        await store.deleteAuthChallenge(record.id);
        await flush();
        return { ...record, metadata: JSON.parse(record.correlationId || '{}') };
    });
}

async function authMethodsForUser(userId) {
    return await (await getStore()).getAuthMethodsObjectsByUserId(userId) || [];
}

async function findCredentialById(credentialId, userId = '') {
    if (userId) {
        const methods = await authMethodsForUser(userId);
        return methods.find((method) => method.type === 'passkey' && method.credential?.credentialId === credentialId) || null;
    }
    const store = await getStore();
    const pageSize = 500;
    let start = 0;
    while (true) {
        const selected = await store.select('authMethod', { type: 'passkey' }, { start, pageSize });
        const objects = selected.objects || [];
        const match = objects.find((method) => method.credential?.credentialId === credentialId);
        if (match) return match;
        start += objects.length;
        const totalCount = Number(selected.filteredCount ?? selected.totalCount);
        if (!objects.length || (Number.isFinite(totalCount) && start >= totalCount) || objects.length < pageSize) return null;
    }
}

export async function registrationOptions({ userId, origin = '', rpId = '', rpName = DEFAULT_RP_NAME }) {
    const user = await getUserById(userId);
    if (!user) {
        throw new Error(`Unknown user: ${userId}`);
    }
    const resolvedRpId = normalizeRpId({ rpId, origin });
    const browserRpId = publicRpId(resolvedRpId);
    const normalizedOrigin = normalizeOrigin({ origin });
    if (normalizedOrigin) await assertBrowserOriginAllowed(normalizedOrigin);
    assertRpIdMatchesOrigin(resolvedRpId, normalizedOrigin);
    const { challengeId, challenge } = await storeChallenge({
        userId: user.id,
        email: user.email,
        type: 'registration',
        rpId: resolvedRpId,
        origin: normalizedOrigin
    });
    const existing = (await authMethodsForUser(user.id))
        .filter((method) => method.type === 'passkey')
        .map((method) => ({ type: 'public-key', id: method.credential.credentialId }));
    const rp = { name: rpName };
    if (browserRpId) {
        rp.id = browserRpId;
    }
    return {
        ok: true,
        challengeKey: challengeId,
        publicKey: {
            challenge,
            rp,
            user: {
                id: base64urlEncode(Buffer.from(user.id)),
                name: user.email,
                displayName: user.displayName || user.email
            },
            pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 }
            ],
            excludeCredentials: existing,
            timeout: CHALLENGE_TTL_MS,
            attestation: 'none',
            authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'preferred'
            }
        }
    };
}

export async function registrationVerify({ userId, attestation, challengeKey, origin = '' }) {
    const credential = attestation || {};
    const response = credential.response || {};
    const { clientData, clientDataBuffer } = requireClientData(response, 'webauthn.create', undefined, undefined);
    const challengeRecord = await consumeChallenge({
        challenge: clientData.challenge,
        challengeKey,
        type: 'registration',
        userId
    });
    const expectedOrigin = String(challengeRecord.metadata.origin || '');
    if (expectedOrigin) await assertBrowserOriginAllowed(expectedOrigin);
    if (origin && normalizeOrigin({ origin }) !== expectedOrigin) throw new Error('WebAuthn origin changed during registration.');
    requireClientData(response, 'webauthn.create', challengeRecord.codeHash, expectedOrigin);

    const attestationObject = decodeCbor(base64urlDecode(response.attestationObject));
    const authData = parseAuthenticatorData(mapGet(attestationObject, 'authData'));
    assertRpIdHash(authData, challengeRecord.metadata.rpId);
    if (!(authData.flags & 0x01)) {
        throw new Error('WebAuthn user presence was not verified.');
    }
    if (!authData.credential) {
        throw new Error('WebAuthn attested credential data is missing.');
    }

    const { alg, jwk } = coseToJwk(authData.credential.cosePublicKey);
    const credentialId = base64urlEncode(authData.credential.credentialId);
    const existing = await findCredentialById(credentialId);
    if (existing && existing.userId !== userId) {
        throw new Error('Passkey credential is already registered.');
    }
    const key = `${userId}:passkey:${credentialId}`;
    const payload = {
        userId,
        type: 'passkey',
        credential: {
            credentialId,
            publicKeyJwk: jwk,
            alg,
            counter: authData.counter,
            transports: response.transports || [],
            clientDataHash: base64urlEncode(crypto.createHash('sha256').update(clientDataBuffer).digest())
        },
        enabled: true
    };
    const store = await getStore();
    const saved = existing
        ? await store.updateAuthMethod(existing.id, payload)
        : await store.createAuthMethod({ key, ...payload });
    await recordAudit({ actorId: userId, action: 'auth.passkey.register', target: userId, result: 'ok', reason: credentialId });
    await flush();
    return { ok: true, credential: { key: saved.key, userId: saved.userId, credentialId, counter: authData.counter } };
}

export async function loginOptions({ email, origin = '', rpId = '', purpose = 'login' }) {
    const user = await getUserByEmail(email);
    if (!user) {
        return { ok: false, reason: 'invalid_credentials' };
    }
    if (user.status !== 'active') {
        return { ok: false, reason: 'user_blocked' };
    }
    const methods = (await authMethodsForUser(user.id)).filter((method) => method.type === 'passkey' && method.enabled);
    if (methods.length === 0) {
        return { ok: false, reason: 'passkey_not_configured' };
    }
    const resolvedRpId = normalizeRpId({ rpId, origin });
    const browserRpId = publicRpId(resolvedRpId);
    const normalizedOrigin = normalizeOrigin({ origin });
    if (normalizedOrigin) await assertBrowserOriginAllowed(normalizedOrigin);
    assertRpIdMatchesOrigin(resolvedRpId, normalizedOrigin);
    const { challengeId, challenge } = await storeChallenge({
        userId: user.id,
        email: user.email,
        type: purpose,
        rpId: resolvedRpId,
        origin: normalizedOrigin
    });
    const publicKey = {
        challenge,
        timeout: CHALLENGE_TTL_MS,
        userVerification: 'preferred',
        allowCredentials: methods.map((method) => ({
            type: 'public-key',
            id: method.credential.credentialId,
            transports: method.credential.transports || undefined
        }))
    };
    if (browserRpId) {
        publicKey.rpId = browserRpId;
    }
    return { ok: true, challengeKey: challengeId, publicKey };
}

export async function loginVerify({ email, assertion, challengeKey, origin = '', purpose = 'login' }, { includeCredentialProof = false } = {}) {
    const user = await getUserByEmail(email);
    if (!user) {
        return { ok: false, reason: 'invalid_credentials' };
    }
    if (user.status !== 'active') {
        return { ok: false, reason: 'user_blocked' };
    }
    try {
        const credential = assertion || {};
        const response = credential.response || {};
        const { clientData, clientDataBuffer } = requireClientData(response, 'webauthn.get', undefined, undefined);
        const challengeRecord = await consumeChallenge({
            challenge: clientData.challenge,
            challengeKey,
            type: purpose,
            userId: user.id
        });
        const expectedOrigin = String(challengeRecord.metadata.origin || '');
        if (expectedOrigin) await assertBrowserOriginAllowed(expectedOrigin);
        if (origin && normalizeOrigin({ origin }) !== expectedOrigin) throw new Error('WebAuthn origin changed during login.');
        requireClientData(response, 'webauthn.get', challengeRecord.codeHash, expectedOrigin);
        const credentialId = credential.id || credential.rawId;
        const authDataBuffer = base64urlDecode(response.authenticatorData);
        const authData = parseAuthenticatorData(authDataBuffer);
        assertRpIdHash(authData, challengeRecord.metadata.rpId);
        if (!(authData.flags & 0x01)) {
            throw new Error('WebAuthn user presence was not verified.');
        }
        const clientHash = crypto.createHash('sha256').update(clientDataBuffer).digest();
        const signedData = Buffer.concat([authDataBuffer, clientHash]);
        let version;
        await serialize(`webauthn-credential:${user.id}:${credentialId}`, async () => {
            const stored = await findCredentialById(credentialId, user.id);
            if (!stored || !stored.enabled) throw new Error('Passkey is not registered.');
            if (Number(stored.credential.counter || 0) > 0 && authData.counter <= Number(stored.credential.counter || 0)) {
                throw new Error('WebAuthn authenticator counter did not advance.');
            }
            const valid = verifySignature({
                alg: Number(stored.credential.alg),
                publicKeyJwk: stored.credential.publicKeyJwk,
                signature: base64urlDecode(response.signature),
                signedData
            });
            if (!valid) throw new Error('Invalid WebAuthn signature.');
            if (includeCredentialProof) version = credentialVersion('passkey', stored.credential);
            await (await getStore()).updateAuthMethod(stored.id, {
                credential: { ...stored.credential, counter: authData.counter }
            });
        });
        await recordAudit({ actorId: user.id, action: 'auth.passkey.login', target: user.id, result: 'ok', reason: credentialId });
        await flush();
        return { ok: true, user: sanitizeUser(user), credentialKey: `${user.id}:passkey:${credentialId}`,
            ...(includeCredentialProof ? { credentialVersion: version } : {}) };
    } catch (error) {
        await recordAudit({ actorId: user.id, action: 'auth.passkey.login', target: user.id, result: 'denied', reason: error.message });
        return { ok: false, reason: error.message };
    }
}
