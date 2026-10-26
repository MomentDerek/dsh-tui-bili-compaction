# dsh-tui-bili-compaction

[![CI](https://github.com/MomentDerek/dsh-tui-bili-compaction/actions/workflows/ci.yml/badge.svg)](https://github.com/MomentDerek/dsh-tui-bili-compaction/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

dsh 专用上下文压缩：**把 billion-context 的内核搬进 dsh 进程**，用 dsh 自己的压缩契约落地，替掉 bili 的代理级压缩。

- 压缩引擎 = [`billion-context`](https://github.com/ranxianglei/billion-context) 的 [`acp-kernel`](https://github.com/ranxianglei/acp-kernel)（3-tier LSM：block / tier / ref、`compress` / `decompress` / `acp_status` 工具、nudge 与状态持久化），已 vendor 到 `vendor/acp-kernel/`（MIT + 附加署名条款，见 `THIRD_PARTY_NOTICES.md`）。
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
- `ledgerSeq = dshSeq + 1` → 一个事件的第一条消息 ref 等于 `m{dshSeq+1}`，一个会话内永久稳定（`assignRefs` 直接采信 `ledgerSeq`）。一条 dsh 事件可能带多个 content block（reasoning + text + tool-call），兄弟 block 会占用后续空闲 ref；`compress` 必须覆盖整条事件的所有 block，否则会被拒绝，避免只摘要了 text 却把 reasoning 一起遮掉。
- 本插件自己写入的摘要/提示消息带 `source.kind = 'bili-compaction'`，重建视图时排除，不会被二次压缩。

## 组件

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口（`name = 'bili-compaction'`）；原生压缩守卫（patch preset 内 `compaction` 服务）；注册工具 |
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
    modelContextLimit: 1000000   # 可选：显式钉死窗口；省略时优先用 dsh 会话通告的窗口，最终回退 1M
    disableNativeCompaction: true # 默认 true：拦掉预设内 compaction 的“主动压力压缩”与手写 /compact，保留溢出恢复
    storageDir: null             # 默认 LOCALAPPDATA 下的插件状态目录
    languagePreservation: false  # 摘要保留原文语言
    injectNudge: false           # 见下
    autoFold:                    # 模型无关的自动折叠，默认关闭
      enabled: false
      triggerPct: 0.2            # 越过窗口的 20% 就开始折
      targetPct: 0.1             # 折回到 10%（受 preserveRecentMessages/Tokens 保护尾约束）
    kernel: {}                   # 透传给内核 defaultConfig(modelContextLimit, overrides)
```

`kernel` 可覆盖内核的任何配置，例如 `kernel: { compress: { minCompressRange: 2000 } }`、`kernel: { tiers: { enabled: false } }`。

## autoFold：不等模型的自动折叠

内核只“建议”折叠，真正的 `compress` 摘要由模型写。模型不配合时（或者你根本不想让它花一次工具调用），打开 `autoFold`：pre-step 里一旦测得 surface 超过 `triggerPct`，插件自己挑**最老的可见消息**，用确定性摘要（用户消息原文、助手文本与工具调用名）写一条 `surfaceOp: 'replace'` checkpoint，一次只折一段，折到 `targetPct` 以下或不足 20% 收益为止。

- 摘要里**没有模型参与**，所以细节会丢：适合“先把窗口压下去继续干活”，不适合代替人工整理的总结；
- 折叠范围永远避开 `preserveRecentMessages` / `preserveRecentTokens` 保护的尾部（当前这轮对话不会被折）；
- 插件自己写的 checkpoint 不会被再次折叠，避免“摘要的摘要”；
- 折掉的原文仍在 append-only 日志里，但 `decompress` 只认内核 block，这类 checkpoint 只能靠日志回溯。

## 原生压缩守卫

dsh-tui 0.14.x 把 `standard` / `ptc` / `cordis` 预设挂成内存里的 `PresetTree`，预设中的 `compaction-basic` 行不经过宿主 Loader，所以 `internal/config` 里的“按 name 禁用行”根本看不到它们。插件改为在 `agent/created`（以及 `agent/pre-step` 兜底）拿到该 agent 预设的 `compaction` 服务，patch 掉两个入口：

- **主动压力压缩**（`compactIfNeeded(agent, 'pressure')`）返回 `null`：正常推进时只由本插件的 `compress` 折 surface；
- **溢出恢复**（`compactIfNeeded(agent, 'context-overflow')`）**原样委派给原生实现**。它是会话已经越过模型窗口时唯一的救命通道：原生实现会先让 `toolResultPruner` 把超大工具结果剪短（不调用模型），再按需摘要，然后让请求重试。早期版本把这条路径一起掐掉，结果是一个本可恢复的溢出直接变成裸的 provider 400（`maximum context length is N tokens`），会话再也进不去；
- **手写 `/compact`**（`compactNow`）抛一个真正的 `ManualCompactionError`（`code: 'cancelled'`，错误类从 profile 的 `@deepseek-ai/dsh-compaction` 解析；解析不到时退化为同名同 `code` 的 `Error`），`/compact` 会显示 “Compaction cancelled.”，而不是两套压缩同时写 `compaction/summary`。

`toolResultPruner` 本身**不再被 patch**：它只在压缩真正运行时才动手，保留它才能让上面的溢出恢复把超大会话拉回窗口内。

如果宿主没有 `agentPresets` 服务（例如精简 profile），插件会尝试从该 agent 自己的 preset context 读取 `compaction` 服务；两者都拿不到时才打一条 warning 并保持原生压缩不动——此时应把 `disableNativeCompaction` 设为 `false`，或自行确认只保留一套压缩。`minimal` 预设本身不带 compaction 服务，不会触发这条路径。

## 工具的行为

`acp_status` 默认打印两段：内核的体检报告（用量、活跃 block、token 分布），以及**当前可压区间**——这一段直接取内核 nudge 用的那份推荐（`NudgeDecision.compressibleRanges`，经 `formatRanges` 渲染），所以每一行里的 ref 通常都能被 `compress` 当场接受。唯一例外是手动把区间截在一条多 block 事件的中间：`compress` 会明确要求覆盖整条事件，而不是遮掉未摘要的 sibling。另一层过滤是 dsh surface：如果区间里的消息已经被另一个压缩器（原生 checkpoint 或别的插件）折掉，`acp_status` 会把该行隐藏并注明 “no longer on the current dsh surface”，避免模型先写摘要再被 `commit` 拒绝。

这一点是刻意做的：内核自己的 `scope: 'uncompressed'` 明细按“可见消息”分组，而受保护消息（system / developer prompt、媒体）在 ref 空间里是字面量 `BLOCKED`，分组跨过它们时会打印出 `BLOCKED–m000NN` 这种不可用的区间。本插件默认视图不暴露它；显式传 `scope` 查明细时，这些行也会被替换成一行说明。

`compress` 的参数就是内核的 schema（`content` 放 JSON 字符串或对象数组，一次调用折完所有区间）。被拒时内核会在错误里附带当前的合法区间。

## 为什么默认不注入 nudge

dsh 的 `agent/pre-step` 没有“临时消息”通道：listener 返回的任何消息都会被 `agent-loop` 追加进 durable log。所以内核的 nudge 默认不写进会话，模型通过 `acp_status` 拿到同样的信息（当前用量、可压区间、活跃 block）——一次工具调用，零日志污染。把 `injectNudge` 打开才会在每一步追加一条 `source.kind = 'bili-compaction-nudge'` 的 user 消息。

**不注入时插件不会自己压缩**：内核只“建议”折叠，真正的 `compress` 由模型发起（或 dsh 原生在压力/溢出时动手）。所以如果希望它在使用量到达某个比例时自动催着模型压缩，就要同时打开 `injectNudge` 并调低 nudge 曲线：

```yaml
- id: bili-compaction
  config:
    injectNudge: true
    kernel:
      nudge:
        minContextLimitPct: 0.2      # 默认 0.45：越过 20% 就开始提醒
        maxContextLimitPct: 0.6      # 默认 0.75
        emergencyThresholdPct: 0.85  # 默认 0.95
```

未被投递的 nudge 不会推进内核的“已提醒”水位（`advanceNudge: false`），所以关掉 `injectNudge` 期间错过的提醒会在重新打开后立刻补上，而不是被静默吞掉。

## 安装

插件以 dsh-tui Community v0.15 插件形式发布：仓库根目录带 `dsh-plugin.json`，`facets.host.entry` 指向已提交的 `dist/index.js`，因此从 GitHub 克隆后不需要再构建：

```powershell
git clone https://github.com/MomentDerek/dsh-tui-bili-compaction.git
dsh plugin --profile dsh-tui add link:<克隆目录>
```

安装前可以用 `/plugins check <克隆目录>/dsh-plugin.json` 验证清单。包同时自带 `cordis.patch.yml`（`dsh.bundle.patch`），loader 会插入 `bili-compaction` 行；装完重启 dsh-tui。

和 `billion-context` 同时装着也能跑，但两者都会压缩：要交给本插件，就把 `billion-context` 从 `dsh.profile.bundles` 里去掉（或至少让它的 `dsh-native` 不接管）。

## 救援一个已经超窗的会话

如果某个会话在换插件前就已经超过模型窗口（`dsh-tui --resume` 直接报 `maximum context length is … tokens`），它进不了任何 pre-step 钩子，插件也没有机会插手。`scripts/rescue-session.mjs` 是一次性的离线救援工具：给日志末尾追加**一条** durable `surfaceOp: 'replace'`，把最老的一段消息换成一份离线摘要，保留最近若干轮原文。

```powershell
# 1) 读日志、算折叠点（保留约 160 万字符），并导出旧消息的叙事文本
node scripts/rescue-plan.mjs <sessionId> tmp-rescue
# 2) 把 tmp-rescue/narrative.txt 总结成 tmp-rescue/summary.md（这一步可以交给另一个模型/人）
# 3) 干跑，再用 dsh 自己的 foldSurface 验一遍
node scripts/rescue-session.mjs <sessionId> tmp-rescue/plan.json tmp-rescue/summary.md
node scripts/rescue-validate.mjs <session.jsonl.zstd> tmp-rescue/plan.json tmp-rescue/summary.md
# 4) 备份原日志后真正写入
node scripts/rescue-session.mjs <sessionId> tmp-rescue/plan.json tmp-rescue/summary.md --apply
```

写入前会把原日志复制成 `*.bak-<时间戳>`；写入后 `foldSurface` 校验通过、token 估算落回窗口内，才建议重启 dsh-tui 继续该会话。跑过这一步之后，插件守卫里的“溢出恢复委派”会接管后续增长。

如果折叠完仍然贴着窗口（`requested … tokens (… in the messages, … in the completion)` 里 messages 已经低于窗口、但 completion 把总数顶出去），说明 harness 把“窗口剩余量”当成了输出预算，而它的 token 估算比 provider 实测低几个百分点。两条对策一起用：

1. 给路由的模型钉一个输出上限，别让 harness 用窗口剩余量当输出预算：

   ```yaml
   providers:
     deepseek:
       models:
         - id: deepseek-flash
           maxTokens: 32768
   ```

2. 再折一层：`rescue-fold2.mjs` 会在已有 checkpoint 之后继续折叠最老的一段消息，用机械摘要（用户消息全文 + 助手片段 + 工具调用名）替代模型调用，最近若干轮保持原文：

   ```powershell
   node scripts/rescue-fold2.mjs <sessionId> --target-chars 950000          # 干跑
   node scripts/rescue-fold2.mjs <sessionId> --target-chars 950000 --apply  # 备份后写入
   ```

**不要用 `rescue-prune.mjs` 处理已经关闭的日志**：`tool/result` 的 surface replacement 必须落在某个 open turn 里（dsh 的 v4 格式校验会报 `tool/result is outside an open turn`），而救援时日志末尾的 turn 早已 `turn/end`。该脚本只适合在会话仍开着、且知道当前 turn 的情况下使用。

每个脚本写完后都可以用 dsh 自己的校验器复核：

```powershell
node scripts/rescue-validate.mjs <sessionFile>        # foldSurface：surface 折叠是否合法
node scripts/format-check.mjs <sessionFile>           # 完整 v4 格式校验（与 dsh-tui 恢复时同一套规则）
```

`format-check.mjs` 需要能找到安装好的 dsh；它会从 `%APPDATA%/fnm/node-versions/*` 里挑最新版本。改完日志后请先跑它，通过再重启 dsh-tui。

## 开发

```powershell
$env:NODE_ENV = "development"
npm install --include=dev   # 生产环境会跳过 devDependencies
npm run build               # tsc -p tsconfig.json
npm run check:manifest      # 验证 dsh-plugin.json 与入口
npm test                    # node --test tests/*.test.mjs
```

发布前请重新 `npm run build` 并提交 `dist/`；GitHub 安装直接使用仓库里的构建产物。

内核在 `vendor/acp-kernel/`，是从 `billion-context` 仓库 `kernel/` 构建并拷入的产物（`dist/` + `.d.ts`）。升级内核：在 billion-context 里 `npm run build --workspace` 后重拷 `kernel/dist`。

## 出处与许可

本插件以 MIT 许可开源。

压缩引擎使用 **acp-kernel** 与 **billion-context**：

- <https://github.com/ranxianglei/acp-kernel>
- <https://github.com/ranxianglei/billion-context>

`vendor/acp-kernel/` 是上述项目的未修改构建产物，采用 MIT + 附加署名条款；完整的第三方许可与署名要求见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 已知边界

- `modelContextLimit` 可配置；未显式配置时插件读 `session.requestContext().contextWindow`，路由未通告窗口时回退 1M。显式配置的值始终优先，不会被路由通告的更大窗口覆盖。
- 压缩区间只能落在 `m00002` 之后（内核保留第一段 user 开场），以及 `preserveRecentMessages` / `preserveRecentTokens` 之外——默认最后 3 条消息、5000 token 不许折，所以“刚贴进来的长文”要等下一轮才进区间。这个保护现在对显式 `compress` 也生效：内核自己计算保护 ref，插件不再传错类型的 `protectedMessageIds`。
- 单区间字符数要过内核的 `compress.minCompressRange`（默认 5000 字符），太短会直接被拒；小会话压不动是内核策略，不是插件 bug。
- `commit` 会先规划整批替换：任何区间若“遮蔽区间里出现该 block 未覆盖的可见消息”或“只覆盖一条多 block 事件的一部分”，整批拒绝且不写 durable replacement、不保存内核状态，不会留下一个假 active block。宁可少折，不做半折叠。
- 和 `billion-context` 同时加载时两边工具同名（`compress` / `decompress` / `acp_status`），只能留一个。
- 状态 JSON 现在会逐项校验 block 与 contentStore：损坏的 block 会被丢弃，坏掉的 contentStore 回退为空；但这不是加密或版本迁移机制，跨大版本升级仍建议手动清一次状态目录。
- `acp_reset` 清空 LSM 时会扫描日志里已有的 `acp_block_bN` checkpoint，把 `nextBlockId` 推到最大值之后，避免重置后再次生成重复的 message id。

## 验证状态

- `npm test`：17 个用例，覆盖 store 归一化/损坏回退、原生压缩行剥离与 preset 服务守卫（压力压缩返回 `null`、溢出恢复委派原生实现、`toolResultPruner` 不被改写）、`ManualCompactionError` 解析、preset context 兜底、append-origin 视图与 ref 编号、durable replace 提交、未知 ref 拒绝、多 block 事件的半覆盖拒绝、失败提交不落 active block、显式 compress 不吃保护尾、动态窗口识别、只读状态不推进 nudge、reset 不重用 block id、`acp_status` 隐藏已被 surface 折掉的区间，以及「给出的 ref 必须能被 `compress` 当场接受」的回归。
- 真实 dsh 会话（headless profile，`preserveRecentMessages: 0`）：`acp_status` → `compress` 一次成功，dsh 日志落下 `surfaceOp: 'replace'`，token meter 随之下降；插件状态文件里出现 `b1 m00009–m00017 3374 tokens`。
