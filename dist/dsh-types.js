/**
 * The subset of the dsh request message shapes this plugin touches.
 *
 * `dsh` hands plugins its own message types through the `llm/stream`
 * waterfall. Those types live in `@deepseek-ai/dsh-llm`, which a profile
 * plugin cannot import (the profile's module realm does not resolve harness
 * packages), so the plugin works against this structural mirror instead. Every
 * member is optional or widened so a real dsh message stays assignable.
 */
export {};
//# sourceMappingURL=dsh-types.js.map