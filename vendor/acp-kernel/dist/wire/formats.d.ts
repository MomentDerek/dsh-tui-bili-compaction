export declare const WIRE_FORMATS: readonly ["anthropic", "openai", "responses", "google"];
export type WireFormat = (typeof WIRE_FORMATS)[number];
export declare function isWireFormat(value: unknown): value is WireFormat;
/**
 * Classify a provider request body by the codec that can parse it.
 * Returns undefined when no codec handles the body — the caller must
 * pass such payloads through untransformed.
 */
export declare function detectWireFormat(payload: unknown): WireFormat | undefined;
//# sourceMappingURL=formats.d.ts.map