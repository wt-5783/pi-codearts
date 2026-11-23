/**
 * 带签名的 fetch：pi 自带的 openai-completions 实现发请求时经过这里，
 * 把标准 OpenAI 请求改成码道网关接受的形状、用 IAM AK/SK 做 SDK-HMAC-SHA256 签名后发出，
 * 并把华为的错误（HTTP 非 2xx，或 200 流里的内联错误帧）转成 pi 能显示的异常。
 *
 * 协议细节全部来自 vendor/dsh-connect-codearts（MIT）：sign.ts（签名）、body.ts（请求体归一化）、
 * upstream.ts（必须携带的头、会话头）。
 */
import { randomUUID } from 'node:crypto'
import type { CodeArtsCredentials } from '../vendor/dsh-connect-codearts/protocol/sign.ts'
import { signRequest } from '../vendor/dsh-connect-codearts/protocol/sign.ts'
import {
  CODEARTS_CHAT_PATH,
  CODEARTS_DEFAULT_MAX_OUTPUT,
  CODEARTS_MAX_OUTPUT_CEILING,
} from '../vendor/dsh-connect-codearts/protocol/types.ts'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 稳定的会话 id：网关按它计会话数，每请求换新会被算成新会话。只用 AK 后 12 位派生。 */
const sessionIdOf = (accessKey: string): string => {
  const tail = accessKey.slice(-12).replace(/[^A-Za-z0-9]/g, '')
  return `pi-codearts-${tail === '' ? 'default' : tail}`
}
const traceId = (): string => randomUUID().replace(/-/g, '')

/**
 * max_tokens 上界 131072（实测 393216 会得到空流）；下界不能太小：码道模型先输出
 * reasoning_content，与正文共享同一份 max_tokens 预算。缺省 32768。
 */
export const clampMaxTokens = (requested: number | undefined): number => {
  const value = requested ?? CODEARTS_DEFAULT_MAX_OUTPUT
  if (!Number.isFinite(value) || value <= 0) return CODEARTS_DEFAULT_MAX_OUTPUT
  return Math.min(Math.floor(value), CODEARTS_MAX_OUTPUT_CEILING)
}

/** 网关只接受字符串形式的 tool_choice；对象形式会被判成参数非法。 */
const normalizeToolChoice = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value['type'] === 'string') {
    const type = value['type']
    if (type === 'auto' || type === 'none' || type === 'required') return type
    if (type === 'function') return 'required'
  }
  return undefined
}

/** 网关不认识、或语义不同的 OpenAI 字段：宁可少传也不 400。 */
const DROPPED_FIELDS = new Set([
  'store', 'metadata', 'parallel_tool_calls', 'service_tier', 'prediction', 'logprobs', 'top_logprobs',
  'seed', 'user', 'n', 'presence_penalty', 'frequency_penalty', 'max_completion_tokens', 'stream_options',
])

/**
 * 把 pi 发出的标准 OpenAI 请求体改成码道网关接受的形状
 * （与 dsh-connect-codearts 的 buildUpstreamBody 规则一致）。
 */
export const normalizeRequestBody = (body: unknown): unknown => {
  if (!isRecord(body)) return body
  const out: Record<string, unknown> = { ...body }

  if (Array.isArray(out['messages'])) {
    out['messages'] = out['messages'].map((message) =>
      isRecord(message) && message['role'] === 'developer' ? { ...message, role: 'system' } : message,
    )
  }

  // 有的调用方只给 max_completion_tokens；丢弃该字段前先把它当作请求值，否则会被悄悄改成默认值
  const requested =
    typeof out['max_tokens'] === 'number'
      ? out['max_tokens']
      : typeof out['max_completion_tokens'] === 'number'
        ? out['max_completion_tokens']
        : undefined
  out['max_tokens'] = clampMaxTokens(requested)

  if (Array.isArray(out['tools']) && out['tools'].length > 0) {
    out['tool_choice'] = normalizeToolChoice(out['tool_choice']) ?? 'auto'
  } else {
    delete out['tool_choice']
  }

  const effort = typeof out['reasoning_effort'] === 'string' ? out['reasoning_effort'].toLowerCase() : undefined
  if (effort === undefined || effort === 'off' || effort === 'none') delete out['reasoning_effort']
  else out['reasoning_effort'] = effort

  for (const field of DROPPED_FIELDS) delete out[field]
  return out
}

/**
 * 常见业务码的中文解释。华为的报错文案本身可读，但「下一步怎么做」往往缺失；
 * 这里只补可执行的一句，不改写原始文案。
 */
const HINT_BY_CODE = [
  // 认证类放在最前：DSH 的分类器把 5xx 上的 APIG.0613 归到「服务端临时故障」，对错凭证极具误导
  [/APIG\.0301|APIG\.0613|APIG\.0602|signature fail|Incorrect IAM authentication/i, 'AK/SK 校验未通过：核对「我的凭证 → 访问密钥」中的 AK（20 位）与 SK（40 位）是否完整、密钥是否已被删除或禁用'],
  [/TM\.00001041/i, '并发会话数已达上限（单账号约 3 个）：等上一轮结束，或减少并行子代理'],
  [/TM\.000010051/i, '该模型不在你的码道套餐内：用 /codearts-models 换一个'],
  [/ModelArts\.81001/i, '思考档位不被该模型接受：用 --thinking low / high / max'],
  [/STS5\.1806|invalid.*token/i, '凭证无效：检查 AK/SK 是否完整、是否已被禁用'],
  [/APIG\.0101/i, '网关路径不存在：多为区域/网关地址不对（PI_CODEARTS_GATEWAY）'],
] as const

const hintFor = (code: string, message: string): string | undefined => {
  for (const [pattern, hint] of HINT_BY_CODE) if (pattern.test(code) || pattern.test(message)) return hint
  return undefined
}

/** 从华为各种错误体里抠出业务码和文案。 */
const parseHuaweiError = (text: string, status: number): { code: string; message: string } => {
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed)) {
      const nested = isRecord(parsed['error']) ? parsed['error'] : undefined
      const code =
        (typeof parsed['error_code'] === 'string' ? parsed['error_code'] : undefined) ??
        (nested && typeof nested['code'] === 'string' ? nested['code'] : undefined) ??
        (typeof parsed['code'] === 'string' ? String(parsed['code']) : undefined) ??
        String(status)
      const message =
        (typeof parsed['error_msg'] === 'string' ? parsed['error_msg'] : undefined) ??
        (nested && typeof nested['message'] === 'string' ? nested['message'] : undefined) ??
        (typeof parsed['message'] === 'string' ? parsed['message'] : undefined) ??
        (typeof parsed['msg'] === 'string' ? parsed['msg'] : undefined)
      if (message !== undefined) return { code, message }
    }
  } catch {
    /* 非 JSON */
  }
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return { code: String(status), message: trimmed === '' ? `HTTP ${status}` : trimmed.slice(0, 240) }
}

/**
 * 网关会用 HTTP 200 返回内联错误（没有 choices、带 error_code / error 的帧）。
 * 这里在响应体上做一次透传扫描：遇到内联错误就让流报错，pi 会把它显示成失败原因，
 * 而不是把真实错误伪装成「流意外结束」。
 */
const pipeInlineErrors = (body: ReadableStream<Uint8Array>, log: (line: string) => void): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const inline = inlineErrorOf(line)
          if (inline !== undefined) {
            log(`upstream inline error: ${inline.code} ${inline.message}`)
            const hint = hintFor(inline.code, inline.message)
            controller.error(new Error(`码道 ${inline.code}: ${inline.message}${hint === undefined ? '' : `\n→ ${hint}`}`))
            return
          }
          controller.enqueue(encoder.encode(`${line}\n`))
        }
      },
      flush(controller) {
        if (buffer !== '') {
          const inline = inlineErrorOf(buffer)
          if (inline !== undefined) {
            log(`upstream inline error: ${inline.code} ${inline.message}`)
            const hint = hintFor(inline.code, inline.message)
            controller.error(new Error(`码道 ${inline.code}: ${inline.message}${hint === undefined ? '' : `\n→ ${hint}`}`))
            return
          }
          controller.enqueue(encoder.encode(buffer))
        }
      },
    }),
  )
}

const inlineErrorOf = (line: string): { code: string; message: string } | undefined => {
  if (!line.startsWith('data:')) return undefined
  const payload = line.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || Array.isArray(parsed['choices'])) return undefined
  const nested = isRecord(parsed['error']) ? parsed['error'] : undefined
  const code =
    (typeof parsed['error_code'] === 'string' && parsed['error_code'] !== '' ? parsed['error_code'] : undefined) ??
    (nested && typeof nested['code'] === 'string' && nested['code'] !== '' ? nested['code'] : undefined)
  if (code === undefined) return undefined
  const message =
    (typeof parsed['error_msg'] === 'string' ? parsed['error_msg'] : undefined) ??
    (nested && typeof nested['message'] === 'string' ? nested['message'] : undefined) ??
    code
  return { code, message }
}

/**
 * 创建给 pi 用的 fetch：签名 + 头 + 错误归一化。
 * `init.signal` 原样透传，pi 取消请求时上游连接一起断。
 */
export const createSignedFetch = (
  credentials: CodeArtsCredentials,
  log: (line: string) => void = () => {},
  fetchImpl: typeof fetch = fetch,
): FetchLike => {
  const sessionId = sessionIdOf(credentials.accessKey)
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw)
    // pi 会请求 {baseUrl}/chat/completions；码道的对话端点在 /api/v2/chat/completions
    url.pathname = url.pathname.replace(/\/v\d*\/chat\/completions$/, CODEARTS_CHAT_PATH)

    const method = (init?.method ?? 'POST').toUpperCase()
    let body: string | undefined
    if (typeof init?.body === 'string') {
      body = JSON.stringify(normalizeRequestBody(JSON.parse(init.body)))
    }

    const signed = signRequest({
      method,
      url,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body }),
      credentials,
    })
    const trace = traceId()
    // 参与签名的头只有 Content-Type；其余头不参与签名（网关只校验 SignedHeaders 里列出的）
    const headers: Record<string, string> = {
      ...signed.headers,
      Accept: 'text/event-stream',
      'Agent-Type': 'PromptCenter',
      'X-Language': 'zh-cn',
      lang: 'zh-cn',
      'Chat-Id': trace,
      'Session-Id': traceId(),
      'user-session-id': sessionId,
      'user-msg-id': `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      // 与官方 CLI 一致的协议层特征；网关对 UA 无强校验
      'User-Agent': 'ai-sdk/provider-utils/4.0.21 runtime/node/24',
    }

    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'error',
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const detail = parseHuaweiError(text, response.status)
      log(`upstream http ${response.status}: ${detail.code} ${detail.message}`)
      const hint = hintFor(detail.code, detail.message)
      const payload = JSON.stringify({
        error: {
          message: `码道 ${detail.code}: ${detail.message}${hint === undefined ? '' : `\n→ ${hint}`}`,
          type: 'api_error',
          code: detail.code,
        },
      })
      return new Response(payload, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      })
    }

    if (response.body === null) return response
    return new Response(pipeInlineErrors(response.body, log), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
