/** SHA-256-derived short id — kept verbatim from the proxy so message ids
 *  stay byte-identical across the extraction (re-keying would orphan every
 *  downstream map keyed on these ids). */
export declare function hashId(s: string): string;
/** How a conversation's identity was derived (kept verbatim from the proxy's
 *  session-id.ts — only the TYPE moves; session-key derivation stays in the
 *  proxy, which owns multi-tenant state). */
export type ConversationIdentity = {
    value: string;
    source: "header" | "body-session" | "metadata-session" | "previous-response" | "content-fingerprint" | "generated";
    clientProvided: boolean;
};
//# sourceMappingURL=util.d.ts.map