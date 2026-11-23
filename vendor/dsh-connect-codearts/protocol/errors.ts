/**
 * 码道网关的错误分类与中文可执行建议。
 *
 * 参考：dsh-huaweicloud-connect（MIT, Alanine-孔硕）`lib/drivers/codearts.js`
 *       的 `summarizeError` / `isQuotaThrottle` / `isEntitlementProblem` ——
 *       「把上游码翻译成用户能照着做的下一步」这一整个思路，以及
 *       `TM.00001041` 不是并发上限而是网关限流的实测结论。
 * 改动：① 错误码→文案全部换成 M0 在本机实测到的码，删掉了参考实现里在
 *       IAM AK/SK 链路下不会出现的 benefit 通道分支（保留一条也认，避免旧
 *       凭据模式下文案消失）；
 *       ② 增加 `APIG.0301` 的「先查 query 签名」提示 —— 这是本项目唯一踩到
 *       的签名坑，参考实现里也有一份同样的 bug；
 *       ③ 分类结果直接给出 `retryable`，让重试策略由分类决定而不是另写一张表。
 *
 * @module dsh-connect-codearts/protocol/errors
 */

/** 上游错误的大类。决定重试策略与界面呈现位置。 */
export type UpstreamErrorKind =
  /** 签名不对（AK/SK 错、query 没签名、时钟偏差过大） */
  | 'signature'
  /** 凭据过期或缺失 */
  | 'credential'
  /** 账号没有该模型的权益 */
  | 'entitlement'
  /** 模型不存在或该账号调不动 */
  | 'unsupported_model'
  /** 请求参数非法（max_tokens 超限、角色不对、被禁字段） */
  | 'bad_request'
  /** 速率/节奏限流，值得退避重试 */
  | 'rate_limited'
  /** 网关侧故障 */
  | 'server'
  /** 网络/传输层 */
  | 'transport'
  /** 业务侧拒绝但不是错误（重复领取、活动已结束、未达条件） */
  | 'rejected'
  /** 无法归类 */
  | 'unknown'

export interface ClassifiedError {
  readonly kind: UpstreamErrorKind
  readonly code: string
  readonly message: string
  /** 给用户看的完整中文说明：发生了什么 + 为什么 + 下一步怎么做。 */
  readonly hint: string
  /** 是否值得自动重试。 */
  readonly retryable: boolean
  /** 建议的退避起点（毫秒）。仅 `retryable` 时有意义。 */
  readonly retryAfterMs?: number
}

/** 从上游响应体里抠出业务码与文案。 */
export interface UpstreamErrorDetail {
  readonly code: string
  readonly message: string
}

/**
 * 尽力从任意响应体文本里提取错误码。
 *
 * 上游三种形态都出现过：
 *   `{"error_code":"APIG.0301","error_msg":"..."}`
 *   `{"error":{"code":"...","message":"..."}}`
 *   `{"code":"PROMPTCENTER.00000001","message":"channel : 参数无效"}`
 */
export const parseErrorDetail = (text: string): UpstreamErrorDetail => {
  const trimmed = text.trim()
  if (trimmed === '') return { code: '', message: '' }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const flatCode = record['error_code']
      if (typeof flatCode === 'string' && flatCode !== '') {
        const message = record['error_msg']
        return { code: flatCode, message: typeof message === 'string' ? message : flatCode }
      }
      const nested = record['error']
      if (typeof nested === 'object' && nested !== null) {
        const nestedRecord = nested as Record<string, unknown>
        const code = nestedRecord['code']
        if (typeof code === 'string' && code !== '') {
          const message = nestedRecord['message']
          return { code, message: typeof message === 'string' ? message : code }
        }
      }
      const code = record['code']
      // 业务码两种形态都出现过：字符串（`PROMPTCENTER.00000001`）与**数字**
      // （`{"code":40001,"message":"尚未到达权益刷新时间"}`）。早期只认字符串，
      // 数字码的响应体会整条掉进下面的纯文本兜底 —— 结果 message 变成了
      // 一整串原始 JSON，用户看到的是 `上游拒绝了这次操作：{"code":40001,...}`
      // 这种把内层 JSON 又嵌一层的荒唐输出。
      if (typeof code === 'string' && code !== '' && code !== '0') {
        const message = record['message']
        return { code, message: typeof message === 'string' ? message : code }
      }
      if (typeof code === 'number' && code !== 0) {
        const message = record['message']
        return { code: String(code), message: typeof message === 'string' ? message : String(code) }
      }
    }
  } catch {
    /* 非 JSON，走下面的文本兜底 */
  }

  // 纯文本错误（网关偶尔直接回一行中文）。
  const firstLine = trimmed.split('\n')[0] ?? ''
  return { code: '', message: firstLine.slice(0, 500) }
}

/**
 * 把「HTTP 200 但业务码说不行」归类。
 *
 * 和 `classifyError` 分开是因为语义完全不同：那个函数看的是「请求失败了」，
 * 这个看的是「请求成功了，但服务端说这件事不能做」。混在一起会让
 * `!response.ok` 之外的路径被迫借用错误的 hint。
 *
 * 真实场景（本机实测）：今天已经签到过，再 POST `/v1/ops/claim` 会得到
 * HTTP 200 + 业务码非 0。修这个之前那条路径直接丢掉整个响应体，
 * 界面只显示「领取失败，原因未知」—— 用户今天再点一次签到就是这句话，
 * 等于什么都没说，还会以为是插件坏了。
 */
export const classifyBusinessRejection = (text: string): ClassifiedError => {
  const detail = parseErrorDetail(text)
  const haystack = `${detail.code} ${detail.message}`

  // 3. 权益还没刷新到账。本机实测原文：`{"code":40001,"message":"尚未到达权益
  // 刷新时间，暂时无法领取"}`。这既不是「已经领过」也不是「永久不行」——
  // 它是「再等等」。归到 rejected 里的 wait 分支，别让用户以为活动坏了。
  if (matches(haystack, /尚未到达|刷新时间|稍后再试|请稍后|暂未开放/i)) {
    return {
      kind: 'rejected',
      code: detail.code || 'BENEFIT_NOT_REFRESHED',
      message: detail.message,
      retryable: false,
      hint: `码道还没把这次权益刷新到账（原文：${detail.message || '尚未到达刷新时间'}）。\n等一会儿再点一次就行，不是插件的问题。`,
    }
  }

  // 已经领过 / 今天领过。这是最常撞到的一条，得给出「不用再点」的结论
  // 而不是「失败了」。
  if (matches(haystack, /重复|已领取|已签到|已经领|already|claimed|重复领取/i)) {
    return {
      kind: 'rejected',
      code: detail.code || 'ALREADY_CLAIMED',
      message: detail.message,
      retryable: false,
      hint: '这个活动今天已经领过了，不用再点。签到一天一次，明天再来。',
    }
  }

  // 活动没开始 / 已结束 / 条件未满足。
  if (matches(haystack, /未开始|已结束|过期|失效|未达成|不满足|不符合|条件/i)) {
    return {
      kind: 'rejected',
      code: detail.code || 'CAMPAIGN_NOT_AVAILABLE',
      message: detail.message,
      retryable: false,
      hint: `这个活动当前不可领取（${detail.message || '上游没有给具体原因'}）。\n不是插件的问题，去码道控制台看看活动规则。`,
    }
  }

  // 认不出来的业务码：至少把原文透出来，不要吞掉。
  return {
    kind: 'rejected',
    code: detail.code || 'BUSINESS_REJECTED',
    message: detail.message,
    retryable: false,
    hint: `上游拒绝了这次操作${detail.message === '' ? '' : `：${detail.message}`}\n${
      detail.code === '' ? '' : `（业务码 ${detail.code}）\n`
    }如果反复出现，把这条原文报到 issue。`,
  }
}

const matches = (haystack: string, pattern: RegExp): boolean => pattern.test(haystack)

/**
 * 把 HTTP 状态码 + 响应体文本分类成带建议的结构。
 *
 * 分类顺序有讲究：先判最具体的业务码，再判状态码。例如 `TM.00001041`
 * 是 HTTP 400，但它是限流而不是参数错误，先判业务码才能归对类。
 */
export const classifyError = (status: number, text: string): ClassifiedError => {
  const detail = parseErrorDetail(text)
  const haystack = `${detail.code} ${detail.message}`

  // 1. 签名问题。本项目唯一踩到的签名坑是 query 没参与签名。
  if (matches(haystack, /APIG\.0301|signature fail|Incorrect IAM authentication/i)) {
    return {
      kind: 'signature',
      code: detail.code || 'APIG.0301',
      message: detail.message,
      retryable: false,
      hint:
        '签名校验没通过。常见原因有三种：\n' +
        '① AK/SK 填错或已被删除（去华为云控制台「我的凭证 → 访问密钥」核对，注意 AK 20 位、SK 40 位）；\n' +
        '② 请求带了查询参数但签名没覆盖它 —— 本项目已处理，若仍复现请把这条错误报到 issue；\n' +
        '③ 本机系统时间与真实时间相差超过 15 分钟（华为云签名带时间戳，偏差过大会被判无效）。',
    }
  }

  // 2. 凭据过期/缺失。
  if (matches(haystack, /APIG\.0602|security token.*expired|token.*expired|认证失败|Missing.*credential/i)) {
    return {
      kind: 'credential',
      code: detail.code || 'APIG.0602',
      message: detail.message,
      retryable: false,
      hint:
        '凭据已过期或没有读到。检查环境变量 CODEARTS_CLI_AK / CODEARTS_CLI_SK 是否已设置，\n' +
        '或在插件设置页粘贴 AK/SK。注意：Windows 上改完环境变量必须重启 DSH 才生效，\n' +
        '本插件会额外直接读注册表，所以通常无需重启。',
    }
  }

  // 3. 权益问题：账号有权限问题但不是插件坏了。
  if (
    matches(
      haystack,
      /benefit not found|InferHub\.4004|权益|无权调用|no available channel|ModelArts\.81010|TM\.000010051/i,
    )
  ) {
    return {
      kind: 'entitlement',
      code: detail.code,
      message: detail.message,
      retryable: false,
      hint:
        '这个账号没有该模型的调用权益（实测原文：您当前无权调用该模型，请联系企业管理员开通）。\n' +
        '这不是插件故障：模型目录照样能列出来，但每次对话都会被拒。\n' +
        '下一步：① 换一个模型试试（倍率旁边没写「需开通」的通常可用）；\n' +
        '② 去码道控制台确认套餐是否包含该模型；③ 企业账号请联系管理员开通。',
    }
  }

  // 4. 模型不可用：目录里有但该账号调不动。
  if (matches(haystack, /InferHub\.4005|unsupported model|ModelArts\.81009|Invalid model/i)) {
    return {
      kind: 'unsupported_model',
      code: detail.code,
      message: detail.message,
      retryable: false,
      hint:
        '这个模型在该账号下不可调用。点「刷新模型目录」重新拉一次清单；\n' +
        '如果仍然失败，说明该模型需要单独的权益开通。',
    }
  }

  // 5. 限流：值得退避重试。
  if (matches(haystack, /TM\.00001041|并发会话|rate limit|ModelArts\.81101|ModelArts\.81114|too many requests/i) || status === 429) {
    return {
      kind: 'rate_limited',
      code: detail.code || 'RATE_LIMITED',
      message: detail.message,
      retryable: true,
      retryAfterMs: 3_000,
      hint:
        '网关在限流。上游文案里的「并发会话数已达上限」具有误导性 —— 实测串行单请求、\n' +
        '间隔数秒、客户端进程数为 0 时同样会触发，它是网关侧的节奏控制而不是真的并发\n' +
        '占满。插件会自动退避重试，通常十几秒内恢复。',
    }
  }

  // 6. 请求参数问题。`Message role cannot empty` 是本项目实测到的 developer 角色报错。
  if (
    status === 400 || status === 413 ||
    matches(haystack, /InferHub\.001001|InferHub\.001001044|参数无效|invalid.*param|Message role cannot/i)
  ) {
    const isRoleIssue = matches(haystack, /Message role cannot/i)
    const isMaxTokens = matches(haystack, /max_(?:completion_)?tokens|max(?:imum)? output|output tokens?|输出\s*(?:token|令牌)/i)
    return {
      kind: 'bad_request',
      code: detail.code || `HTTP_${status}`,
      message: detail.message,
      retryable: false,
      hint: status === 413
        ? '码道网关拒绝了过大的请求体。请压缩上下文或减少图片。'
        : isRoleIssue
        ? '请求里的消息角色不被网关接受。DSH 用 developer 角色承载系统提示，\n' +
          '而码道网关只认 system/user/assistant/tool —— 插件会自动把 developer 改写成\n' +
          'system，若仍出现这条错误请把它报成 issue。'
        : isMaxTokens
          ? '输出 token 上限被网关拒绝。请调小「最大输出」后重试。'
          : '码道网关拒绝了请求参数。',
    }
  }

  // 7. 网关故障。
  if (status >= 500) {
    return {
      kind: 'server',
      code: detail.code || `HTTP_${status}`,
      message: detail.message,
      retryable: true,
      retryAfterMs: 2_000,
      hint: '华为云网关返回了服务端错误，通常是临时故障。插件会自动重试；\n若长时间不恢复，可以稍后再试或换一个模型。',
    }
  }

  return {
    kind: 'unknown',
    code: detail.code || `HTTP_${status}`,
    message: detail.message,
    retryable: status === 408 || status === 409,
    hint: `上游返回了未归类的错误（HTTP ${status}）。原始信息：${detail.message || '（空）'}`,
  }
}

/**
 * 把网络异常归类。
 *
 * `fetch` 抛出的异常在 Node 里是 `TypeError: fetch failed`，真正原因藏在
 * `cause` 里（`ENOTFOUND` 表示域名解析失败、`ECONNREFUSED` 表示端口不通、
 * 证书问题也在这一层），所以要往下挖一层。
 */
export const classifyTransportError = (error: unknown): ClassifiedError => {
  const parts: string[] = []
  let cursor: unknown = error
  for (let depth = 0; depth < 4 && cursor !== undefined && cursor !== null; depth += 1) {
    if (cursor instanceof Error) {
      parts.push(cursor.message)
      /**
       * 同时收 `code`。只看 message 会漏掉整整一类失败：Node 的 DNS 错误有
       * 的写 `getaddrinfo ENOTFOUND host`（message 里就有），有的只把
       * `ENOTFOUND` 放在 `code` 上，而 `fetch` 又会把它包在
       * `TypeError: fetch failed` 里 —— 只看最外层 message 永远看不到真因。
       */
      const code = (cursor as { code?: unknown }).code
      if (typeof code === 'string') parts.push(code)
      cursor = (cursor as { cause?: unknown }).cause
    } else {
      parts.push(String(cursor))
      break
    }
  }
  const text = parts.join(' | ')
  const isDns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)
  const isCert = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(text)

  return {
    kind: 'transport',
    code: isDns ? 'NETWORK_DNS' : isCert ? 'NETWORK_TLS' : 'NETWORK_ERROR',
    message: text,
    retryable: !isCert,
    retryAfterMs: 1_500,
    hint: isDns
      ? '解析不到华为云网关域名。检查本机网络/DNS，或公司网络是否拦截了 huaweicloud.com。'
      : isCert
        ? 'TLS 证书校验失败。若公司网络做了中间人代理，需要把代理根证书装进系统信任库。'
        : '网络请求失败。检查本机能否访问 snap-access.cn-north-4.myhuaweicloud.com。',
  }
}

/**
 * 生成给用户看的一句话摘要（用于输入框胶囊的 tooltip 与状态行）。
 *
 * 完整建议太长不适合常驻显示，这里只取第一句。
 */
export const summarizeForStatusLine = (error: ClassifiedError): string => {
  const firstLine = error.hint.split('\n')[0] ?? error.hint
  return firstLine.replace(/[。.]$/, '')
}
