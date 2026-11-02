/**
 * Cut a model attempt that has collapsed into a repetition loop.
 *
 * Compaction can only stop feeding the loop; the loop itself runs inside one
 * attempt, where the only hook with the raw chunk stream is `llm/stream`. This
 * guard wraps that stream, watches reasoning and text deltas, and ends the
 * attempt with a synthetic `error` finish as soon as a run of identical lines
 * stops looking like prose. The loop turns that finish into `agent/request-error`,
 * which this module answers with one retry; past that it leaves the failure
 * terminal, so a model that insists on repeating cannot burn the whole budget.
 *
 * A retry resends the same request, so the cost is the prompt again. The guard
 * only arms after `minChars` of output and only counts lines that contain a
 * letter or digit, which keeps short answers and closing braces from tripping it.
 *
 * A legitimately repeated block — an aligned table, a Yes/No column — can still
 * look like a loop from one line at a time. Two extra gates separate them: the
 * repeated line must be short, and the recent window must hold almost nothing
 * else. A collapse produces one or two distinct short lines and nothing else;
 * a table produces structure around the run, so `maxUniqueLines` refuses it.
 */
/** Stable failure code shared by the stream cut and its retry decision. */
export declare const REPEAT_FAILURE_CODE = "REPETITION_LOOP";
export interface RepeatGuardOptions {
    enabled: boolean;
    /** Identical consecutive lines that end the attempt. */
    minRepeatedLines: number;
    /** Do not arm until one attempt has produced this many characters. */
    minChars: number;
    /** Retries per agent before the failure stays terminal. */
    maxRetries: number;
    /** A longer repeated line is content (a table row), not a collapse. */
    maxLineChars: number;
    /** Distinct meaningful lines allowed in the recent window when the run trips. */
    maxUniqueLines: number;
}
export declare const DEFAULT_REPEAT_GUARD: RepeatGuardOptions;
/**
 * Incremental detector for one attempt.
 *
 * Only the tail is kept: a loop announces itself with its most recent lines,
 * and retaining the whole attempt would make the guard a second copy of the
 * stream it is meant to cut.
 */
export declare class RepeatDetector {
    private readonly options;
    private partial;
    private run;
    private last;
    private total;
    private readonly recent;
    constructor(options: RepeatGuardOptions);
    /**
     * Feed one delta; true means the attempt has collapsed.
     *
     * Line state is incremental. Re-scanning a retained tail per chunk would cost
     * O(chunks × tail), and the guard runs on the hot path of every model call.
     */
    push(text: string): boolean;
    private consume;
}
/** Whether the tail holds `min` consecutive identical meaningful lines. */
export declare function repeatedTail(text: string, min: number): boolean;
/**
 * Wrap one model stream.
 *
 * The upstream iterator is driven by hand instead of `for await` so that a
 * rejection from its `return()` cannot replace the synthetic finish: once the
 * detector trips, the failure we report is the one we chose, not whatever the
 * adapter throws while closing a live HTTP body.
 */
export declare function guardStream(upstream: AsyncIterable<unknown>, options: RepeatGuardOptions): AsyncGenerator<unknown>;
/** Minimal plugin-context surface this guard needs. */
export interface RepeatGuardHost {
    on(event: string, listener: (...args: never[]) => unknown, options?: {
        global?: boolean;
    }): unknown;
}
/**
 * Install the stream guard and its retry decision.
 *
 * `llm/stream` is a waterfall: returning our own iterable replaces the adapter
 * stream for every caller, including one-shot calls such as a compaction
 * summary, which is why the retry path is keyed on the agent and bounded.
 */
export declare function installRepeatGuard(host: RepeatGuardHost, options: RepeatGuardOptions): void;
//# sourceMappingURL=repeat-guard.d.ts.map