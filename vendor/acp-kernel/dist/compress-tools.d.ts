/**
 * ACP tool surface: the tool schemas (Anthropic / OpenAI chat / Responses
 * flat), the system-prompt builders for the three protocols (function tools,
 * text triggers, hybrid), and the lenient compress-argument parser.
 *
 * Single source for every downstream that injects the ACP tools into a
 * request (the billion-context proxy on the wire; hosts via their own tool
 * registration). The content is static — no transport, no state, no host
 * types. Moved from billion-context `src/compress-tool.ts` (Phase K1).
 */
import { type Prompts } from "./prompts.js";
import { type CompressPromptSections } from "./surface-config.js";
export declare const COMPRESS_TOOL_NAME = "compress";
export declare const DECOMPRESS_TOOL_NAME = "decompress";
export declare const SEARCH_CONTEXT_TOOL_NAME = "search_context";
export declare const ACP_STATUS_TOOL_NAME = "acp_status";
export declare const ACP_CACHE_TOOL_NAME = "acp_cache";
export declare const ABSORB_TOOL_NAME = "absorb";
/** Text-protocol trigger tags. The model emits these in its text output to
 *  request compression (used when host client tools cannot coexist with a
 *  declared `tools` field — e.g. OpenAI Codex code_mode). Distinct from the
 *  `<acp tokens=...>` history tags so they never collide. */
export declare const ACP_TEXT_OPEN = "<acp_compress>";
export declare const ACP_TEXT_CLOSE = "</acp_compress>";
export declare const ACP_STATUS_OPEN = "<acp_status>";
export declare const ACP_STATUS_CLOSE = "</acp_status>";
export declare const ACP_SEARCH_OPEN = "<acp_search>";
export declare const ACP_SEARCH_CLOSE = "</acp_search>";
export declare const ACP_DECOMPRESS_OPEN = "<acp_decompress>";
export declare const ACP_DECOMPRESS_CLOSE = "</acp_decompress>";
/** Shared parameter schema for every compress wire shape (anthropic
 *  `input_schema`, openai `function.parameters`, responses flat
 *  `parameters`).
 *
 *  ADVERTISED FORM (#4252 decision): exactly one — content = ONE plain
 *  string holding ALL ranges (line form). The parser keeps honoring the
 *  legacy shapes (array content of line strings / range objects, the flat
 *  single-range call, and summary-as-plain-text in content with top-level
 *  refs), but the schema no longer teaches them: advertising several forms
 *  is what led models to blend them into invalid hybrids.
 *
 *  Contract (#374, still holds): the schema must never kill a call the
 *  kernel would honor. It stays an OPEN object schema — no top-level
 *  `required`, no `additionalProperties: false` — so a flat single-range
 *  call {startId, endId, summary} still validates even though those
 *  properties are no longer declared. Do not add strictness here without
 *  re-checking parse-compress-input.ts.
 *
 *  Wire-legality constraint (bili #1299, fixed after the #374 follow-up
 *  regressed it): the TOP LEVEL must stay a plain object schema — no
 *  `oneOf`/`allOf`/`anyOf`/`not`. Anthropic rejects tool input_schema with
 *  top-level combinators (400 on every request carrying the tool), so the
 *  content string-vs-array alternation lives in the `anyOf` under `content`
 *  and is enforced by parseCompressInput, never by a top-level combinator.
 *  Copilot Gemini also needs scalar types and self-contained typed
 *  alternatives; keep each nested object alternative's properties with it.
 */
export declare const COMPRESS_PARAMETERS: {
    type: string;
    properties: {
        topic: {
            type: string;
            description: string;
        };
        content: {
            description: string;
            anyOf: ({
                type: string;
                items: {
                    anyOf: ({
                        type: string;
                        description: string;
                    } | {
                        required: string[];
                        type: string;
                        properties: {
                            topic: {
                                type: string;
                            };
                            startId: {
                                type: string;
                                description: string;
                            };
                            endId: {
                                type: string;
                                description: string;
                            };
                            startRef: {
                                type: string;
                                description: string;
                            };
                            endRef: {
                                type: string;
                                description: string;
                            };
                            summary: {
                                type: string;
                                description: string;
                            };
                        };
                        description?: undefined;
                    })[];
                };
            } | {
                type: string;
                items?: undefined;
            })[];
        };
    };
};
export declare const COMPRESS_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            topic: {
                type: string;
                description: string;
            };
            content: {
                description: string;
                anyOf: ({
                    type: string;
                    items: {
                        anyOf: ({
                            type: string;
                            description: string;
                        } | {
                            required: string[];
                            type: string;
                            properties: {
                                topic: {
                                    type: string;
                                };
                                startId: {
                                    type: string;
                                    description: string;
                                };
                                endId: {
                                    type: string;
                                    description: string;
                                };
                                startRef: {
                                    type: string;
                                    description: string;
                                };
                                endRef: {
                                    type: string;
                                    description: string;
                                };
                                summary: {
                                    type: string;
                                    description: string;
                                };
                            };
                            description?: undefined;
                        })[];
                    };
                } | {
                    type: string;
                    items?: undefined;
                })[];
            };
        };
    };
};
export type ParsedRange = {
    startRef: string;
    endRef: string;
    summary: string;
    topic?: string;
    compressCallId?: string;
};
/** Lenient parse of a compress tool-call argument object into ranges.
 *  Accepts `content` as an array or a JSON-encoded string (non-strict-tool
 *  providers stringify array args, e.g. vLLM openai-completions), a single
 *  range object at the top level, and both startId/startRef spellings.
 *  `onWarn` receives diagnostics for rejected shapes — the kernel stays
 *  side-effect free, downstream wires its logger. */
export declare function parseCompressInput(input: unknown, callId?: string, onWarn?: (message: string) => void): ParsedRange[];
export declare const COMPRESS_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                topic: {
                    type: string;
                    description: string;
                };
                content: {
                    description: string;
                    anyOf: ({
                        type: string;
                        items: {
                            anyOf: ({
                                type: string;
                                description: string;
                            } | {
                                required: string[];
                                type: string;
                                properties: {
                                    topic: {
                                        type: string;
                                    };
                                    startId: {
                                        type: string;
                                        description: string;
                                    };
                                    endId: {
                                        type: string;
                                        description: string;
                                    };
                                    startRef: {
                                        type: string;
                                        description: string;
                                    };
                                    endRef: {
                                        type: string;
                                        description: string;
                                    };
                                    summary: {
                                        type: string;
                                        description: string;
                                    };
                                };
                                description?: undefined;
                            })[];
                        };
                    } | {
                        type: string;
                        items?: undefined;
                    })[];
                };
            };
        };
    };
};
export declare function buildCompressSystemPrompt(prompts?: Prompts, sections?: CompressPromptSections): string;
export declare function buildCompressTextSystemPrompt(prompts?: Prompts, sections?: CompressPromptSections): string;
export declare function buildCompressHybridSystemPrompt(prompts?: Prompts, sections?: CompressPromptSections): string;
export declare const DECOMPRESS_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                blockId: {
                    type: string;
                    description: string;
                };
                toFile: {
                    type: string;
                    description: string;
                };
                full: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
export declare const SEARCH_CONTEXT_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                query: {
                    type: string;
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
export declare const ACP_STATUS_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {};
        };
    };
};
export declare const ACP_CACHE_TOOL_DESCRIPTION = "Prompt-cache reconciliation: grand ledger (total input/cached/output, overall hit rate) with every request's miss split into new content / compression re-pay / upstream-ttl-or-client-rewrite (unattributed stable-prefix misses), plus per-fold economics (breakeven turns vs measured cadence). Defaults to a compact summary (totals + verdicts + anomalies only); pass detail=\"full\" for every fold and line item. Read-only. Call when asked about cache hits, cache invalidation, or what compression costs.";
export declare const ACP_CACHE_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                detail: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
        };
    };
};
export declare const ACP_TOOLS_OPENAI: readonly [{
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                topic: {
                    type: string;
                    description: string;
                };
                content: {
                    description: string;
                    anyOf: ({
                        type: string;
                        items: {
                            anyOf: ({
                                type: string;
                                description: string;
                            } | {
                                required: string[];
                                type: string;
                                properties: {
                                    topic: {
                                        type: string;
                                    };
                                    startId: {
                                        type: string;
                                        description: string;
                                    };
                                    endId: {
                                        type: string;
                                        description: string;
                                    };
                                    startRef: {
                                        type: string;
                                        description: string;
                                    };
                                    endRef: {
                                        type: string;
                                        description: string;
                                    };
                                    summary: {
                                        type: string;
                                        description: string;
                                    };
                                };
                                description?: undefined;
                            })[];
                        };
                    } | {
                        type: string;
                        items?: undefined;
                    })[];
                };
            };
        };
    };
}, {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                blockId: {
                    type: string;
                    description: string;
                };
                toFile: {
                    type: string;
                    description: string;
                };
                full: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
}, {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                query: {
                    type: string;
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
}, {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {};
        };
    };
}, {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                detail: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
        };
    };
}];
/** Anthropic-format tools (name + description + input_schema). The Anthropic
 *  request path (ZCode, Claude Code) injects all four so the model can
 *  actually call compress/decompress/search_context/acp_status — the system
 *  prompt describes all four, so declaring only COMPRESS_TOOL left the model
 *  able to see the docs but unable to call the rest. */
export declare const DECOMPRESS_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const SEARCH_CONTEXT_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const ACP_STATUS_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {};
    };
};
export declare const ACP_CACHE_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
};
export declare const ACP_TOOLS_ANTHROPIC: readonly [{
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            topic: {
                type: string;
                description: string;
            };
            content: {
                description: string;
                anyOf: ({
                    type: string;
                    items: {
                        anyOf: ({
                            type: string;
                            description: string;
                        } | {
                            required: string[];
                            type: string;
                            properties: {
                                topic: {
                                    type: string;
                                };
                                startId: {
                                    type: string;
                                    description: string;
                                };
                                endId: {
                                    type: string;
                                    description: string;
                                };
                                startRef: {
                                    type: string;
                                    description: string;
                                };
                                endRef: {
                                    type: string;
                                    description: string;
                                };
                                summary: {
                                    type: string;
                                    description: string;
                                };
                            };
                            description?: undefined;
                        })[];
                    };
                } | {
                    type: string;
                    items?: undefined;
                })[];
            };
        };
    };
}, {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {};
    };
}, {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
}];
export declare const COMPRESS_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            topic: {
                type: string;
                description: string;
            };
            content: {
                description: string;
                anyOf: ({
                    type: string;
                    items: {
                        anyOf: ({
                            type: string;
                            description: string;
                        } | {
                            required: string[];
                            type: string;
                            properties: {
                                topic: {
                                    type: string;
                                };
                                startId: {
                                    type: string;
                                    description: string;
                                };
                                endId: {
                                    type: string;
                                    description: string;
                                };
                                startRef: {
                                    type: string;
                                    description: string;
                                };
                                endRef: {
                                    type: string;
                                    description: string;
                                };
                                summary: {
                                    type: string;
                                    description: string;
                                };
                            };
                            description?: undefined;
                        })[];
                    };
                } | {
                    type: string;
                    items?: undefined;
                })[];
            };
        };
    };
};
export declare const DECOMPRESS_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const SEARCH_CONTEXT_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const ACP_STATUS_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {};
    };
};
export declare const ACP_CACHE_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
};
/** All ACP tools in Responses API flat format, matching ACP_TOOL_NAMES. */
export declare const ACP_TOOLS_RESPONSES: readonly [{
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            topic: {
                type: string;
                description: string;
            };
            content: {
                description: string;
                anyOf: ({
                    type: string;
                    items: {
                        anyOf: ({
                            type: string;
                            description: string;
                        } | {
                            required: string[];
                            type: string;
                            properties: {
                                topic: {
                                    type: string;
                                };
                                startId: {
                                    type: string;
                                    description: string;
                                };
                                endId: {
                                    type: string;
                                    description: string;
                                };
                                startRef: {
                                    type: string;
                                    description: string;
                                };
                                endRef: {
                                    type: string;
                                    description: string;
                                };
                                summary: {
                                    type: string;
                                    description: string;
                                };
                            };
                            description?: undefined;
                        })[];
                    };
                } | {
                    type: string;
                    items?: undefined;
                })[];
            };
        };
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {};
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
}];
/** Read-only ACP tools (no compress) in Responses flat format. Used for the
 *  hybrid protocol (codex): compress stays a text marker (batch + STOP), while
 *  decompress/search_context/acp_status are injected as real function tools so
 *  the model can call them directly instead of emitting text triggers.
 *  Empirically (direct comfly A/B) declaring these tools does NOT disable
 *  codex code_mode — the earlier "tools can't coexist" assumption was wrong. */
export declare const ACP_READONLY_TOOLS_RESPONSES: readonly [{
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {};
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
}];
/** All ACP tool names (dynamic membership — Set, not a static record). Does
 *  NOT include absorb or acp_retrieve: both are opt-in (config.absorb.enabled
 *  / config.ccr.enabled) and hosts only register/inject them when on. */
export declare const ACP_TOOL_NAMES: ReadonlySet<string>;
/** compress/decompress: mutate history → must drive the compress loop (their
 *  result is folded into the request before the model continues). */
export declare const ACP_MUTATING_TOOLS: ReadonlySet<string>;
/** acp_status/search_context/acp_cache: read-only → must NOT loop. Looping them
 *  made the model re-call until the 5× limit and discarded the whole turn. */
export declare const ACP_READONLY_TOOLS: ReadonlySet<string>;
/** Opt-in absorb tool (instant tool-result absorption). Inject/register only
 *  when config.absorb.enabled — NOT part of ACP_TOOLS_* arrays. */
export declare const ABSORB_TOOL_DESCRIPTION = "Distill a tool result into a compact summary you write. REQUIRED immediately after a tool result ends with an [ACP absorb] instruction: pass its ref and the distilled essentials (outcome, key values, paths:lines, errors, decisions). The original output is then removed from context; your summary is the durable record.";
export declare const ABSORB_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            ref: {
                type: string;
                description: string;
            };
            summary: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const ABSORB_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: {
                ref: {
                    type: string;
                    description: string;
                };
                summary: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
export declare const COMPRESS_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            topic: {
                type: string;
                description: string;
            };
            content: {
                type: string;
                description: string;
                items: {
                    type: string;
                    properties: {
                        topic: {
                            type: string;
                        };
                        startId: {
                            type: string;
                            description: string;
                        };
                        endId: {
                            type: string;
                            description: string;
                        };
                        summary: {
                            type: string;
                            description: string;
                        };
                    };
                    required: string[];
                };
            };
        };
        required: string[];
    };
};
export declare const DECOMPRESS_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const SEARCH_CONTEXT_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const ACP_STATUS_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {};
    };
};
/** All ACP tools in Gemini flat format, matching ACP_TOOL_NAMES. */
export declare const ACP_TOOLS_GOOGLE: readonly [{
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            topic: {
                type: string;
                description: string;
            };
            content: {
                type: string;
                description: string;
                items: {
                    type: string;
                    properties: {
                        topic: {
                            type: string;
                        };
                        startId: {
                            type: string;
                            description: string;
                        };
                        endId: {
                            type: string;
                            description: string;
                        };
                        summary: {
                            type: string;
                            description: string;
                        };
                    };
                    required: string[];
                };
            };
        };
        required: string[];
    };
}, {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {};
    };
}];
/** Opt-in absorb tool in Gemini flat format (config.absorb.enabled). */
export declare const ABSORB_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: {
            ref: {
                type: string;
                description: string;
            };
            summary: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
/** Opt-in retrieve tool (lossless content-cached retrieval). Inject/register
 *  only when config.ccr.enabled — NOT part of ACP_TOOLS_* arrays (same
 *  opt-in pattern as absorb). */
export declare const RETRIEVE_TOOL_NAME = "acp_retrieve";
export declare const RETRIEVE_TOOL_DESCRIPTION = "Retrieve the full original text of a stored tool result. REQUIRED when you need details from a placeholder that starts with \uD83D\uDCE6 [acp-stored #mNNNNN: pass its ref. Returns the exact original text; the placeholder stays in context. Unknown refs return not-found.";
export declare const RETRIEVE_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            ref: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const RETRIEVE_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: {
                ref: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
export declare const RETRIEVE_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: {
            ref: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
//# sourceMappingURL=compress-tools.d.ts.map