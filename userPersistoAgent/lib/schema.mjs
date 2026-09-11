const ensuredStores = new WeakSet();

// Field lists are documentation; Persisto does NOT enforce them. Validation lives in the domain modules.
export const TYPES = {
    user: { email: 'string', username: 'string', displayName: 'string', status: 'string', source: 'string', createdAt: 'string', updatedAt: 'string', emailVerifiedAt: 'string', passwordHash: 'string', loginAttempts: 'integer', lastLoginAttempt: 'string' },
    role: { name: 'string', description: 'string', priority: 'integer' },
    permission: { capability: 'string', description: 'string', scope: 'string' },
    userRole: { key: 'string', userId: 'string', roleId: 'string' },
    rolePermission: { key: 'string', roleId: 'string', permissionId: 'string' },
    authMethod: { key: 'string', userId: 'string', type: 'string', credential: 'object', enabled: 'boolean' },
    authChallenge: { challengeId: 'string', subject: 'string', purpose: 'string', codeHash: 'string', expiresAt: 'string', attempts: 'integer', correlationId: 'string' },
    systemSetting: { key: 'string', value: 'object', updatedAt: 'string', updatedBy: 'string' },
    creditAccount: { userId: 'string', balance: 'integer', reservedBalance: 'integer' },
    creditTx: { txId: 'string', userId: 'string', sequence: 'integer', type: 'string', amount: 'integer', reason: 'string', referenceId: 'string', balanceAfter: 'integer', reservedAfter: 'integer', createdAt: 'string' },
    creditReservation: { reservationId: 'string', referenceId: 'string', userId: 'string', amount: 'integer', status: 'string', reason: 'string', createdAt: 'string', updatedAt: 'string' },
    paymentTransaction: { providerKey: 'string', provider: 'string', providerEventId: 'string', providerObjectId: 'string', userId: 'string', kind: 'string', status: 'string', amountMinor: 'integer', currency: 'string', credits: 'integer', createdAt: 'string', updatedAt: 'string' },
    checkoutIntent: { intentKey: 'string', requestHash: 'string', userId: 'string', kind: 'string', units: 'integer', credits: 'integer', form: 'object', sessionId: 'string', checkoutUrl: 'string', createdAt: 'string', updatedAt: 'string' },
    subscription: { providerRef: 'string', userId: 'string', provider: 'string', planId: 'string', status: 'string', currentPeriodEnd: 'string', reconciledAt: 'string', sourceEventId: 'string' },
    billingEvent: { stripeEventId: 'string', type: 'string', status: 'string', payloadHash: 'string', processedAt: 'string' },
    emailLog: { logId: 'string', providerMessageId: 'string', toEmailHash: 'string', template: 'string', result: 'string', correlationId: 'string', createdAt: 'string' },
    auditEvent: { auditId: 'string', actorId: 'string', action: 'string', target: 'string', result: 'string', reason: 'string', timestamp: 'string' },
    ssoLoginRequest: { providerState: 'string', redirectUri: 'string', clientId: 'string', expiresAt: 'string' },
    ssoAuthCode: { code: 'string', providerState: 'string', userId: 'string', expiresAt: 'string', consumedAt: 'string' },
    oidcRecord: { recordKey: 'string', model: 'string', payload: 'string', expiresAt: 'integer', grantHash: 'string', clientHash: 'string', uidHash: 'string', userCodeHash: 'string' },
    externalIdentity: { identityKey: 'string', issuer: 'string', subject: 'string', userId: 'string', createdAt: 'string', lastUsedAt: 'string' },
    googleAuthTransaction: { stateHash: 'string', status: 'string', expiresAt: 'integer', payload: 'string', version: 'integer' },
};

const INDEXES = [
    ['user', 'email'],
    ['role', 'name'],
    ['permission', 'capability'],
    ['userRole', 'key'],
    ['rolePermission', 'key'],
    ['authMethod', 'key'],
    ['authChallenge', 'challengeId'],
    ['systemSetting', 'key'],
    ['creditAccount', 'userId'],
    ['creditTx', 'txId'],
    ['creditReservation', 'reservationId'],
    ['paymentTransaction', 'providerKey'],
    ['checkoutIntent', 'intentKey'],
    ['subscription', 'providerRef'],
    ['billingEvent', 'stripeEventId'],
    ['emailLog', 'logId'],
    ['auditEvent', 'auditId'],
    ['ssoLoginRequest', 'providerState'],
    ['ssoAuthCode', 'code'],
    ['oidcRecord', 'recordKey'],
    ['externalIdentity', 'identityKey'],
    ['googleAuthTransaction', 'stateHash'],
];

// [groupingName, type, field] -> get<Grouping>ObjectsBy<Field>()
const GROUPINGS = [
    ['userRoles', 'userRole', 'userId'],
    ['rolePerms', 'rolePermission', 'roleId'],
    ['authMethods', 'authMethod', 'userId'],
    ['creditHistory', 'creditTx', 'userId'],
    ['creditReservations', 'creditReservation', 'userId'],
    ['paymentTransactions', 'paymentTransaction', 'userId'],
    ['subscriptions', 'subscription', 'userId'],
    ['auditTrail', 'auditEvent', 'actorId'],
    ['oidcModels', 'oidcRecord', 'model'],
    ['oidcGrants', 'oidcRecord', 'grantHash'],
    ['oidcClients', 'oidcRecord', 'clientHash'],
    ['externalIdentities', 'externalIdentity', 'userId'],
];

export async function ensureSchema(persisto) {
    if (ensuredStores.has(persisto)) {
        return persisto;
    }
    persisto.configureTypes(TYPES);
    for (const [type, field] of INDEXES) {
        await persisto.createIndex(type, field);
    }
    for (const [name, type, field] of GROUPINGS) {
        await persisto.createGrouping(name, type, field);
    }
    ensuredStores.add(persisto);
    return persisto;
}
