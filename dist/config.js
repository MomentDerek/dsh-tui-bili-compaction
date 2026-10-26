import { defaultConfig } from './kernel.js';
export const DEFAULT_MODEL_CONTEXT_LIMIT = 1_000_000;
const DEFAULT_TRIGGER_PCT = 0.2;
const DEFAULT_TARGET_PCT = 0.1;
function ratio(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}
export function resolveOptions(raw) {
    const limit = raw?.modelContextLimit;
    const explicitLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;
    const triggerPct = ratio(raw?.autoFold?.triggerPct, DEFAULT_TRIGGER_PCT);
    const targetPct = Math.min(ratio(raw?.autoFold?.targetPct, DEFAULT_TARGET_PCT), triggerPct);
    return {
        modelContextLimit: explicitLimit ?? DEFAULT_MODEL_CONTEXT_LIMIT,
        modelContextLimitExplicit: explicitLimit !== undefined,
        kernel: raw?.kernel ?? {},
        disableNativeCompaction: raw?.disableNativeCompaction !== false,
        storageDir: typeof raw?.storageDir === 'string' && raw.storageDir.length > 0 ? raw.storageDir : undefined,
        languagePreservation: raw?.languagePreservation === true,
        injectNudge: raw?.injectNudge === true,
        autoFold: { enabled: raw?.autoFold?.enabled === true, triggerPct, targetPct },
    };
}
export function buildKernelConfig(options) {
    return defaultConfig(options.modelContextLimit, options.kernel);
}
//# sourceMappingURL=config.js.map