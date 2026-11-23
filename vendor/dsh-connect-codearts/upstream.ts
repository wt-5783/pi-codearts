/**
 * 码道网关客户端：签名、请求、SSE 解密、错误分类。
 *
 * 参考：dsh-huaweicloud-connect（MIT, Alanine-孔硕）`lib/drivers/codearts.js` —
 *       `signedFetch` 的「参与签名的头 / 签后追加的头」两组分离写法、
 *       `inspectStreamHead` 的首帧嗅探、`throughGate` 的串行闸门理由、
 *       `summarizeError` 的逐类中文建议。
 * 参考：dsh-connect-madao（MIT, XLNC-L）`src/client.ts` — 端点常量、身份头、
 *       `getJson`/`postJson` 的只读/元数据分法、`user-session-id` 复用理由。
 * 改动：① **不做 SM4-GCM 传输加密**。M0 实测明文 JSON + 签名直接 200，
 *       12 个模型、工具、图片、非流式全部正常。参考实现里的 ECDH 密钥协商
 *       与手写 SM4（400+ 行）整个删掉，这也是本项目最大的一处瘦身。
 *       ② **不签 `maas_type: benefit`**，也不读客户端登录态。参考实现要区分
 *       STS 与 AK/SK 两种模式来决定签不签，我们只有 AK/SK 一条路，直接不签
 *       —— M0 四方对照证明只有「AK/SK + 不签 benefit」能正常返回正文。
 *       ③ **不伪造 `client-ip`**。两个参考实现都把它写死成内网地址
 *       `198.18.0.1`，属于伪装客户端身份，本项目不做。
 *       ④ 串行闸门保留但默认不启用（`serialize: false`）。理由见
 *       `requestGate` 的注释：它是给「多账号共享同一配额」场景用的，单账号
 *       下只会白白增加延迟。
 *
 * @module dsh-connect-codearts/upstream
 */
import { randomUUID } from 'node:crypto'
import type { CodeArtsCredentials } from './protocol/sign.ts'
import { signRequest } from './protocol/sign.ts'
import {
  CODEARTS_CHAT_PATH,
  CODEARTS_CURRENT_USER_PATH,
  CODEARTS_GATEWAY,
  CODEARTS_MEMBER_ROLES_PATH,
  CODEARTS_MODELS_PATH,
  CODEARTS_OPS_CLAIM_PATH,
  CODEARTS_OPS_DELIVERY_PATH,
  CODEARTS_STATISTICS_PATH,
  CODEARTS_THINKING_VARIANTS_PATH,
} from './protocol/types.ts'
import type { UpstreamChatBody, UpstreamMessage } from './protocol/body.ts'
import { CODEARTS_MAX_CHAT_BODY_BYTES, serializeChatBody } from './protocol/body.ts'
import type { ParsedChunk, SseEvent } from './protocol/sse.ts'
import { parseChunk, parseSseEvents } from './protocol/sse.ts'
import type { ClassifiedError } from './protocol/errors.ts'
import { classifyBusinessRejection, classifyError, classifyTransportError, parseErrorDetail } from './protocol/errors.ts'

/** 一次对话调用的结果。 */
export interface ChatResult {
  readonly ok: true
  readonly frames: readonly ParsedChunk[]
}

export interface ChatFailure {
  readonly ok: false
  readonly error: ClassifiedError
  readonly status?: number
}

export type ChatOutcome = ChatResult | ChatFailure

export interface ModelCatalogEntry {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly supportsImages: boolean
  readonly description?: string
  /** 积分倍率展示串，例如 `0.18x`。解析不出就不带这个字段，不虚构。 */
  readonly ratioDisplay?: string
  /** 每百万 token 的人民币价格，来自 `credit[0]`。 */
  readonly pricing?: ModelPricing
  /** 该模型声明的思考档位；空数组表示没有声明。 */
  readonly strengths: readonly string[]
  readonly defaultStrength?: string
}

export interface ModelPricing {
  readonly inputPrice?: string
  readonly cachePrice?: string
  readonly outputPrice?: string
}

export interface CreditInfo {
  readonly total?: number
  readonly used?: number
  readonly remain?: number
  readonly expiringAmount?: number
  readonly basic?: number
  readonly bonus?: number
  readonly onDemand?: number
  readonly totalTokens?: number
}

export interface AccountInfo {
  readonly domainId?: string
  readonly domainName?: string
  readonly userId?: string
  readonly userName?: string
  readonly roles: readonly string[]
}

export interface WelfareItem {
  readonly campaignId: number
  readonly title: string
  readonly type?: string
  readonly status?: string
  readonly claimable: boolean
  readonly benefitAmount?: number
  readonly benefitUnit?: string
  readonly expireAt?: string
}

export interface UpstreamClientOptions {
  readonly gateway?: string | undefined
  /** 串行化请求。多账号共享配额时打开能减少碰撞，单账号保持关闭。 */
  readonly serialize?: boolean | undefined
  /** 注入 fetch，便于单测。 */
  readonly fetchImpl?: typeof fetch | undefined
  /** 日志回调，落盘由调用方决定。 */
  readonly log?: ((line: string) => void) | undefined
}

/** 稳定的会话 id：网关按它计会话数，每请求换新会被算成新会话。 */
const sessionIdOf = (accessKey: string): string => {
  // 只用 AK 的后 12 位做派生，不引入哈希依赖，也不泄露完整 AK。
  const tail = accessKey.slice(-12).replace(/[^A-Za-z0-9]/g, '')
  return `dsh-codearts-${tail === '' ? 'default' : tail}`
}

const traceId = (): string => randomUUID().replace(/-/g, '')

export class CodeArtsUpstreamClient {
  readonly #gateway: string
  readonly #fetch: typeof fetch
  readonly #log: (line: string) => void
  readonly #serialize: boolean
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: UpstreamClientOptions = {}) {
    const gateway = new URL(options.gateway ?? CODEARTS_GATEWAY)
    if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash) {
      throw new Error('码道网关必须是 HTTPS 地址，且不能包含凭据、查询参数或片段。')
    }
    this.#gateway = gateway.href.replace(/\/+$/, '')
    this.#fetch = options.fetchImpl ?? fetch
    this.#log = options.log ?? (() => {})
    this.#serialize = options.serialize ?? false
  }

  get gateway(): string {
    return this.#gateway
  }

  /**
   * 串行闸门。
   *
   * 参考实现把「同一时刻只能有一个请求在飞」当作 `TM.00001041` 的解药，但它们
   * 自己的注释又承认实测反证（串行单请求照样触发）。M0 在本机打了数十个请求
   * 也从未触发限流，所以这里默认关闭。
   *
   * 仍保留实现的原因只有一个：作者将来加账号池时，多个账号共享同一份配额，
   * 排队能让「第一个请求的限流立刻可见」，而不是三个请求同时撞墙一起触发
   * 模型熔断。
   */
  async #throughGate<T>(task: () => Promise<T>): Promise<T> {
    if (!this.#serialize) return task()
    const run = this.#queue.then(task, task)
    // 队列尾吞掉错误，否则一次失败会让后续所有请求都跟着 reject。
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 发一个签名请求，返回原始 Response。
   *
   * **签名的头与实际发出去的头必须一一对应**：`SignedHeaders` 里列出的每个
   * 头都会被服务端重新拼进规范化请求。所以这里把「参与签名的头」与「签后
   * 追加的头」分成两组，追加的那组服务端不校验（它不在 SignedHeaders 里）。
   */
  async #signedFetch(options: {
    readonly path: string
    readonly method: string
    readonly query?: Record<string, string> | undefined
    readonly body?: string | undefined
    readonly credentials: CodeArtsCredentials
    readonly signHeaders?: Record<string, string> | undefined
    readonly postHeaders?: Record<string, string> | undefined
    readonly signal?: AbortSignal | undefined
  }): Promise<Response> {
    const url = new URL(`${this.#gateway}${options.path}`)
    if (options.query !== undefined) {
      for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value)
    }

    const signed = signRequest({
      method: options.method,
      url,
      headers: options.signHeaders ?? { 'Content-Type': 'application/json' },
      ...(options.body === undefined ? {} : { body: options.body }),
      credentials: options.credentials,
    })

    const headers: Record<string, string> = { ...signed.headers, ...(options.postHeaders ?? {}) }

    return this.#fetch(url, {
      method: options.method,
      redirect: 'error',
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }

  /** GET 一个只读 JSON 接口。失败时携带业务码和提示。 */
  async #getJson(
    credentials: CodeArtsCredentials,
    path: string,
    options: {
      readonly query?: Record<string, string> | undefined
      readonly agentType?: string | undefined
      readonly signal?: AbortSignal | undefined
    } = {},
  ): Promise<unknown> {
    let response: Response
    try {
      response = await this.#signedFetch({
        path,
        method: 'GET',
        ...(options.query === undefined ? {} : { query: options.query }),
        credentials,
        signHeaders: { 'Content-Type': 'application/json' },
        postHeaders: {
          Accept: 'application/json',
          // `Agent-Type` 不参与签名：网关只校验 SignedHeaders 里列出的头，
          // 把不参与签名的头混进签名会让两边对不上。
          ...(options.agentType === undefined ? {} : { 'Agent-Type': options.agentType }),
          'X-Language': 'zh-cn',
          lang: 'zh-cn',
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      throw requestError(classifyTransportError(error))
    }

    const text = await response.text()
    if (!response.ok) throw requestError(classifyError(response.status, text))
    if (text.trim() === '') return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('码道网关未返回有效的 JSON。')
    }
  }

  /**
   * 模型目录。
   *
   * `GET /v1/model/builtin` 需要 `Agent-Type: PromptCenter`，缺了会被网关拒。
   * 返回的 `context_window` 与 `max_tokens` 是**网关直出**，本项目不需要
   * 内置快照表（参考实现都要，那是因为它们走 STS 看不到完整字段）。
   */
  async listModels(credentials: CodeArtsCredentials, signal?: AbortSignal): Promise<readonly ModelCatalogEntry[]> {
    const payload = await this.#getJson(credentials, CODEARTS_MODELS_PATH, {
      agentType: 'PromptCenter',
      ...(signal === undefined ? {} : { signal }),
    })
    const record = asRecord(payload)
    const code = record?.['code']
    if (record?.['error_code'] || record?.['error'] || (code !== undefined && code !== null && code !== 0 && code !== '0')) {
      throw requestError(classifyError(200, JSON.stringify(payload)))
    }
    const builtinModels = record?.['builtinModels']
    if (!Array.isArray(builtinModels)) throw new Error('码道目录响应缺少 builtinModels 数组。')
    const entries: ModelCatalogEntry[] = []
    for (const raw of builtinModels) {
      const model = asRecord(raw)
      if (model === undefined || readString(model, 'model_id') === undefined) {
        throw new Error('码道目录响应包含缺少 model_id 的条目。')
      }
      const entry = toCatalogEntry(model)
      if (entry !== undefined) entries.push(entry)
    }
    return entries
  }

  /** 每个模型声明的思考档位。失败不抛 —— 档位是附加能力，拿不到就当没有。 */
  async thinkingVariants(
    credentials: CodeArtsCredentials,
    modelIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, { strengths: readonly string[]; defaultStrength?: string }>> {
    const result = new Map<string, { strengths: readonly string[]; defaultStrength?: string }>()
    if (modelIds.length === 0) return result

    const body = JSON.stringify({ model_names: [...modelIds] })
    try {
      const response = await this.#signedFetch({
        path: CODEARTS_THINKING_VARIANTS_PATH,
        method: 'POST',
        body,
        credentials,
        signHeaders: { 'Content-Type': 'application/json' },
        postHeaders: {
          Accept: 'application/json',
          'Agent-Type': 'PromptCenter',
          'X-Language': 'zh-cn',
        },
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) return result
      const parsed: unknown = await response.json()
      const variants = readRecord(parsed, 'variants')
      if (variants === undefined) return result
      for (const [modelId, value] of Object.entries(variants)) {
        const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
        const strengths = Array.isArray(record['strengths'])
          ? record['strengths'].filter((item): item is string => typeof item === 'string')
          : []
        const defaultStrength = record['default_strength']
        result.set(modelId, {
          strengths,
          ...(typeof defaultStrength === 'string' && defaultStrength !== ''
            ? { defaultStrength }
            : {}),
        })
      }
    } catch {
      /* 附加能力，静默忽略 */
    }
    return result
  }

  /** 当前账号身份。这是网关能给的唯一身份信息，没有昵称/邮箱/手机号。 */
  async currentUser(credentials: CodeArtsCredentials, signal?: AbortSignal): Promise<AccountInfo> {
    const payload = await this.#getJson(credentials, CODEARTS_CURRENT_USER_PATH, {
      ...(signal === undefined ? {} : { signal }),
    })
    const record = asRecord(payload)
    const info: { -readonly [K in keyof AccountInfo]: AccountInfo[K] } = { roles: [] }
    const domainId = record?.['domain_id']
    if (typeof domainId === 'string') info.domainId = domainId
    const domainName = record?.['domain_name']
    if (typeof domainName === 'string') info.domainName = domainName
    const userId = record?.['user_id']
    if (typeof userId === 'string') info.userId = userId
    const userName = record?.['user_name']
    if (typeof userName === 'string') info.userName = userName
    return info
  }

  /** 企业/团队角色，纯展示。拿不到就当空数组，不影响主流程。 */
  async memberRoles(credentials: CodeArtsCredentials, signal?: AbortSignal): Promise<readonly string[]> {
    try {
      const payload = await this.#getJson(credentials, CODEARTS_MEMBER_ROLES_PATH, {
        ...(signal === undefined ? {} : { signal }),
      })
      const record = asRecord(payload)
      const roles: string[] = []
      for (const key of ['enterprise_roles', 'team_roles']) {
        const value = record?.[key]
        if (Array.isArray(value)) {
          for (const item of value) if (typeof item === 'string') roles.push(item)
        }
      }
      return roles
    } catch {
      return []
    }
  }

  /**
   * 积分。
   *
   * **余额只取 `usageTotalPackageCredit.package_credit_remain`，绝不累加
   * 基础/按需/赠送分项** —— 它们是总额的构成项，相加会重复计算。M0 实测：
   * 总额 700 = 基础 500 + 赠送 200 + 按需 0。
   */
  async credit(credentials: CodeArtsCredentials, signal?: AbortSignal): Promise<CreditInfo | undefined> {
    const payload = await this.#getJson(credentials, CODEARTS_STATISTICS_PATH, {
      agentType: 'PromptCenter',
      ...(signal === undefined ? {} : { signal }),
    })
    const metrics = readArray(payload, 'metrics')
    const pick = (name: string): Record<string, unknown> | undefined => {
      for (const item of metrics) {
        const record = asRecord(item)
        if (record?.['name'] === name) {
          const nested = asRecord(record['value'])
          return nested ?? record
        }
      }
      return undefined
    }

    const total = pick('usageTotalPackageCredit')
    if (total === undefined) return undefined

    const readNumberField = (record: Record<string, unknown> | undefined, key: string): number | undefined => {
      const value = record?.[key]
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    const amount = readNumberField(total, 'package_credit_amount')
    const used = readNumberField(total, 'package_credit_used')
    const remain = readNumberField(total, 'package_credit_remain')
    const info: { -readonly [K in keyof CreditInfo]: CreditInfo[K] } = {
      ...(amount === undefined ? {} : { total: amount }),
      ...(used === undefined ? {} : { used }),
      ...(remain === undefined ? {} : { remain }),
    }
    const expiring = readNumberField(total, 'package_credit_expiring_amount')
    if (expiring !== undefined) info.expiringAmount = expiring

    const basic = pick('usageBasicPackageCredit')
    const bonus = pick('usageBonusPackageCredit')
    const onDemand = pick('usageOnDemandPackageCredit')
    const basicRemain = readNumberField(basic, 'package_credit_remain')
    if (basicRemain !== undefined) info.basic = basicRemain
    const bonusRemain = readNumberField(bonus, 'package_credit_remain')
    if (bonusRemain !== undefined) info.bonus = bonusRemain
    const onDemandRemain = readNumberField(onDemand, 'package_credit_remain')
    if (onDemandRemain !== undefined) info.onDemand = onDemandRemain

    const tokenUsage = pick('usageTokenChatMessages')
    const tokens = readNumberField(tokenUsage, 'usage_token_num')
    if (tokens !== undefined) info.totalTokens = tokens

    return info
  }

  /**
   * 福利/签到活动列表。
   *
   * 这条请求带 query，是本项目唯一暴露「CanonicalQueryString 必须参与签名」
   * 的端点。参考实现把 query 硬编码成空，所以在它们那儿这个端点恒定 401。
   */
  async welfareItems(
    credentials: CodeArtsCredentials,
    channel = 'IDE',
    signal?: AbortSignal,
  ): Promise<readonly WelfareItem[]> {
    const payload = await this.#getJson(credentials, CODEARTS_OPS_DELIVERY_PATH, {
      query: { channel },
      agentType: 'PromptCenter',
      ...(signal === undefined ? {} : { signal }),
    })
    const record = asRecord(payload)
    const code = record?.['code']
    if (record?.['error_code'] || record?.['error'] || (code !== undefined && code !== null && code !== 0 && code !== '0')) {
      throw requestError(classifyError(200, JSON.stringify(payload)))
    }
    const items = readRecord(record, 'data')?.['items']
    if (!Array.isArray(items)) throw new Error('码道福利响应缺少 items 数组。')
    const result: WelfareItem[] = []
    for (const raw of items) {
      const record = asRecord(raw)
      if (record === undefined) continue
      const campaignId = record['campaignId']
      if (typeof campaignId !== 'number') continue
      const item: { -readonly [K in keyof WelfareItem]: WelfareItem[K] } = {
        campaignId,
        title: typeof record['title'] === 'string' ? record['title'] : `活动 ${campaignId}`,
        claimable: record['claimable'] === true,
      }
      if (typeof record['type'] === 'string') item.type = record['type']
      if (typeof record['status'] === 'string') item.status = record['status']
      if (typeof record['benefitAmount'] === 'number') item.benefitAmount = record['benefitAmount']
      if (typeof record['benefitUnit'] === 'string') item.benefitUnit = record['benefitUnit']
      if (typeof record['expireAt'] === 'string') item.expireAt = record['expireAt']
      result.push(item)
    }
    return result
  }

  /**
   * 领取某个活动。
   *
   * 只在用户**显式点击**时调用。签到一天一次，绝不因为「打开了面板」就替用户
   * 点掉 —— 参考实现也把这条写进了注释，是同一个产品判断。
   */
  async claimWelfare(
    credentials: CodeArtsCredentials,
    campaignId: number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: ClassifiedError }> {
    const body = JSON.stringify({
      campaignId,
      // 幂等键：同一 campaignId 重复点不会重复领，但换 uuid 能覆盖用户重试。
      idempotentKey: `${campaignId}-${randomUUID()}`,
      channel: 'IDE',
    })
    try {
      const response = await this.#signedFetch({
        path: CODEARTS_OPS_CLAIM_PATH,
        method: 'POST',
        body,
        credentials,
        signHeaders: { 'Content-Type': 'application/json' },
        postHeaders: { Accept: 'application/json', 'Agent-Type': 'PromptCenter', 'X-Language': 'zh-cn' },
        ...(signal === undefined ? {} : { signal }),
      })
      const text = await response.text()
      if (!response.ok) return { ok: false, error: classifyError(response.status, text) }
      const parsed: unknown = text.trim() === '' ? undefined : JSON.parse(text)
      const record = asRecord(parsed)
      const code = record?.['code']
      if (code === undefined || code === 0) return { ok: true }
      // 业务码非 0：请求成功了但这件事件不能做（今天已签到、活动过期…）。
      // 以前这里直接 `return {ok:false}` 把整个响应体丢掉，界面只能显示
      // 「领取失败，原因未知」—— 用户完全看不出是「已经领过了」。
      return { ok: false, error: classifyBusinessRejection(text) }
    } catch (error) {
      return { ok: false, error: classifyTransportError(error) }
    }
  }

  /**
   * 流式对话。
   *
   * 三个关键点：
   *   1. **首帧嗅探**：网关会用 HTTP 200 返回内联错误。不拆首帧就会把真实
   *      原因（角色非法、参数非法）伪装成「流意外结束」。
   *   2. **增量累加**：M0 实测 delta 是拼接语义（非前缀替换），所以这里
   *      直接按到达顺序 yield，不需要去重。调用方负责累加。
   *   3. **不自带重试**：重试由 adapter 依据 `ClassifiedError.retryable` 决定，
   *      客户端只做一次尝试。这样「重试几次」的可见性留在上层。
   */
  async *chatStream(
    credentials: CodeArtsCredentials,
    body: UpstreamChatBody,
    options: { readonly signal?: AbortSignal | undefined; readonly previewMessageIndexes?: readonly number[] } = {},
  ): AsyncGenerator<ParsedChunk, ChatOutcome, void> {
    const serialized = serializeChatBody(body, options.previewMessageIndexes ?? [])
    if (!serialized.ok) {
      const message = `码道请求体为 ${serialized.bytes} 字节，超过插件的 ${CODEARTS_MAX_CHAT_BODY_BYTES} 字节上限。请压缩上下文，或减少当前输入的图片。`
      return {
        ok: false,
        error: { kind: 'bad_request', code: 'CODEARTS_REQUEST_BODY_TOO_LARGE', message, hint: message, retryable: false },
      }
    }
    const sessionId = sessionIdOf(credentials.accessKey)

    let response: Response
    try {
      response = await this.#throughGate(() => this.#signedFetch({
        path: CODEARTS_CHAT_PATH,
        method: 'POST',
        body: serialized.text,
        credentials,
        signHeaders: { 'Content-Type': 'application/json' },
        postHeaders: {
          Accept: 'text/event-stream',
          'Agent-Type': 'PromptCenter',
          'X-Language': 'zh-cn',
          lang: 'zh-cn',
          'Chat-Id': traceId(),
          'Session-Id': traceId(),
          'user-session-id': sessionId,
          'user-msg-id': `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          // 沿用官方 CLI 的 UA：这不伪装第三方产品，只是保持与官方客户端一致的
          // 协议层特征。网关对 UA 无强校验，M0 换成本项目自述 UA 也能通。
          'User-Agent': 'ai-sdk/provider-utils/4.0.21 runtime/node/24',
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }))
    } catch (error) {
      if (options.signal?.aborted) throw error
      return { ok: false, error: classifyTransportError(error) }
    }

    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '')
      return chatFailure(response.status, text, serialized.bytes)
    }

    let sawValidFrame = false
    let sawFinish = false

    try {
      for await (const event of streamEvents(response.body)) {
        if (event.kind === 'done') {
          sawFinish = true
          break
        }
        if (event.kind !== 'data') continue

        const parsed = parseChunk(event.payload)
        if (parsed.inlineError !== undefined) {
          const { code, message } = parsed.inlineError
          const failure = chatFailure(200, JSON.stringify({ error_code: code, error_msg: message }), serialized.bytes)
          this.#log(`upstream inline error: ${failure.error.code}`)
          return failure
        }

        const { delta, usage } = parsed
        const terminal = delta?.finishReason !== undefined && delta.finishReason !== null
        if (terminal) sawFinish = true
        const hasOutput = Boolean(terminal || delta?.content || delta?.reasoning || delta?.toolCalls?.length)
        sawValidFrame ||= hasOutput
        if (hasOutput || usage !== undefined) yield parsed
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      return { ok: false, error: classifyTransportError(error) }
    }

    if (!sawValidFrame) {
      return {
        ok: false,
        error: {
          kind: 'unknown',
          code: 'EMPTY_STREAM',
          message: 'upstream returned no usable frames',
          retryable: true,
          retryAfterMs: 2_000,
          hint: '码道未返回有效内容。请重试，或检查输出预算是否足够。',
        },
      }
    }

    if (!sawFinish) {
      return {
        ok: false,
        error: {
          kind: 'transport',
          code: 'INCOMPLETE_STREAM',
          message: 'upstream closed the stream before its terminal frame',
          retryable: true,
          hint: '码道在回复完成前断开了连接，请重试。',
        },
      }
    }

    return { ok: true, frames: [] }
  }
}

const chatFailure = (status: number, text: string, bytes: number): ChatFailure => {
  const error = classifyError(status, text)
  const transportStatus = status >= 400 ? { status } : {}
  if (error.kind !== 'bad_request') return { ok: false, error, ...transportStatus }

  const detail = parseErrorDetail(text)
  const message = detail.message.trim()
  // Gateway HTML, multiline diagnostics and echoed payloads are not suitable
  // for the session log. Retain short structured parameter errors.
  const usableDetail = detail.code !== '' && message !== detail.code && message.length <= 240 &&
    !/[\r\n<>{}]|authorization|sdk-hmac|api[-_ ]?key|secret|bearer|data:|[\w+/=.-]{40,}/i.test(message)
  const hint = `${error.hint} 请求体：${bytes} 字节。${usableDetail && message !== '' ? ` 网关详情：${message}` : ''}`
  return { ok: false, error: { ...error, hint }, ...transportStatus }
}

const requestError = (failure: ClassifiedError): Error =>
  new Error(`${failure.code}: ${failure.hint}`, { cause: failure })

/** 逐段分帧，保留跨读取的半帧。提前退出时同时取消上游响应体。 */
async function* streamEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let ended = false
  try {
    while (!ended) {
      const next = await reader.read()
      ended = next.done
      buffer += ended ? decoder.decode() : decoder.decode(next.value, { stream: true })
      // 末尾的 CR 可能与下一段开头的 LF 组成同一个换行。
      const trailingCR = !ended && buffer.endsWith('\r')
      const complete = trailingCR ? buffer.slice(0, -1) : buffer
      const normalized = complete.replace(/\r\n?/g, '\n')
      const boundary = normalized.lastIndexOf('\n\n')
      if (boundary < 0 && !ended) {
        buffer = normalized + (trailingCR ? '\r' : '')
        continue
      }

      const completeEvents = ended ? normalized : normalized.slice(0, boundary + 2)
      buffer = ended ? '' : normalized.slice(boundary + 2) + (trailingCR ? '\r' : '')
      yield* parseSseEvents(completeEvents)
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/* ------------------------------ 解析辅助 ------------------------------ */

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const readRecord = (value: unknown, key: string): Record<string, unknown> | undefined =>
  asRecord(asRecord(value)?.[key])

const readArray = (value: unknown, key: string): readonly unknown[] => {
  const candidate = asRecord(value)?.[key]
  return Array.isArray(candidate) ? candidate : []
}

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

const readNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把上游一个模型条目转成本项目的形状。
 *
 * `credit` 是**数组**：按输入长度阶梯计价时会有多档（`openpangu-2.0-pro`
 * 就有 0–32000 与 32001+ 两档）。这里只取第一档做展示，因为：
 * ① 绝大多数模型只有一档；② 倍率是给人看的量级参考，不需要精确。
 * `pricing` 保留首档的三项单价，供诊断页展示。
 */
const toCatalogEntry = (value: unknown): ModelCatalogEntry | undefined => {
  const record = asRecord(value)
  if (record === undefined) return undefined

  const id = readString(record, 'model_id')
  if (id === undefined) return undefined
  // 目录里 `enable` 为 false 的模型该账号调不动，直接不进选项列表。
  if (record['enable'] === false) return undefined

  const name = readString(record, 'model_name') ?? id
  const contextWindow = readNumber(record, 'context_window') ?? 0
  const maxTokens = readNumber(record, 'max_tokens') ?? 0

  const credit = Array.isArray(record['credit']) ? asRecord(record['credit'][0]) : undefined
  const ratioDisplay = credit === undefined ? undefined : readString(credit, 'ratio_display')

  let pricing: ModelPricing | undefined
  if (credit !== undefined) {
    const inputPrice = readString(credit, 'input_price')
    const cachePrice = readString(credit, 'cache_price')
    const outputPrice = readString(credit, 'output_price')
    if (inputPrice !== undefined || cachePrice !== undefined || outputPrice !== undefined) {
      pricing = {
        ...(inputPrice === undefined ? {} : { inputPrice }),
        ...(cachePrice === undefined ? {} : { cachePrice }),
        ...(outputPrice === undefined ? {} : { outputPrice }),
      }
    }
  }

  const description = readString(record, 'model_desc')

  return {
    id,
    name,
    contextWindow,
    maxTokens,
    supportsImages: record['supports_images'] === true,
    ...(description === undefined ? {} : { description }),
    ...(ratioDisplay === undefined ? {} : { ratioDisplay }),
    ...(pricing === undefined ? {} : { pricing }),
    strengths: [],
  }
}

/** 上游消息 → 请求体消息。`developer → system` 的改写在这里生效。 */
export const toUpstreamMessage = (
  role: string,
  content: UpstreamMessage['content'],
  extra: { toolCallId?: string; toolCalls?: UpstreamMessage['tool_calls'] } = {},
): UpstreamMessage => ({
  role: role === 'developer' ? 'system' : (role as UpstreamMessage['role']),
  content,
  ...(extra.toolCallId === undefined ? {} : { tool_call_id: extra.toolCallId }),
  ...(extra.toolCalls === undefined ? {} : { tool_calls: extra.toolCalls }),
})
