import type { DshSessionLike, DshTokenMeasurement, DshToolDefinition } from './dsh-types.js';
import type { CompactionEngine } from './engine.js';
export interface ToolHost {
    register(definition: DshToolDefinition): () => void;
}
export interface ToolOptions {
    /** Fallback session lookup when the tool run context carries no agent. */
    currentSession?: () => DshSessionLike | undefined;
    /** dsh's token meter, when the profile plane can reach it. */
    measure?: (session: DshSessionLike) => DshTokenMeasurement | undefined;
}
/**
 * Register the kernel's compress/decompress/acp_status surface as dsh tools.
 *
 * The schemas are the kernel's own (`COMPRESS_TOOL` and friends), so the model
 * sees exactly the argument shapes billon-context's proxy advertises; only the
 * transport changes (an in-process tool instead of an HTTP manifest).
 */
export declare function registerTools(host: ToolHost, engine: CompactionEngine, options?: ToolOptions): Array<() => void>;
//# sourceMappingURL=tools.d.ts.map