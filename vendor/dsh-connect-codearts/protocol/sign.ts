/**
 * 华为云 APIG `SDK-HMAC-SHA256` 请求签名器。
 *
 * 参考：dsh-connect-madao（MIT, XLNC-L）`src/protocol/sign.ts` — 整体算法骨架、
 *       四个实测坑的头注释、`SignedHeaders` 必须与实发头一一对应的结论。
 * 参考：dsh-huaweicloud-connect（MIT, Alanine-孔硕）`lib/apig-sign.js` — 把
 *       `huaweiEncode` 的 `!'()*` 补编码、`EMPTY_BODY_SHA256` 常量。
 * 改动：① **把 `CanonicalQueryString` 真正算进去**。两个参考实现都把它硬编码
 *       成空字符串，之所以至今能用，只是因为它们调的端点恰好没有 query。
 *       任何带 query 的请求（`/v1/ops/delivery?channel=IDE`）在它们那儿必
 *       401，而 401 的文案是 `verify ak sk signature fail`，会被误判成
 *       「凭据不对」或「端点不存在」。见 `canonicalQuery` 的注释。
 *       ② 返回 `canonicalRequest` / `stringToSign` 便于 401 时逐行对比。
 *
 * @module dsh-connect-codearts/protocol/sign
 */
import { createHash, createHmac } from 'node:crypto'

export const SIGN_ALGORITHM = 'SDK-HMAC-SHA256'

/** 空 body 的 SHA256，省一次哈希；GET 请求都走这个分支。 */
export const EMPTY_BODY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** 参与签名的凭据。长期 AK/SK 没有 `securityToken`，临时 STS 才有。 */
export interface CodeArtsCredentials {
  readonly accessKey: string
  readonly secretKey: string
  /** 仅临时凭据（STS）需要；IAM 长期 AK/SK 传 undefined。 */
  readonly securityToken?: string | undefined
}

export interface SignInput {
  readonly method: string
  readonly url: string | URL
  /** 参与签名的头。`Host` / `X-Sdk-Date` 由本模块补，不要自己传。 */
  readonly headers?: Record<string, string> | undefined
  /** 明文 body。与 `bodyBytes` 二者取一；都没有按空 body 处理。 */
  readonly body?: string | undefined
  /**
   * 二进制 body。当前网关走明文 JSON，用不到；保留是为了在将来启用
   * SM4-GCM 传输加密时，签名能覆盖「实际发出去的那串字节」而不是明文。
   */
  readonly bodyBytes?: Uint8Array | undefined
  readonly credentials: CodeArtsCredentials
  /** 注入固定时间戳，仅测试用。 */
  readonly now?: Date | undefined
}

export interface SignedRequest {
  /** 实际要发出去的头（已含 `Authorization`，不含 `host`）。 */
  readonly headers: Record<string, string>
  readonly canonicalRequest: string
  readonly stringToSign: string
  readonly signature: string
  readonly signedHeaders: string
  readonly payloadHash: string
}

const sha256Hex = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')

/**
 * 华为云的 rfc3986 编码。
 *
 * `encodeURIComponent` 不转义 `!'()*` 五个字符，而华为云的规范化要求它们也被
 * 转义，否则签名对不上。这是从两个参考实现里都出现过的同一处修正。
 */
export const huaweiEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
  )

/** `X-Sdk-Date` 要求的格式是 `YYYYMMDDTHHmmssZ`（UTC，无分隔符）。 */
export const formatSdkDate = (date: Date = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

/**
 * 规范化 URI：逐段编码后拼回，**末尾补斜杠**。
 *
 * 华为云要求签名用 `/a/b/c/`、实际请求发 `/a/b/c`。搞反了就是恒定 401。
 */
export const canonicalUri = (pathname: string): string => {
  const encoded = pathname.split('/').map(huaweiEncode).join('/')
  return encoded.endsWith('/') ? encoded : `${encoded}/`
}

/**
 * 规范化 QueryString：按参数名排序，名与值都做 rfc3986 编码。
 *
 * 这是最容易漏的一处，漏了会得到一个极具误导性的现象：同一路径**不带**
 * query 时能拿到后端业务错误（说明鉴权过了），**带** query 时却 401
 * `verify ak sk signature fail`（说明鉴权没过）。M0 实测：
 *
 *   GET /v1/ops/delivery             → 400 PROMPTCENTER.00000001 channel 参数无效
 *   GET /v1/ops/delivery?channel=IDE → 401 verify ak sk signature fail
 *
 * 看到「加个参数就 401」就该先查这里。排序规则按 OpenAPI：先比名，名相同比
 * 值，都用 localeCompare 保证与区域设置无关的稳定顺序。
 */
export const canonicalQuery = (search: string): string => {
  if (search === '' || search === '?') return ''
  const pairs = [...new URLSearchParams(search).entries()]
    .map(([k, v]) => [huaweiEncode(k), huaweiEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  return pairs.map(([k, v]) => `${k}=${v}`).join('&')
}

/**
 * 签名一个请求。
 *
 * 调用方拿到结果后应当**原样**发出 `headers` 加上 `Authorization`，不要增删
 * 任何头：`SignedHeaders` 里列出的每一个头都会在服务端被重新拼进规范化请求，
 * 多一个少一个都会 401。需要附加不参与签名的头（例如 `Agent-Type`、
 * `X-Language`、`Chat-Id`）时，在签名**之后**追加。
 */
export const signRequest = (input: SignInput): SignedRequest => {
  const parsed = typeof input.url === 'string' ? new URL(input.url) : input.url
  const credentials = input.credentials

  // 1. 组装参与签名的头。Host 必须用 URL 的 host（含端口），不能靠 fetch 的默认值。
  const merged: Array<[string, string]> = Object.entries({
    ...(input.headers ?? {}),
    host: parsed.host,
    'X-Sdk-Date': formatSdkDate(input.now),
    ...(credentials.securityToken === undefined
      ? {}
      : { 'X-Security-Token': credentials.securityToken }),
  }).map(([name, value]) => [name, value] as [string, string])

  // 2. 规范化：小写名、折空白、按名排序。
  const normalized = merged.map(
    ([name, value]) =>
      [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')] as const,
  )
  normalized.sort((a, b) => a[0].localeCompare(b[0]))

  const canonicalHeaders = normalized.map(([name, value]) => `${name}:${value}\n`).join('')
  const signedHeaders = normalized.map(([name]) => name).join(';')

  // 3. payload 哈希。二进制的优先（将来启用加密时是它），否则哈希明文字符串。
  const payloadHash =
    input.bodyBytes !== undefined
      ? sha256Hex(input.bodyBytes)
      : input.body === undefined || input.body === ''
        ? EMPTY_BODY_SHA256
        : sha256Hex(input.body)

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(parsed.pathname),
    canonicalQuery(parsed.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const sdkDate = normalized.find(([name]) => name === 'x-sdk-date')?.[1] ?? ''
  const stringToSign = [SIGN_ALGORITHM, sdkDate, sha256Hex(canonicalRequest)].join('\n')

  const signature = createHmac('sha256', credentials.secretKey)
    .update(stringToSign, 'utf8')
    .digest('hex')

  // 4. 出去的头保留调用方原本的大小写，去掉 host（由 fetch 自己写）。
  const outgoing: Record<string, string> = {}
  for (const [name, value] of merged) {
    if (name.toLowerCase() === 'host') continue
    outgoing[name] = value
  }
  outgoing.Authorization =
    `${SIGN_ALGORITHM} Access=${credentials.accessKey}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return { headers: outgoing, canonicalRequest, stringToSign, signature, signedHeaders, payloadHash }
}
