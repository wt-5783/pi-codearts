/**
 * 码道网关 SSE 流的解析与首帧错误嗅探。
 *
 * 参考：dsh-connect-madao（MIT, XLNC-L）`src/protocol/sse.ts` — ai-sdk 与
 *       OpenAI 两种形状的宽容解析思路。
 * 参考：dsh-huaweicloud-connect（MIT, Alanine-孔硕）`lib/drivers/codearts.js`
 *       的 `inspectStreamHead` / `extractInlineError` — 「HTTP 200 也可能是
 *       错误」的判定必须要求出现错误字段**且**不能同时出现 `choices`。
 * 改动：① 首帧错误不再是「剥掉首帧再塞回去」，而是返回结构化错误后由调用方
 *       决定重试，语义更清楚；② 增量语义经 M0 实测确认是**拼接**（不是替换），
 *       所以这里不做去重，直接累加 —— 见 `StreamAccumulator` 的注释。
 *
 * @module dsh-connect-codearts/protocol/sse
 */

/**
 * 上游内联错误。
 *
 * 网关有一个很容易误判的行为：**HTTP 状态码 200，但第一帧就是错误**。
 * 如果原样交给上层，用户看到的是「流意外结束」这类传输层报错，与真实原因
 * （凭据过期、账号没有该模型权益、参数非法）毫无关系，而且会被当成网络故障
 * 参与重试，最后还可能触发模型熔断。
 */
export interface InlineStreamError {
  readonly code: string
  readonly message: string
}

/** 一条 SSE 事件的解析结果。 */
export type SseEvent =
  | { readonly kind: 'data'; readonly payload: string }
  | { readonly kind: 'done' }
  | { readonly kind: 'ignore' }

/**
 * 从一段 SSE 文本里切出完整事件。
 *
 * 事件之间以空行分隔；单事件内可能有多个 `data:` 行（按 SSE 规范应当用换行
 * 拼接）。注释行（`:` 开头）与 `event:` / `id:` / `retry:` 字段一律忽略 ——
 * 码道网关只发 `data:`。
 */
export const parseSseEvents = (chunk: string): SseEvent[] => {
  const events: SseEvent[] = []
  for (const block of chunk.replace(/\r\n?/g, '\n').split('\n\n')) {
    if (block.trim() === '') continue
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    }
    if (dataLines.length === 0) continue
    const payload = dataLines.join('\n')
    if (payload.trim() === '[DONE]') {
      events.push({ kind: 'done' })
      continue
    }
    events.push({ kind: 'data', payload })
  }
  return events
}

/**
 * 判断一帧 `data:` 是不是内联错误。
 *
 * 判定必须同时满足：
 *   1. 出现错误字段（`error_code`/`error_msg` 或 `error.code`/`error.message`）
 *   2. **不能**出现 `choices` —— 正常的 chunk 也会带 `"error": null`，
 *      只判第一条会把每一个正常帧都误判成错误。
 *
 * 两种形状实测都出现过：
 *   `{"error_code":"InferHub.001001044.400","error_msg":"Message role cannot empty"}`
 *   `{"error":{"code":"...","message":"..."}}`
 */
export const inlineErrorOf = (payload: string): InlineStreamError | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>

  // 正常帧同样带 choices（或 error:null），先排除。
  if (Array.isArray(record['choices'])) return undefined

  const flatCode = record['error_code']
  const flatMessage = record['error_msg']
  if (typeof flatCode === 'string' && flatCode !== '') {
    return {
      code: flatCode,
      message: typeof flatMessage === 'string' ? flatMessage : flatCode,
    }
  }

  const nested = record['error']
  if (typeof nested === 'object' && nested !== null) {
    const nestedRecord = nested as Record<string, unknown>
    const code = nestedRecord['code']
    const message = nestedRecord['message']
    if (typeof code === 'string' && code !== '') {
      return { code, message: typeof message === 'string' ? message : code }
    }
  }

  return undefined
}

/** 上游一个流式 chunk 的增量。 */
export interface ChatDelta {
  readonly content?: string
  readonly reasoning?: string
  readonly toolCalls?: readonly RawToolCallDelta[]
  readonly finishReason?: string | null
}

/** 分片下发的工具调用。**必须累加**，不能假设只有一帧。 */
export interface RawToolCallDelta {
  readonly index: number
  readonly id?: string
  readonly name?: string
  readonly argumentsDelta?: string
}

/** 上游的用量帧。 */
export interface UpstreamUsage {
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
  readonly cachedTokens?: number
  readonly reasoningTokens?: number
}

/** 从一帧 chunk 里抽出的全部信息。 */
export interface ParsedChunk {
  readonly delta?: ChatDelta
  readonly usage?: UpstreamUsage
  readonly inlineError?: InlineStreamError
}

const pickNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 解析一帧 chunk。
 *
 * 同时认识两种形状：标准 OpenAI（`choices[].delta`）与码道自己的 ai-sdk 风格
 * （`type:'text-delta'` / `type:'reasoning'`）。M0 实测走的是标准 OpenAI 形状，
 * 但网关的实现是拼装的，两条分支都留着更稳。
 */
export const parseChunk = (payload: string): ParsedChunk => {
  const inlineError = inlineErrorOf(payload)
  if (inlineError !== undefined) return { inlineError }

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const record = parsed as Record<string, unknown>

  const usage = readUsage(record)

  const choices = record['choices']
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>
    const rawDelta = choice['delta']
    const delta: ChatDelta = {}
    if (typeof rawDelta === 'object' && rawDelta !== null) {
      const d = rawDelta as Record<string, unknown>
      if (typeof d['content'] === 'string' && d['content'] !== '') Object.assign(delta, { content: d['content'] })
      // 思考内容字段名是 `reasoning_content`（OpenAI 兼容扩展）。
      if (typeof d['reasoning_content'] === 'string' && d['reasoning_content'] !== '') {
        Object.assign(delta, { reasoning: d['reasoning_content'] })
      }
      const rawToolCalls = d['tool_calls']
      if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
        Object.assign(delta, { toolCalls: rawToolCalls.map(readToolCallDelta) })
      }
    }
    const finish = choice['finish_reason']
    if (typeof finish === 'string' || finish === null) Object.assign(delta, { finishReason: finish })
    return { delta, ...(usage === undefined ? {} : { usage }) }
  }

  // ai-sdk 风格回退。
  const type = record['type']
  if (type === 'text-delta') {
    const text = record['text'] ?? record['delta']
    if (typeof text === 'string' && text !== '') return { delta: { content: text } }
  }
  if (type === 'reasoning' || type === 'reasoning-delta') {
    const text = record['text'] ?? record['delta']
    if (typeof text === 'string' && text !== '') return { delta: { reasoning: text } }
  }

  return usage === undefined ? {} : { usage }
}

const readToolCallDelta = (value: unknown): RawToolCallDelta => {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const index = pickNumber(record, 'index') ?? 0
  const result: { -readonly [K in keyof RawToolCallDelta]: RawToolCallDelta[K] } = { index }
  if (typeof record['id'] === 'string' && record['id'] !== '') result.id = record['id']
  const fn = record['function']
  if (typeof fn === 'object' && fn !== null) {
    const fnRecord = fn as Record<string, unknown>
    if (typeof fnRecord['name'] === 'string' && fnRecord['name'] !== '') result.name = fnRecord['name']
    if (typeof fnRecord['arguments'] === 'string' && fnRecord['arguments'] !== '') {
      result.argumentsDelta = fnRecord['arguments']
    }
  }
  return result
}

const readUsage = (record: Record<string, unknown>): UpstreamUsage | undefined => {
  const usage = record['usage']
  if (typeof usage !== 'object' || usage === null) return undefined
  const u = usage as Record<string, unknown>
  const details = u['prompt_tokens_details']
  const completionDetails = u['completion_tokens_details']
  const result: { -readonly [K in keyof UpstreamUsage]: UpstreamUsage[K] } = {}
  const promptTokens = pickNumber(u, 'prompt_tokens')
  if (promptTokens !== undefined) result.promptTokens = promptTokens
  const completionTokens = pickNumber(u, 'completion_tokens')
  if (completionTokens !== undefined) result.completionTokens = completionTokens
  const totalTokens = pickNumber(u, 'total_tokens')
  if (totalTokens !== undefined) result.totalTokens = totalTokens
  if (typeof details === 'object' && details !== null) {
    const cached = pickNumber(details as Record<string, unknown>, 'cached_tokens')
    if (cached !== undefined) result.cachedTokens = cached
  }
  if (typeof completionDetails === 'object' && completionDetails !== null) {
    const reasoning = pickNumber(completionDetails as Record<string, unknown>, 'reasoning_tokens')
    if (reasoning !== undefined) result.reasoningTokens = reasoning
  }
  return result
}

/**
 * 把分片的工具调用合并成完整调用。
 *
 * M0 实测单帧就能拿到完整的 `id` / `name` / `arguments`，但协议本身允许分片
 * （`arguments` 逐片拼接），所以按 `index` 累加而不是取最后一次。
 */
export class ToolCallAccumulator {
  readonly #calls = new Map<number, { id: string; name: string; arguments: string }>()

  push(deltas: readonly RawToolCallDelta[]): void {
    for (const delta of deltas) {
      const existing = this.#calls.get(delta.index)
      if (existing === undefined) {
        this.#calls.set(delta.index, {
          id: delta.id ?? '',
          name: delta.name ?? '',
          arguments: delta.argumentsDelta ?? '',
        })
      } else {
        if (existing.id === '' && delta.id !== undefined) existing.id = delta.id
        if (delta.name !== undefined && delta.name !== '') existing.name += delta.name
        if (delta.argumentsDelta !== undefined) existing.arguments += delta.argumentsDelta
      }
    }
  }

  get(index: number): Readonly<{ id: string; name: string; arguments: string }> | undefined {
    return this.#calls.get(index)
  }

  /** 按 index 升序返回，保证稳定的调用顺序。 */
  finish(): Array<{ id: string; name: string; arguments: string }> {
    return [...this.#calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({ ...call }))
  }

  get size(): number {
    return this.#calls.size
  }
}
