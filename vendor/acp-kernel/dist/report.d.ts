import type { CompressionState, Config, CoreMessage } from "./types.js";
/** Host-declared surface facts for status reports. The kernel never resolves
 *  packs — which pack is active is host policy (billion-context #730); the
 *  kernel only renders what the host declares about the active surface. */
export interface StatusReportMeta {
    pack?: string;
    packVersion?: string;
    host?: string;
}
export interface StatusReportOptions {
    scope?: "compressed" | "uncompressed";
    view?: "ranges" | "messages";
    tool?: string;
    sort?: "size" | "time" | "tool" | "age";
    limit?: number;
    meta?: StatusReportMeta;
    /** #3236: when both this and `originalMessages` are given, the
     * uncompressed range rows are screened through the SAME projection
     * applySingleRange executes and doomed rows get a ⚠ flag (diagnostic view —
     * rows are flagged, never dropped). Omit both for legacy output. */
    config?: Config;
    /** #3236: the exact array class applyCompression runs on (see
     * ProcessTurnInput.applyView). Screening is skipped without it — projecting
     * on the render view would judge a different array class than execute. */
    originalMessages?: CoreMessage[];
}
export declare function buildStatusReport(state: CompressionState, messages: CoreMessage[], countTokens: (t: string) => number, options?: StatusReportOptions): string;
export declare function buildRecap(state: CompressionState, blockId?: string): string;
//# sourceMappingURL=report.d.ts.map