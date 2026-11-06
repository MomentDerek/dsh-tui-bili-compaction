# Local patches to the vendored acp-kernel

`vendor/acp-kernel/dist/` is a vendored build, not rebuilt from source in this
repo. Every local change is listed here so an upstream upgrade can replay or
re-evaluate it instead of silently dropping the fix.

## 2026-11-06 — nudge range fidelity

Files: `dist/chunk-VBWN2X6H.js`, `dist/nudge-text.d.ts`

- `formatRanges` merged adjacent ranges without recomputing `toolPct`, so a run
  of text-only fragments followed by tool-heavy ones rendered as
  `[tool 0% | text 100%]`. The tool share is now weighted by each fragment's
  compressible message count. Live replay of `adbcb536` range `m00012–m00215`
  (59 of 92 messages are tool traffic) changed from `0%` to `64%`.
- `formatRanges` gained an optional `{ hideProtectedOnly }`. The nudge passes
  `true`, so protected-only groups collapse into one
  `(N protected ranges omitted — not compressible)` footnote instead of
  spending a line each. `acp_status`/panel keep the full list for diagnostics.
- Empty `protectedTools` no longer renders a dangling `": "` in the
  `[PROTECTED …]` / `[… compressible | … protected]` labels.

Covered by `tests/format-ranges.test.mjs`.
