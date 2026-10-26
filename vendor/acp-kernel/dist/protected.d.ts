import type { Config, CoreMessage } from "./types.js";
/** Tools that are ALWAYS protected, regardless of user config. These are ACP's
 *  own metadata tools whose records must remain in context: compress calls
 *  carry the summaries that decompress/search rely on, and the system prompt
 *  treats past compress calls as load-bearing metadata. acp_rule calls record
 *  persistent user rules that are re-injected every turn — compressing them
 *  away would silently lose what the rules state. Letting any of these be
 *  compressed away breaks decompress and the "summary is historical" contract.
 *
 *  #4289 exception: a compress exchange that applied ZERO ranges is refuse,
 *  not metadata — no block carries its arguments and decompress never
 *  consults it. Hosts render such results with a failed-compress receipt
 *  prefix; see isFailedCompressResult. Those exchanges fold like ordinary
 *  messages so a failing compress loop cannot permanently bloat context. */
export declare const ALWAYS_PROTECTED_TOOLS: readonly ["compress", "acp_rule"];
/** #4289: hosts render a compress tool-result that applied zero ranges with
 *  one of these prefixes. "[Compression FAILED: …]" covers the refused /
 *  errored / zero-block paths in src/stream.ts, src/external-summary-compress.ts
 *  and the ACP tool lane; "[Compression refused: …]" covers the two refuse
 *  gates whose draft parses fine but commits nothing (coverage regression, no
 *  net shrink — src/stream.ts gate:coverage-regression / gate:no-net-shrink).
 *  #4307: both classes leave zero blocks committed, so both are dead weight,
 *  not metadata. Successful and partial receipts start with "[Compressed" and
 *  stay protected — a partial fold's arguments still cover the ranges that
 *  DID apply. */
export declare const FAILED_COMPRESS_RESULT_PREFIXES: readonly ["[Compression FAILED", "[Compression refused"];
/** True when toolName denotes a compress call in ANY hosted dialect (#4289):
 *  the canonical bare "compress" plus whatever the host's isCompressTool
 *  recognizer claims (MCP lanes expose mcp__bili__compress — #2578/#2970).
 *  Union semantics, never narrower than bare: a host without the hook
 *  behaves exactly as before. */
export declare function isCompressToolName(toolName: string | undefined, config?: Pick<Config, "isCompressTool">): boolean;
/** True for the tool-result half of a compress exchange that applied zero
 *  ranges (#4289). Such an exchange is not load-bearing metadata: no block
 *  carries its arguments, its summary draft is dead weight, and keeping it
 *  permanently un-foldable turns a failing compress loop into permanent
 *  context bloat (live incidents: 70 failed calls = 116KB of residue, #4289;
 *  47 refused calls = ~117KB, #4307). Dialect-aware via config.isCompressTool
 *  when given. */
export declare function isFailedCompressResult(msg: CoreMessage, config?: Pick<Config, "isCompressTool">): boolean;
/** toolCallIds of failed compress exchanges (#4289). The tool-CALL half has
 *  no outcome of its own — pass this set as isMessageProtected's optional
 *  third argument so both halves drop their protection together. Computed
 *  from the full message list, which every fold-side consumer already holds. */
export declare function collectFailedCompressCallIds(messages: readonly CoreMessage[], config?: Pick<Config, "isCompressTool">): Set<string>;
/** #4348: compress exchanges stay exempt from folding only while they are
 *  recent working memory. This many NEWEST compress exchanges keep the
 *  hard-coded ALWAYS_PROTECTED_TOOLS exemption; older ones become foldable
 *  like ordinary tool exchanges. Their receipts are machine exhaust
 *  ("[Compressed mX-mY -> N block(s), ~K tokens saved]") and the summaries
 *  the model wrote live on verbatim in the block anchors the pruned view
 *  renders, so folding an aged exchange loses nothing decompress or search
 *  relies on. The newest folds stay visible so the model can still see what
 *  it just did (which refs are spent, which blocks exist). */
export declare const COMPRESS_EXCHANGE_KEEP_RECENT = 3;
/** Tool-call ids of compress exchanges OLD enough to fold (#4348): every
 *  compress exchange except the newest COMPRESS_EXCHANGE_KEEP_RECENT ones.
 *  `keepRecent` exists for tests. Dialect-aware via the same union recognizer
 *  as the failed-exchange helpers (bare "compress" always counts, plus whatever
 *  config.isCompressTool claims — #2970 MCP "mcp__bili__compress"). O(n); ids
 *  are toolCallIds shared by both halves. */
export declare function collectAgedCompressCallIds(messages: CoreMessage[], config: Pick<Config, "isCompressTool">, keepRecent?: number): Set<string>;
/** Tool results that must NEVER participate in the soft-protected recent zone
 *  (preserveRecentMessages / preserveRecentTokens / last user message).
 *
 *  These tools return large content (restored blocks, search hits, file bodies,
 *  command output). If such a result lands in the last-N window it becomes
 *  un-compressible: the model cannot reclaim that context, and it never appears
 *  in the compressible-ranges recommendation list. Excluding these tools from
 *  the protected zone lets the model compress them again immediately, while
 *  still leaving them visible (the host's preserveRecent is about not
 *  compressing the active working set, not about which tool results are in
 *  scope).
 *
 *  - `decompress`: large restored content as an inline tool result.
 *  - `search_context`: large result lists (10 ranked hits with previews).
 *  - `read`: file/image contents — the largest common source of context bloat.
 *  - `bash`: command output (build/test/logs) — frequently large and spent.
 *
 *  Note: this only affects the recent-zone computation. Such messages remain
 *  fully visible and compressible like any ordinary message. */
export declare const NEVER_PRESERVE_RECENT_TOOLS: readonly ["decompress", "search_context", "read", "bash"];
/** True for tool-call / tool-result messages whose toolName matches one of
 *  the recent-zone exclusion patterns — i.e. tool results (like decompress)
 *  that should be excluded from the soft-protected recent zone.
 *
 *  `patterns` defaults to NEVER_PRESERVE_RECENT_TOOLS when omitted/undefined
 *  (the built-in list stays the default behavior); an explicit array —
 *  including `[]` — replaces it verbatim. Patterns use the same glob-suffix
 *  matching as protectedTools; exact names behave exactly as before.
 *
 *  `preservePatterns` (config.preserveRecentTools) is then SUBTRACTED from
 *  that effective list (glob-suffix matching against the list entries), so
 *  `preserveRecentTools: ["read"]` protects fresh read results without
 *  restating the built-in list (upstream billion-context #1198/#1277).
 *  Unset or empty = no subtraction. */
export declare function isNeverPreserveRecent(msg: CoreMessage, patterns?: readonly string[], preservePatterns?: readonly string[]): boolean;
/** Match a tool name against a pattern: an exact name or a trailing-`*` prefix
 *  glob. CASE-INSENSITIVE on both sides — client hosts disagree on tool-name
 *  casing (opencode `read` vs Claude/ZCode `Read`), so every knob built on this
 *  matcher must treat them as equal (billion-context#1725). Monotonic: only adds
 *  matches, never removes one that held under exact matching. */
export declare function matchToolPattern(toolName: string, pattern: string): boolean;
/** Canonical path of a tool exchange: skill loads project to `skill/<name>`,
 *  everything else is the bare tool name. Skill identity lives in the call
 *  input, not the tool name — opencode calls `skill({name})`, Claude
 *  Code/ZCode call `Skill({skill})`, and pi has no skill tool at all: any
 *  tool reading `<dir>/<name>/SKILL.md` loads one (#1947). Projection runs on
 *  tool-CALL input only; a tool-result projects to its bare tool name (the
 *  result half of a protected call is covered by toolCallId pairing). */
export declare function toolPathOf(msg: CoreMessage): string;
/** Match a canonical tool path against a protectedTools/protectedLatestTools
 *  pattern. Segments split on `/`; within a segment an exact name or a
 *  trailing-`*` prefix glob (case-insensitive like matchToolPattern — `*`
 *  never crosses `/`). A single-segment pattern matches the first path
 *  segment, i.e. the node and ALL its descendants: `skill` ≡ `skill/*`
 *  (#1947). */
export declare function matchToolPath(path: string, pattern: string): boolean;
/** True when a protectedTools/protectedLatestTools pattern matches a tool
 *  exchange: by canonical path, or — monotonic fallback — by bare tool name,
 *  so every match that held before path syntax still holds (a `read` of
 *  SKILL.md keeps matching a plain `read` pattern; #1947). */
export declare function matchToolMessagePattern(msg: CoreMessage, pattern: string): boolean;
/** Host-projected virtual tool path for a non-tool message (billion-context
 *  #2446 family): plain-text durable-state carriers classified by the host
 *  run through the same pattern machinery as tool exchanges. Tool-call /
 *  tool-result messages are never re-projected — the classifier's domain is
 *  exactly the messages that carry no toolName, so a tool exchange keeps its
 *  existing semantics byte-for-byte. */
export declare function virtualToolPathOf(msg: CoreMessage, config: Pick<Config, "messagePathOf">): string | undefined;
export declare function isMessageProtected(msg: CoreMessage, config: Pick<Config, "protectedTools" | "isToolProtected" | "isMessageProtected" | "messagePathOf" | "isCompressTool">, failedToolCallIds?: ReadonlySet<string>): boolean;
/** Build the set of toolCallIds whose tool-call is protected. Use this to also
 *  protect tool-results that lack a toolName (common when the host projects a
 *  tool-result with only toolCallId). Without it, the result half of a
 *  protected tool exchange leaks into compressible ranges.
 *
 *  #4289: failed compress calls are excluded (via the failed set passed into
 *  isMessageProtected), so their results are not re-protected here through
 *  pairing. Dialect-aware through config.isCompressTool. */
export declare function collectProtectedToolCallIds(messages: CoreMessage[], config: Pick<Config, "protectedTools" | "isToolProtected" | "isCompressTool">): Set<string>;
/** Like isMessageProtected, but also matches tool-results by toolCallId against
 *  the protected call set. Use when you have the full message list available.
 *  Pass the failed-compress set (#4289) as the fourth argument — without it
 *  the call half of a failed exchange stays protected on this path. */
export declare function isMessageProtectedWithPairing(msg: CoreMessage, config: Pick<Config, "protectedTools" | "isToolProtected" | "isCompressTool">, protectedCallIds: Set<string>, failedToolCallIds?: ReadonlySet<string>): boolean;
/** "Latest only" protection set: for each protectedLatestTools pattern, the
 *  LAST tool-call matching it (in message order) plus its paired result. Older
 *  instances of the same tool stay compressible. Use for cumulative-snapshot
 *  tools (e.g. todo_list) where only the newest result is the source of truth
 *  and every older result is strictly redundant.
 *
 *  `callIds` holds the latest calls' toolCallIds (pairing covers the result
 *  half, including results projected without a toolName); `msgIds` holds
 *  latest calls that lack a toolCallId (pairing impossible — protect by id). */
export interface LatestProtected {
    callIds: Set<string>;
    msgIds: Set<string>;
}
export declare function collectLatestProtected(messages: CoreMessage[], config: Pick<Config, "protectedLatestTools" | "messagePathOf">): LatestProtected;
/** True when msg is a latest-protected tool-call, or the tool-result paired to
 *  one (by toolCallId). msgIds entries may also be latest TEXT carriers
 *  (host-projected virtual tool paths carry no toolCallId), so the id
 *  membership check runs for every content type. */
export declare function isMessageLatestProtected(msg: CoreMessage, latest: LatestProtected): boolean;
export declare function hasMediaPayload(msg: CoreMessage): boolean;
/** True when msg carries media whose bytes bili CANNOT store locally —
 *  remote-URL images and opaque file references (DeepSeek Files API
 *  `{type:"file"}`, Google `fileData`/`videoMetadata`) — so folding it would
 *  destroy the payload permanently with no decompress({ imageRef }) restore
 *  behind it (billion-context#1188; the missing Google detection was #2609).
 *  Archivable media (inline base64 / data: URLs, which the host spills to disk
 *  at arrival time) is deliberately NOT unrecoverable: since #2607 such
 *  messages fold like ordinary text and stay citable by their mNNNNN ref.
 *  The data-URL test mirrors the host archive channel (image-restore.ts
 *  messageImageBytes) exactly, so "recoverable here" ⇔ "bytes actually
 *  spilled there". */
export declare function hasUnrecoverableMediaPayload(msg: CoreMessage): boolean;
/** A mid-conversation anthropic `role:"system"` message whose whole payload
 *  is text (blocks may carry cache_control) — nothing a fold would lose. */
export declare function isPlainTextSystemMessage(raw: unknown): boolean;
//# sourceMappingURL=protected.d.ts.map