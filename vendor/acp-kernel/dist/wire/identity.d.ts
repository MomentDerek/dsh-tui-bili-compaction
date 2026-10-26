/**
 * #3642 — protocol-independent message identity.
 *
 * PROBLEM: `deriveMessageId` is shared, but every codec feeds it
 * protocol-specific inputs, so the SAME logical conversation serialized in
 * two protocols produces different id sets:
 *   - tool args: openai/responses seed the host's verbatim `arguments`
 *     string; anthropic seeds `safeStringify(input)`; google seeds
 *     `jsonText(args)` — key order / spacing / double-encoding all diverge;
 *   - the wire toolCallId is part of the seed, and every protocol formats
 *     it differently (`call_x` vs `toolu_x` vs no id at all);
 *   - images: openai seeds "", anthropic/responses "[image]";
 *   - responses seeds empty-text reasoning items on the PROVIDER's item id,
 *     which changes on every replay.
 * Consequence (#3640): switching protocols mid-conversation re-mints a large
 * fraction of ids, the fold anchors miss wholesale, and the drift escalates.
 *
 * FIX: identity derives from a CANONICAL projection of the message — logical
 * content only, no protocol plumbing:
 *   role | contentType | (empty) | toolName | canonicalText
 * The toolCallId slot is kept EMPTY on purpose: the 5-slot seed layout is
 * unchanged (so plain-text ids stay byte-identical to pre-#3642 sessions),
 * but the wire call id no longer participates — it is transport plumbing,
 * not content. Two same-tool same-args calls are made distinct by the
 * ClusterCounter's `_N` suffix (local damage on delete; never global).
 *
 * Byte fidelity is NOT identity: the raw wire block/args/item keeps riding
 * the BiliMessage sidecars so coreToXxx still rebuilds byte-stable output.
 *
 * Granularity axiom (#3642): EVERY content part is its own core — the
 * anthropic codec's existing model. openai/responses/google currently merge
 * multi-part user messages into one text core (image rides a sidecar);
 * they now split per part so the same logical conversation yields the same
 * core ARRAY (ids AND counts) in all four protocols. Reverse codecs
 * re-merge consecutive same-role cores into one wire message.
 */
/** Canonical placeholder for a media part. Matches the anthropic codec's
 *  historical text so image ids on the busiest lane (anthropic) do not
 *  re-mint on upgrade. */
export declare const CANONICAL_IMAGE_TEXT = "[image]";
/** Canonical placeholder for an opaque redacted-thinking payload
 *  (anthropic-only shape; kept for symmetry with the legacy codec text). */
export declare const CANONICAL_REDACTED_THINKING_TEXT = "[redacted_thinking]";
/**
 * Canonical JSON for tool-call arguments: parse → recursively sort object
 * keys → compact re-serialize. The SAME logical arguments then hash equal
 * regardless of the host's key order or spacing. Non-JSON payloads (custom
 * tools send opaque strings) are returned verbatim — there is nothing to
 * normalize without guessing at semantics.
 */
export declare function canonicalToolArgs(argsText: string): string;
/** TEST ONLY (#3756): flips the id seed to simulate a codec/identity upgrade
 * mid-session — every subsequent id changes although content is byte-identical.
 * Production code never sets this. */
export declare function __setMessageIdSaltForTests(salt: string | null): void;
export declare function deriveCanonicalMessageId(role: string, contentType: string, text: string, options?: {
    toolName?: string;
    mediaFingerprint?: string;
}): string;
/** #3751 — media fingerprint for image-bearing cores.
 *
 * Pre-#3751 every image core shared the same canonical text ("[image]"), so
 * all images in a conversation hashed to ONE base id and were told apart
 * only by the ClusterCounter's positional `_N` ordinals — one image changing
 * (offload placeholder, re-encode, delete) shifted the whole family's
 * ordinals and re-minted every sibling id on every turn.
 *
 * The fingerprint makes the id content-addressed per image: data images hash
 * their base64 payload; URL-referenced images (no bytes on the wire) degrade
 * to the URL string; the rare legacy plural-sidecar core (pre-#3642 shape)
 * joins its parts' fingerprints in order. Byte-identical images sharing a
 * base id is INTENDED — `_N` stays as the ordinal for true duplicates only.
 * Non-image ids never gain the sixth slot, so they stay byte-identical. */
export declare function imageMediaFingerprint(base64OrUrl: string): string;
/** Stable seed for opaque wire items (responses reasoning items without
 *  text, computer/file/web/image/code/mcp call items): hash the item with
 *  volatile lifecycle fields stripped — `id` (provider-minted, changes on
 *  every replay) and `status` (in_progress → completed lifecycle state).
 *  Everything else is content and stays. */
export declare function canonicalOpaqueSeed(item: unknown): string;
//# sourceMappingURL=identity.d.ts.map