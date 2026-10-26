# Third-party notices / 第三方声明

This project incorporates the following third-party software.

## acp-kernel / billion-context

- Files: `vendor/acp-kernel/`
- Upstream: <https://github.com/ranxianglei/billion-context>
- Kernel repository: <https://github.com/ranxianglei/acp-kernel>
- Copyright: Copyright (c) 2026 ranxianglei
- License: MIT License, plus the Additional Term — Attribution on Product Surfaces.

The full license text is included at [`vendor/acp-kernel/LICENSE`](vendor/acp-kernel/LICENSE).

### Required attribution

This project uses **acp-kernel** and **billion-context** as its context-compression
engine. The upstream projects are maintained by ranxianglei:

- <https://github.com/ranxianglei/acp-kernel>
- <https://github.com/ranxianglei/billion-context>

The same attribution is shown in the project README. The vendored kernel
`dist/` is byte-identical to the upstream `billion-context/kernel/dist` at
vendoring time; no kernel source was relicensed by this project.

## Node.js type definitions and TypeScript

Development dependencies only; they are not bundled or vendored:

- `@types/node` — MIT
- `typescript` — Apache-2.0
