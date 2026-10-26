import type { CompressionState, CompressionTier, Config, CoreMessage } from "./types.js";
/**
 * #3236: the ONE definition of "can this range fold" — the exact sequence
 * applySingleRange runs before it creates a block: boundary resolution →
 * checkpoint-carrier exclusion (#335/#2663) → pair-boundary widening
 * (tool/reasoning pairs) → nested-block rescan → protected-tool/media/zone
 * carves → turn-integrity withdrawal (#684) → empty check.
 *
 * Before this module existed the recommendation side re-implemented parts of
 * that judgment with a DIFFERENT input scope: global integrity screening over
 * ALL compressible messages at once (so a turn whose partners sit in another
 * advertised unit passed screening), while apply judges each SUBMITTED range
 * alone and throws when its carves split a turn or empty the fold. Production
 * result: acp_status / nudge advertised ranges that every submission rejected
 * with "Range would split N turn(s)" — a permanent advertise/reject loop.
 *
 * Now both sides run this one function on the same array class (the exact
 * array applyCompression executes on — see ProcessTurnInput.applyView). Apply
 * consumes the full projection and throws the carried Error verbatim; the
 * recommendation side uses it as a screen and demotes doomed units to gaps;
 * the acp_status uncompressed view flags rows whose projection is fatal.
 * Swapping any single carve criterion (dead ref, live carrier, media,
 * protected tools, zone, turn integrity) therefore changes advertise and
 * execute together — the #2663 acceptance criterion.
 */
export interface UnitProjectionInput {
    /** The EXACT message array class applyCompression will run on for this
     * lane (the unpruned log when the render view differs from it). */
    messages: CoreMessage[];
    state: CompressionState;
    config: Config;
    startRef: string;
    endRef: string;
    /** Raw ids already covered by active blocks BEFORE this unit folds
     * (apply computes one such set per call; recommend passes the current one). */
    preExistingCoverage: Set<string>;
    /** REF ids (mNNNNN) of the soft-protection zone, computed on `messages` —
     * apply derives them from its own input array via computeProtectedRefs. */
    protectedMessageIds?: Set<string>;
    /** Warnings are pushed here in apply's original emission order so the
     * apply-side refactor stays byte-identical. Omit for read-only screens. */
    warnings?: string[];
}
export interface UnitProjectionFatal {
    kind: "zone" | "split";
    error: Error;
}
export interface UnitProjection {
    /** Non-null when applySingleRange would THROW for this unit (and which
     * error, fully constructed). Null = the unit folds, possibly with warnings. */
    fatal: UnitProjectionFatal | null;
    rangeMessageIds: string[];
    skippedCarrierIds: string[];
    nestedBlockIds: string[];
    consumedBlockIds: string[];
    effectiveMessageIds: Set<string>;
    directMessageIds: string[];
    filteredIds: string[];
    withdrawnIds: Set<string>;
    splitTurnCount: number;
    splitPairCount: number;
    targetTier: CompressionTier;
    outputTier: CompressionTier;
    isBlockBoundary: boolean;
}
/** Read-only projection of one candidate range through the full apply
 * sequence. Never mutates `state`; never creates blocks. Throws
 * BoundaryNotFoundError when an endpoint ref cannot be resolved. */
export declare function projectUnit(input: UnitProjectionInput): UnitProjection;
/** Union of the raw ids covered by all active blocks — the set apply treats
 * as "already folded" before a new spec runs (one per applyCompression call). */
export declare function collectCoverage(state: CompressionState): Set<string>;
//# sourceMappingURL=unit-projection.d.ts.map