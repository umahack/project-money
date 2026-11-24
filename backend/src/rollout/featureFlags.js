const ENABLED_FLAG_VALUES = new Set(['1', 'true']);

/**
 * Environment flags fail closed: absent, malformed, or unsupported values keep
 * rollout behavior disabled.
 */
export function readBooleanFeatureFlag(value) {
  return typeof value === 'string'
    && ENABLED_FLAG_VALUES.has(value.trim().toLowerCase());
}

export function readServerFeatureFlags(environment = process.env) {
  return Object.freeze({
    clarityShadowCompare: readBooleanFeatureFlag(environment?.CLARITY_SHADOW_COMPARE),
    quickAddEnabled: readBooleanFeatureFlag(environment?.QUICK_ADD_ENABLED),
  });
}
