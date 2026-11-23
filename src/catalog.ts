/**
 * 模型目录：向码道网关拉「内置模型」+「每个模型声明的思考档位」，转成 pi 的模型定义。
 *
 * 网关直出 context_window / max_tokens / supports_images / credit[0].ratio_display（积分倍率），
 * 不需要内置快照表。拉到的目录缓存到 ~/.pi/agent/cache/pi-codearts/catalog.json：
 * pi 的 print / --list-models / 子代理模式不联网刷新模型，启动时靠这份缓存。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodeArtsCredentials } from '../vendor/dsh-connect-codearts/protocol/sign.ts'
import { CODEARTS_DEFAULT_MAX_OUTPUT, CODEARTS_GATEWAY, CODEARTS_MAX_OUTPUT_CEILING } from '../vendor/dsh-connect-codearts/protocol/types.ts'
import { CodeArtsUpstreamClient, type ModelCatalogEntry } from '../vendor/dsh-connect-codearts/upstream.ts'

/**
 * 网关地址。默认华南-贵阳一的商业版；别的区域用 PI_CODEARTS_GATEWAY 覆盖
 * （必须是 https，带凭据/查询串的一律回退到默认值，避免把密钥写进 URL）。
 */
export const GATEWAY = (() => {
  const raw = process.env['PI_CODEARTS_GATEWAY']?.trim() ?? ''
  if (raw === '') return CODEARTS_GATEWAY
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return CODEARTS_GATEWAY
    return url.href.replace(/\/+$/, '')
  } catch {
    return CODEARTS_GATEWAY
  }
})()

export const PROVIDER_ID = 'codearts'
/** pi 规定：注册了 streamSimple 的 provider 必须有 api 名；请求时 model.api === 这个值才走扩展的实现。 */
export const PROVIDER_API = 'codearts'
/** pi 自带 openai-completions 会请求 {baseUrl}/chat/completions，签名 fetch 再改写到码道路径。 */
export const BASE_URL = `${GATEWAY}/v1`

/** pi 的思考档位全集；网关声明的档位若在其中就开放，否则标 null（pi 不列出）。 */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export interface CatalogEntry extends ModelCatalogEntry {
  readonly strengths: readonly string[]
  readonly defaultStrength?: string
}

let sink: (line: string) => void = () => {}
/** 由 index.ts 在启动时注入（默认静默：pi 不接管扩展的 console 输出）。 */
export const setLogSink = (fn: (line: string) => void): void => {
  sink = fn
}
const log = (line: string): void => sink(line)

/** 客户端一次性构造；网关非法时回退默认值（构造器只在 https 时接受）。 */
export const client = ((): CodeArtsUpstreamClient => {
  try {
    return new CodeArtsUpstreamClient({ gateway: GATEWAY, log })
  } catch {
    return new CodeArtsUpstreamClient({ log })
  }
})()

/** 一次拉全：模型目录 + 思考档位。两次 GET/POST，不消耗积分。 */
export const fetchCatalog = async (
  credentials: CodeArtsCredentials,
  signal?: AbortSignal,
): Promise<CatalogEntry[]> => {
  const models = await client.listModels(credentials, signal)
  const variants = await client.thinkingVariants(
    credentials,
    models.map((model) => model.id),
    signal,
  )
  return models.map((model) => {
    const declared = variants.get(model.id)
    return {
      ...model,
      strengths: declared?.strengths ?? [],
      ...(declared?.defaultStrength === undefined ? {} : { defaultStrength: declared.defaultStrength }),
    }
  })
}

/** 倍率标注，例如 `GLM-5.3 0.18x`。解析不出就不标，不虚构。 */
const ratioSuffix = (entry: CatalogEntry): string => (entry.ratioDisplay === undefined ? '' : ` ${entry.ratioDisplay}`)

export const displayNameOf = (entry: CatalogEntry): string =>
  entry.name === entry.id ? `${entry.id}${ratioSuffix(entry)}` : `${entry.name} · ${entry.id}${ratioSuffix(entry)}`

/** 网关目录条目 → pi 的 chat 模型定义。 */
export const toPiModel = (entry: CatalogEntry): Record<string, unknown> => {
  const declared = entry.strengths.length > 0
  const thinkingLevelMap: Record<string, string | null> = {}
  for (const level of PI_THINKING_LEVELS) thinkingLevelMap[level] = declared && entry.strengths.includes(level) ? level : null
  return {
    type: 'chat',
    id: entry.id,
    api: PROVIDER_API,
    name: displayNameOf(entry),
    // 没声明档位的模型按非推理模型处理：pi 不会发 reasoning_effort（DSH 同样的判断）
    reasoning: declared,
    ...(declared ? { thinkingLevelMap } : {}),
    input: entry.supportsImages ? ['text', 'image'] : ['text'],
    // 积分计费，pi 的 USD 成本表填 0；真实消耗见 /codearts-usage 与状态栏
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow > 0 ? entry.contextWindow : 131_072,
    maxTokens: Math.min(entry.maxTokens > 0 ? entry.maxTokens : CODEARTS_DEFAULT_MAX_OUTPUT, CODEARTS_MAX_OUTPUT_CEILING),
    // 只声明 DSH 插件实测过的差异：网关不认 developer 角色；输出上限字段是 max_tokens
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  }
}

export const catalogPath = (): string =>
  process.env['PI_CODEARTS_CACHE'] ?? join(homedir(), '.pi', 'agent', 'cache', 'pi-codearts', 'catalog.json')

export const readCatalogCache = (): CatalogEntry[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(catalogPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) return []
    const entries = (parsed as { entries: unknown[] }).entries
    // 缓存文件可能被截断或手改过；形状不对的条目直接丢弃，别让 toPiModel 崩
    return entries.filter(
      (entry): entry is CatalogEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        (entry as { id: string }).id !== '' &&
        Array.isArray((entry as { strengths?: unknown }).strengths),
    )
  } catch {
    /* 没有缓存 */
  }
  return []
}

export const writeCatalogCache = (entries: readonly CatalogEntry[]): void => {
  try {
    const path = catalogPath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ fetchedAt: new Date().toISOString(), entries }, null, 1)}\n`, { mode: 0o600 })
  } catch (error) {
    log(`写目录缓存失败: ${(error as Error).message}`)
  }
}
