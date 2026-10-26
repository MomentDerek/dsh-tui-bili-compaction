/**
 * The subset of the dsh request message shapes this plugin touches.
 *
 * `dsh` hands plugins its own message types through the `llm/stream`
 * waterfall. Those types live in `@deepseek-ai/dsh-llm`, which a profile
 * plugin cannot import (the profile's module realm does not resolve harness
 * packages), so the plugin works against this structural mirror instead. Every
 * member is optional or widened so a real dsh message stays assignable.
 */

export interface DshTextBlock {
  type: 'text'
  text: string
}

export interface DshReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface DshToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}

/** Any other block dsh may carry (image, file, future kinds). */
export interface DshOpaqueBlock {
  type: string
  [key: string]: unknown
}

export type DshContentBlock = DshTextBlock | DshReasoningBlock | DshToolCallBlock | DshOpaqueBlock

export interface DshMessageSource {
  kind?: string
  [key: string]: unknown
}

export interface DshMessage {
  readonly id?: string
  readonly role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | string
  readonly content: readonly DshContentBlock[]
  readonly source?: DshMessageSource
  readonly toolCallId?: string
  readonly isError?: boolean
}

/** The parts of `GenerateOptions` this plugin reads or rewrites. */
export interface DshGenerateOptions {
  provider?: string
  model?: string
  messages: readonly DshMessage[]
  purpose?: string
  sessionId?: unknown
  signal?: unknown
  [key: string]: unknown
}

export interface DshToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface DshToolOutputDefinition {
  schema: unknown
  render: (args: unknown, value: unknown) => Array<Record<string, unknown>>
}

export interface DshToolDefinition extends DshToolSchema {
  output: DshToolOutputDefinition
  execute: (args: unknown, exec: DshToolRunContext) => Promise<unknown>
}

export interface DshSessionAppendOptions {
  surfaceOp?: { op: 'replace'; startSeq: number; endSeq: number }
  sourceEventSeqs?: readonly number[]
}

/** The parts of `@deepseek-ai/dsh-session`'s `Session` this plugin reads. */
export interface DshSessionLike {
  readonly id: string
  readonly seq: number
  readonly surface: { readonly nodes: readonly number[] }
  eventAt(seq: number): unknown
  deriveEventMessage(event: unknown): DshMessage | null
  append(type: string, data: unknown, options?: DshSessionAppendOptions): { seq: number }
  /** Latest route metadata; dsh advertises the real window here when known. */
  requestContext?(): { contextWindow?: number } | undefined
}

export interface DshAgentContextLike {
  /** Loader base URL, used as a module-resolution anchor for harness packages. */
  readonly baseUrl?: string | URL
  get?(name: string): unknown
  [key: string]: unknown
}

export interface DshAgentLike {
  session?: DshSessionLike
  options?: { provider?: string; model?: string }
  /** Present on a live dsh Agent; used by `agentPresets.serviceFor`. */
  readonly ctx?: DshAgentContextLike
}

/** The preset registry can read a service out of an isolated preset realm. */
export interface DshAgentPresetsLike {
  serviceFor?(agent: DshAgentLike, name: string): unknown
}

export interface DshTokenSurfaceNode {
  seq: number
  tokens: number
  heuristicTokens: number
}

export interface DshTokenMeasurement {
  totalTokens: number
  surfaceTokens: number
  nodes: readonly DshTokenSurfaceNode[]
}

export interface DshTokenMeter {
  measure(session: DshSessionLike): DshTokenMeasurement
  estimateMessage(message: unknown): number
}

export interface DshToolRunContext {
  agent?: DshAgentLike
  signal?: AbortSignal
  [key: string]: unknown
}
