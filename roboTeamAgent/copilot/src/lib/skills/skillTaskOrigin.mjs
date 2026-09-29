import { AsyncLocalStorage } from 'node:async_hooks';

const origins = new AsyncLocalStorage();
export const getSkillRuntimeOrigin = () => origins.getStore() || null;
export const runWithSkillRuntimeOrigin = (origin, callback) => origins.run(origin, callback);
