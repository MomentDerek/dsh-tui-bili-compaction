# dsh-tui-bili-compaction

dsh 专用上下文压缩：**把 billion-context 的内核搬进 dsh 进程**，用 dsh 自己的压缩契约落地，替掉 bili 的代理级压缩。

- 压缩引擎 = [`billion-context`](https://github.com/ranxianglei/billion-context) 的 `acp-kernel`（3-tier LSM：block / tier / ref、`compress` / `decompress` / `acp_status` 工具、nudge 与状态持久化），已 vendor 到 `vendor/acp-kernel/`（MIT，见 `PROVENANCE`）。
- 落地方式 = dsh 官方的 **durable surface replacement**：一条 `user/message` 带 `surfaceOp: {op:'replace', startSeq, endSeq}` 遮蔽被折掉的区间。transcript、token meter、状态栏读的都是这一层折叠，所以不需要再“骗”任何一个消费者。
- 没有代理、没有 `globalThis.fetch` 改写、没有 HTTP manifest：工具直接以 `ctx.tools.register` 注册，状态直接落 JSON。

## 为什么不是“在请求里塞摘要”

dsh 的 `llm/stream` 请求消息是深冻结的（`dsh-agent-loop` 里 `deepFreeze` + `Object.freeze`），文档原话是 “listeners read it, never rewrite it”；`waterfall` 的 `next()` 复用同一份 `args`，listener 也无法替换 `options`。所以请求级改写这条路在 dsh 上不成立。

dsh 唯一允许的改写机制是 session surface 的 `replace`，`@deepseek-ai/dsh-compaction-basic` 用的就是它：

```js
session.append('compaction/summary', { … })
session.append('user/message', checkpointMessage, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: [ …区间内全部 surface seq ],
})
```

本插件照此配方提交，但摘要由模型通过 `compress` 工具给出，状态由内核维护。

## 内核视图：折的是 append-origin 日志

dsh 的 model-visible surface 本身是一次折叠。如果内核也只看 surface，那么插件每次压缩之后内核就再也看不到被折掉的原始消息，block 的锚点消失、区间会被重复压缩。

因此内核视图取的是**整条日志里 `surfaceOp: 'append'` 的原始事件**（`src/session-view.ts`）：

- 只增不减 → block 覆盖的 id 永远在视图里，`syncBlocks` 不会把块判死。
- `ledgerSeq = dshSeq + 1` → ref 恒等于 `m{dshSeq+1}`，一个会话内永久稳定（`assignRefs` 直接采信 `ledgerSeq`）。
- 本插件自己写入的摘要/提示消息带 `source.kind = 'bili-compaction'`，重建视图时排除，不会被二次压缩。

## 组件

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口（`name = 'bili-compaction'`）；`internal/config` 中间件摘掉原生压缩行；注册工具 |
| `src/session-view.ts` | dsh 日志 → `CoreMessage[]`（append-origin、`ledgerSeq`、保护集） |
| `src/engine.ts` | `refresh` / `compress` / `decompress` / `status`：内核状态与 durable replace 的桥 |
| `src/tools.ts` | `compress` / `decompress` / `acp_status` 三个 dsh 工具（schema 直接复用内核常量） |
| `src/store.ts` | 每会话 JSON 状态（`$LOCALAPPDATA\dsh-tui-bili-compaction\sessions`），原子写 |
| `src/config.ts` | 插件选项 → 内核 `Config` |
| `src/dsh-types.ts` | dsh 侧的鸭子类型（profile 插件解析不到 `@deepseek-ai/*`） |

## 选项

行 `config`（`cordis.patch.yml` 或 profile 覆盖）：

```yaml
- id: bili-compaction
  config:
    modelContextLimit: 1000000   # dsh 不把模型上下文窗口交给插件，这里自己声明
    disableNativeCompaction: true # 默认 true：摘掉 dsh-compaction-basic / dsh-command-compact
    storageDir: null             # 默认 LOCALAPPDATA 下的插件状态目录
    languagePreservation: false  # 摘要保留原文语言
    injectNudge: false           # 见下
    kernel: {}                   # 透传给内核 defaultConfig(modelContextLimit, overrides)
```

`kernel` 可覆盖内核的任何配置，例如 `kernel: { compress: { minCompressRange: 2000 } }`、`kernel: { tiers: { enabled: false } }`。

## 工具的行为

`acp_status` 默认打印两段：内核的体检报告（用量、活跃 block、token 分布），以及**当前可压区间**——这一段直接取内核 nudge 用的那份推荐（`NudgeDecision.compressibleRanges`，经 `formatRanges` 渲染），所以每一行里的 ref 都是 `compress` 当场会接受的。

这一点是刻意做的：内核自己的 `scope: 'uncompressed'` 明细按“可见消息”分组，而受保护消息（system / developer prompt、媒体）在 ref 空间里是字面量 `BLOCKED`，分组跨过它们时会打印出 `BLOCKED–m000NN` 这种不可用的区间。本插件默认视图不暴露它；显式传 `scope` 查明细时，这些行也会被替换成一行说明。

`compress` 的参数就是内核的 schema（`content` 放 JSON 字符串或对象数组，一次调用折完所有区间）。被拒时内核会在错误里附带当前的合法区间。

## 为什么默认不注入 nudge

dsh 的 `agent/pre-step` 没有“临时消息”通道：listener 返回的任何消息都会被 `agent-loop` 追加进 durable log。所以内核的 nudge 默认不写进会话，模型通过 `acp_status` 拿到同样的信息（当前用量、可压区间、活跃 block）——一次工具调用，零日志污染。把 `injectNudge` 打开才会在每一步追加一条 `source.kind = 'bili-compaction-nudge'` 的 user 消息。

## 安装

```powershell
dsh plugin --profile dsh-tui add link:D:/Code_Works/Js/dsh-tui-bili-compaction
```

包自带 `cordis.patch.yml`（`dsh.bundle.patch`），loader 会插入 `bili-compaction` 行。装完重启 dsh-tui。

和 `billion-context` 同时装着也能跑，但两者都会压缩：要交给本插件，就把 `billion-context` 从 `dsh.profile.bundles` 里去掉（或至少让它的 `dsh-native` 不接管）。

## 开发

```powershell
$env:NODE_ENV = "development"
npm install --include=dev   # 生产环境会跳过 devDependencies
npm run build               # tsc -p tsconfig.json
npm test                    # node --test tests/*.test.mjs
```

内核在 `vendor/acp-kernel/`，是从 `billion-context` 仓库 `kernel/` 构建并拷入的产物（`dist/` + `.d.ts`）。升级内核：在 billion-context 里 `npm run build --workspace` 后重拷 `kernel/dist`。

## 已知边界

- `modelContextLimit` 靠配置：dsh 的 `GenerateOptions` / `EpochHeader` 里没有上下文窗口字段。
- 压缩区间只能落在 `m00002` 之后（内核保留第一段 user 开场），以及 `preserveRecentMessages` / `preserveRecentTokens` 之外——默认最后 3 条消息、5000 token 不许折，所以“刚贴进来的长文”要等下一轮才进区间。
- 单区间字符数要过内核的 `compress.minCompressRange`（默认 5000 字符），太短会直接被拒；小会话压不动是内核策略，不是插件 bug。
- `commit` 会拒绝任何“遮蔽区间里出现该 block 未覆盖的可见消息”的提交，并把原因回给模型：宁可少折，不做半折叠。
- 和 `billion-context` 同时加载时两边工具同名（`compress` / `decompress` / `acp_status`），只能留一个。

## 验证状态

- `npm test`：7 个用例，覆盖 store 往返/损坏回退、原生压缩行剥离、append-origin 视图与 ref 编号、durable replace 提交、未知 ref 拒绝、以及「`acp_status` 给出的 ref 必须能被 `compress` 当场接受」的回归。
- 真实 dsh 会话（headless profile，`preserveRecentMessages: 0`）：`acp_status` → `compress` 一次成功，dsh 日志落下 `surfaceOp: 'replace'`，token meter 随之下降；插件状态文件里出现 `b1 m00009–m00017 3374 tokens`。
