import { defaultConfig } from './kernel.js';
export const DEFAULT_MODEL_CONTEXT_LIMIT = 1_000_000;
/** Fold once the surface passes 40% of the window, back down to 20%. */
const DEFAULT_TRIGGER_PCT = 0.4;
const DEFAULT_TARGET_PCT = 0.2;
/** Nudge cadence the plugin runs on: warn from 20%, press from 40%, emergency
 *  at 50%. The growth gate is proportional to the window: `growthRatio` 0.1
 *  with a 20K floor, so a 1M window re-nudges every ~10% while a small window
 *  still gets the short-turn floor. The cap is wide enough not to flatten the
 *  ratio on large windows. */
const DEFAULT_NUDGE = {
    minContextLimitPct: 0.2,
    maxContextLimitPct: 0.4,
    emergencyThresholdPct: 0.5,
    growthFloor: 2e4,
    growthCap: 1e6,
    growthRatio: 0.1,
};
/** Resolve the growth gate for one window: keep the operator's floor/cap, but
 *  let the ratio win on large windows. Returns the pair the kernel reads as
 *  both the T1 compressible-mass threshold and the re-nudge increment. */
export function resolveGrowthGate(nudge, modelContextLimit) {
    const growth = Math.min(nudge.growthCap, Math.max(nudge.growthFloor, Math.round(modelContextLimit * nudge.growthRatio)));
    return { floor: growth, cap: growth };
}
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
        injectNudge: raw?.injectNudge !== false,
        autoFold: { enabled: raw?.autoFold?.enabled !== false, triggerPct, targetPct },
    };
}
export function buildKernelConfig(options) {
    const config = defaultConfig(options.modelContextLimit, options.kernel);
    // The plugin defaults sit between the kernel's own and the profile's
    // explicit `kernel.nudge`, so any field the profile sets still wins.
    return { ...config, nudge: { ...config.nudge, ...DEFAULT_NUDGE, ...options.kernel.nudge } };
}
//# sourceMappingURL=config.js.map