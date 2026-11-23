/**
 * 码道网关的请求体构造与响应体规范化。
 *
 * 参考：dsh-connect-madao（MIT, XLNC-L）`src/protocol/body.ts` — `developer →
 *       system` 的改写规则、`image_url` 保留判定、`reasoning_effort` 字段名。
 * 改动：① 删掉了 madao 的 `strength → reasoning_effort` 中间层，直接用
 *       DSH 的 `ReasoningEffortId` 映射（`off → none`）；
 *       ② 增加了对 `max_tokens` 的上界夹取。M0 实测：网关接受 131072，但
 *       393216 时**不报错**，直接给一个没有任何有效帧的空流 —— 这种失败模式
 *       比报错更难排查，必须在发出去之前夹住；
 *       ③ 增加了 `tool_choice` 的字符串压缩，避免上游把对象形式判为非法；
 *       ④ 不再注入 `client-ip`（两个参考实现都伪造内网地址，我们不做）。
 *
 * @module dsh-connect-codearts/protocol/body
 */
import type { ReasoningEffortId } from './types.ts'
import { CODEARTS_MAX_OUTPUT_CEILING } from './types.ts'

/** 上游一条消息。`role` 已经过 `developer → system` 规范化。 */
export interface UpstreamMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | readonly UpstreamContentPart[]
  readonly tool_call_id?: string
  readonly tool_calls?: readonly UpstreamToolCall[]
}

/**
 * 上游认识的内容分片。M0 实测（8×8 纯红 PNG + `deepseek-v4.1-flash` 答「红色」）：
 * 码道网关认标准 OpenAI `image_url`；它自己的内部格式 `{type:'file'}` 与
 * `{type:'image'}` 反而被忽略。
 */
export type UpstreamContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }

export interface UpstreamToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

/** 组装好的上游请求体。字段名与 OpenAI Chat Completions 一致。 */
export interface UpstreamChatBody {
  model: string
  messages: UpstreamMessage[]
  stream: true
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  tools?: readonly unknown[]
  tool_choice?: string
  reasoning_effort?: string
}

/** Conservative route budget below the request sizes rejected by the gateway. */
export const CODEARTS_MAX_CHAT_BODY_BYTES = 10_000_000

const OMITTED_PREVIEW_TEXT = '[Earlier tool preview images omitted to fit the CodeArts request size limit.]'

export type SerializedChatBody =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | { readonly ok: false; readonly bytes: number }

/**
 * Enforce the UTF-8 JSON body budget before signing. Remove earlier PTC previews
 * first, keeping their accompanying text and leaving user attachments intact.
 */
export const serializeChatBody = (
  body: UpstreamChatBody,
  previewMessageIndexes: readonly number[],
  limit = CODEARTS_MAX_CHAT_BODY_BYTES,
): SerializedChatBody => {
  const original = JSON.stringify(body)
  let bytes = Buffer.byteLength(original)
  if (bytes <= limit) return { ok: true, text: original, bytes }

  const messages = [...body.messages]
  for (const index of previewMessageIndexes) {
    const message = messages[index]
    if (message === undefined || typeof message.content === 'string') continue
    const text = message.content.filter(part => part.type === 'text')
    if (text.length === message.content.length) continue

    const replacement = {
      ...message,
      content: normalizeContent([...text, { type: 'text', text: OMITTED_PREVIEW_TEXT }]),
    }
    bytes += Buffer.byteLength(JSON.stringify(replacement)) - Buffer.byteLength(JSON.stringify(message))
    messages[index] = replacement
    if (bytes <= limit) {
      return { ok: true, text: JSON.stringify({ ...body, messages }), bytes }
    }
  }

  return { ok: false, bytes }
}

/**
 * 调用方交进来的消息形状。
 *
 * `role` 放宽成 `string` 而不是 `UpstreamMessage['role']`：宿主可能传来
 * `developer`（它承载系统提示用），而 `buildUpstreamBody` 的职责就包含把
 * 这类角色规范化掉。如果这里收紧成四值联合，调用方就必须自己在外面做改写，
 * 于是「改写」这件事会有两处实现，其中一处迟早漏掉。
 */
export type UpstreamMessageInput = Omit<UpstreamMessage, 'role'> & { readonly role: string }

/** 调用方交进来的请求形状（DSH adapter 侧组装）。 */
export interface ChatBodyInput {
  readonly model: string
  readonly messages: readonly UpstreamMessageInput[]
  readonly maxTokens?: number | undefined
  readonly temperature?: number | undefined
  readonly topP?: number | undefined
  readonly stop?: readonly string[] | undefined
  readonly tools?: readonly unknown[] | undefined
  readonly toolChoice?: string | undefined
  readonly reasoningEffort?: ReasoningEffortId | undefined
}

/**
 * 把 DSH 的推理档位映射成网关认识的 `reasoning_effort` 取值。
 *
 * M0 实测（`glm-5.3-flash`，同一 prompt 三档）：
 *   不传   → 5991ms，reasoning 303 帧 / 1041 字，`reasoning_tokens=306`
 *   high   → 2241ms，reasoning   0 帧 /    0 字，`reasoning_tokens=91`
 *   max    → 6198ms，reasoning 230 帧 /  706 字，`reasoning_tokens=230`
 *
 * 注意 `high` 那一行：帧数和字数是 0，但 `reasoning_tokens` 不为 0 —— 思考
 * 确实发生了，只是内容被上游截住不下发。这不是故障，界面文案要写明
 * 「思考内容可能不下发」，不要让用户以为插件坏了。
 *
 * `off` 必须发成 `none`，网关不认 `off`。
 */
export const upstreamReasoningEffort = (effort: ReasoningEffortId | undefined): string | undefined => {
  if (effort === undefined) return undefined
  return effort === 'off' ? 'none' : effort
}

/**
 * 夹住 `max_tokens`。
 *
 * 上界来源：M0 对 `deepseek-v4.1-flash` 逐档实测，65536 / 65537 / 131072 都
 * 正常，393216 静默给空流（HTTP 200、`finish_reason` 为 null、零有效帧）。
 * 所以安全上界取 131072。
 *
 * 下界不是 0：码道模型先输出 `reasoning_content`，与正文共享同一份
 * `max_tokens` 预算。给 16 这种小值时全部被思考吃掉，正文为空、
 * `finish_reason` 变成 `length`，看起来像「模型坏了」。调用方没给值时用
 * 32768（约两万四千汉字），既留足正文空间又不至于把上下文窗口挤掉。
 */
export const clampMaxTokens = (
  requested: number | undefined,
  fallback = 32_768,
): number => {
  const value = requested ?? fallback
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), CODEARTS_MAX_OUTPUT_CEILING)
}

/**
 * 把内容分片规范化成上游认识的形状。
 *
 * - 纯文本 → 折成一个字符串（上游对字符串形式最宽容）
 * - 含图片 → 保留 `text` 与 `image_url` 组成的数组
 * - 空数组 → 空字符串（上游不接受空数组）
 *
 * 其他 type（`file` / `image` / 音频等）**一律丢弃**：实测码道网关只认标准
 * OpenAI 的 `image_url`，把内部格式 `{type:'file'}` 或 `{type:'image'}` 原样
 * 发过去不会报错，只会让模型「看不见图」—— 那种静默失败比 400 难查得多。
 * 丢弃之后如果只剩文本，仍然折成字符串，避免给上游一个只含文本的数组。
 */
export const normalizeContent = (
  parts: readonly UpstreamContentPart[],
): string | UpstreamContentPart[] => {
  const kept = parts.filter((part) => part.type === 'text' || part.type === 'image_url')
  if (kept.length === 0) return ''
  if (kept.every((part) => part.type === 'text')) {
    return kept.map((part) => (part as { text: string }).text).join('\n')
  }
  return kept
}

/**
 * 组装上游请求体。
 *
 * 角色改写在**这一层**再做一次（`toUpstreamMessages` 已经做过一次）。看起来
 * 冗余，但这是故意的：网关遇到 `developer` 回的是
 * `InferHub.001001044.400: Message role cannot empty` —— 报错文案说的是「role
 * 不能为空」，与「不认这个角色名」毫无字面关系。一旦哪个调用方绕过
 * `toUpstreamMessages` 直接拼 body，失败现场会完全误导人。两道闸比一道稳。
 */
export const buildUpstreamBody = (input: ChatBodyInput): UpstreamChatBody => {
  const body: UpstreamChatBody = {
    model: input.model,
    messages: input.messages.map((message) => ({
      ...message,
      role: upstreamRole(message.role),
    })),
    stream: true,
  }

  const maxTokens = clampMaxTokens(input.maxTokens)
  body.max_tokens = maxTokens

  if (input.temperature !== undefined) body.temperature = input.temperature
  if (input.topP !== undefined) body.top_p = input.topP
  if (input.stop !== undefined && input.stop.length > 0) body.stop = [...input.stop]
  if (input.tools !== undefined && input.tools.length > 0) {
    body.tools = input.tools
    // 上游只接受字符串形式；对象形式（{type:'function',function:{...}}）会被
    // 判成参数非法。缺省时显式给 auto，避免上游按「未指定」走另一条分支。
    body.tool_choice = input.toolChoice ?? 'auto'
  }

  const effort = upstreamReasoningEffort(input.reasoningEffort)
  if (effort !== undefined) body.reasoning_effort = effort

  return body
}

/** 把 DSH 的消息角色映射成网关接受的四种。`developer` 是宿主承载系统提示用的。 */
export const upstreamRole = (role: string): UpstreamMessage['role'] =>
  role === 'developer' ? 'system' : (role as UpstreamMessage['role'])
