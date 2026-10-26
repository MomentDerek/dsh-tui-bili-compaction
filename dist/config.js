import { defaultConfig } from './kernel.js';
export const DEFAULT_MODEL_CONTEXT_LIMIT = 1_000_000;
export function resolveOptions(raw) {
    const limit = raw?.modelContextLimit;
    const explicitLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;
    return {
        modelContextLimit: explicitLimit ?? DEFAULT_MODEL_CONTEXT_LIMIT,
        modelContextLimitExplicit: explicitLimit !== undefined,
        kernel: raw?.kernel ?? {},
        disableNativeCompaction: raw?.disableNativeCompaction !== false,
        storageDir: typeof raw?.storageDir === 'string' && raw.storageDir.length > 0 ? raw.storageDir : undefined,
        languagePreservation: raw?.languagePreservation === true,
        injectNudge: raw?.injectNudge === true,
    };
}
export function buildKernelConfig(options) {
    return defaultConfig(options.modelContextLimit, options.kernel);
}
//# sourceMappingURL=config.js.map