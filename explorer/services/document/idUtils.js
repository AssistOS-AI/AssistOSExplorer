import { createSecureUuid } from '../../shared/libs/webskel/webskel.mjs';

export const generateId = (prefix = 'id') => {
    return `${prefix}-${createSecureUuid()}`;
};

export default {
    generateId
};
