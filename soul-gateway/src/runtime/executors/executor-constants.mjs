export const EXECUTOR_TYPES = Object.freeze({
  EXTERNAL_API: 'external_api',
  SEARCH: 'search',
  LOCAL_MODEL: 'local_model',
  // DEPRECATED: WRAPPER — kept for backward compatibility only.
  // Wrapping behavior should be expressed as provider hooks, not executors.
  // Existing code that checks executorType === 'wrapper' still works,
  // but new code should not create executors with this type.
  WRAPPER: 'wrapper',
  CUSTOM: 'custom',
});
