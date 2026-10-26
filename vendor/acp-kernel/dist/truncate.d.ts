/** At most maxUnits code units; never ends on a stranded high surrogate. */
export declare function clampPrefix(text: string, maxUnits: number): string;
/** A [start, end) window with both edges snapped off surrogate pairs. */
export declare function clampWindow(text: string, start: number, end: number): string;
/** Belt-and-braces: replace any unpaired surrogate half (whatever its source —
 *  model-authored compress summaries, hand-built strings, upstream payload)
 *  with U+FFFD so it can never reach JSON.stringify as an unpaired escape.
 *  Valid pairs pass through verbatim; non-surrogate text is untouched. */
export declare function scrubLoneSurrogates(text: string): string;
//# sourceMappingURL=truncate.d.ts.map