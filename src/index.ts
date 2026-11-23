/**
 * pi-codearts — 华为云码道 CodeArts 作为 pi coding agent 的模型 provider。
 *
 * pi 启动时加载本文件（~/.pi/agent/extensions/pi-codearts → 本项目目录的符号链接）。
 * 它做四件事：
 *   1. registerProvider("codearts")：模型清单来自网关实时目录（上下文/输出上限/思考档位/倍率）
 *   2. streamSimple：委托给 pi 自带的 openai-completions 实现，只把 fetch 换成「签名 fetch」
 *      （src/signed-fetch.ts），请求直达 https://snap-access.cn-north-4.myhuaweicloud.com
 *   3. 命令：/codearts-usage  /codearts-checkin  /codearts-models  /codearts-doctor
 *   4. 状态栏：用码道模型时显示「码道 积分 剩余/总量」，每次回复后节流刷新
 *
 * 不开端口、不起子进程、不写华为凭证；唯一的落盘是模型目录缓存。
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat'
import { requireCredentials, resolveCredentials } from './credentials.ts'
import { BASE_URL, PROVIDER_API, PROVIDER_ID, catalogPath, fetchCatalog, readCatalogCache, toPiModel, writeCatalogCache, type CatalogEntry } from './catalog.ts'
import { createSignedFetch } from './signed-fetch.ts'
import { checkinAll, creditLine, doctor, fetchStatus, formatUsageReport, reconfirmPending, type StatusSnapshot } from './status.ts'

const STATUS_KEY = 'codearts'
/** 状态栏刷新节流：回复后最多每 60 秒拉一次积分（只读接口，不消耗积分）。 */
const STATUS_REFRESH_MS = 60_000

const log = (line: string): void => console.error(`[pi-codearts] ${line}`)

/** 占位密钥：pi 要求定义模型的 provider 必须有 apiKey；真实鉴权在签名 fetch 里完成。 */
const PLACEHOLDER_KEY = 'codearts-iam-ak-sk'

export default function (pi: ExtensionAPI) {
  let catalog: CatalogEntry[] = readCatalogCache()
  let status: StatusSnapshot | undefined
  let statusFetchedAt = 0
  let statusInFlight: Promise<StatusSnapshot> | undefined

  const refreshStatus = (): Promise<StatusSnapshot> => {
    if (statusInFlight !== undefined) return statusInFlight
    statusInFlight = (async () => {
      try {
        status = await fetchStatus(requireCredentials())
        statusFetchedAt = Date.now()
      } catch (error) {
        log(`刷新积分失败: ${(error as Error).message}`)
      } finally {
        statusInFlight = undefined
      }
      return status as StatusSnapshot
    })()
    return statusInFlight
  }

  const refreshStatusIfStale = (): Promise<StatusSnapshot> | undefined =>
    Date.now() - statusFetchedAt > STATUS_REFRESH_MS ? refreshStatus() : undefined

  /** 只在当前模型是码道时显示；切到别的 provider 就清掉。 */
  const updateFooter = (ctx: ExtensionContext): void => {
    const active = ctx.model?.provider === PROVIDER_ID
    ctx.ui.setStatus(STATUS_KEY, active ? creditLine(status?.credit) : undefined)
  }

  const show = (text: string): void => {
    pi.sendMessage({ customType: 'pi-codearts', content: text, display: true }, { triggerTurn: false })
  }

  // ---------------------------------------------------------------------------
  // 1 + 2. provider
  // ---------------------------------------------------------------------------
  pi.registerProvider(PROVIDER_ID, {
    name: '华为码道 CodeArts',
    baseUrl: BASE_URL,
    api: PROVIDER_API,
    apiKey: PLACEHOLDER_KEY,
    models: catalog.map(toPiModel),

    /** pi 在 TUI 启动和按 Ctrl+L 时调用；print 模式不调用（用缓存）。 */
    async refreshModels(context) {
      if (!context.allowNetwork || context.signal.aborted) return catalog.map(toPiModel)
      const credentials = requireCredentials()
      catalog = await fetchCatalog(credentials, context.signal)
      writeCatalogCache(catalog)
      void refreshStatus()
      return catalog.map(toPiModel)
    },

    /** pi 把请求交到这里；除 fetch 外的一切（消息转换、工具调用、思考、用量、中断）都由 pi 自带的 openai-completions 处理。 */
    streamSimple(model, context, options) {
      const credentials = requireCredentials()
      const routed = {
        ...model,
        api: 'openai-completions',
        baseUrl: BASE_URL,
        compat: { ...(model.compat ?? {}), supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
      }
      return openAICompletionsApi().streamSimple(routed as never, context, {
        ...options,
        apiKey: PLACEHOLDER_KEY,
        fetch: createSignedFetch(credentials, log),
      } as never)
    },
  })

  // ---------------------------------------------------------------------------
  // 3. 命令
  // ---------------------------------------------------------------------------
  pi.registerCommand('codearts-usage', {
    description: '码道积分余额 / 构成 / 签到状态 / 各模型倍率',
    handler: async (_args: string, _ctx: ExtensionCommandContext) => {
      const resolved = resolveCredentials()
      if (!resolved.ok) return show(`${resolved.reason}\n${resolved.attempts.join('\n')}`)
      const snapshot = await refreshStatus()
      show(formatUsageReport(snapshot, resolved.source, catalog))
    },
  })

  pi.registerCommand('codearts-checkin', {
    description: '领取今日码道签到积分（先确认）',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const resolved = resolveCredentials()
      if (!resolved.ok) return show(`${resolved.reason}\n${resolved.attempts.join('\n')}`)
      const snapshot = await refreshStatus()
      const claimable = snapshot.welfare.filter((item) => item.claimable)
      if (claimable.length === 0) {
        const notes = await reconfirmPending(resolved.credentials)
        return show(['今天没有可领取的签到积分。', ...notes.map((note) => `  ${note}`)].join('\n'))
      }
      const ok = await ctx.ui.confirm('码道签到', `将领取 ${claimable.length} 项：${claimable.map((item) => item.title).join('、')}`)
      if (!ok) return
      const results = await checkinAll(resolved.credentials)
      statusFetchedAt = 0
      await refreshStatus()
      show(results.map((result) => `${result.ok ? '✓' : '✗'} ${result.title}：${result.message}`).join('\n'))
    },
  })

  pi.registerCommand('codearts-models', {
    description: '刷新码道模型目录（上下文 / 输出上限 / 档位 / 倍率）',
    handler: async (_args: string, _ctx: ExtensionCommandContext) => {
      const resolved = resolveCredentials()
      if (!resolved.ok) return show(`${resolved.reason}\n${resolved.attempts.join('\n')}`)
      try {
        catalog = await fetchCatalog(resolved.credentials)
        writeCatalogCache(catalog)
      } catch (error) {
        return show(`拉取目录失败：${(error as Error).message}`)
      }
      const lines = catalog.map((entry) => {
        const ctx = entry.contextWindow > 0 ? `${Math.round(entry.contextWindow / 1024)}K` : '—'
        const max = entry.maxTokens > 0 ? `${Math.round(entry.maxTokens / 1024)}K` : '—'
        const strengths = entry.strengths.length === 0 ? '' : `  档位 ${entry.strengths.join('/')}${entry.defaultStrength === undefined ? '' : `（默认 ${entry.defaultStrength}）`}`
        const vision = entry.supportsImages ? '  👁' : ''
        return `  ${entry.id.padEnd(28)} ${entry.ratioDisplay ?? '—'.padEnd(6).trim()}  ctx ${ctx.padEnd(5)} out ${max.padEnd(5)}${strengths}${vision}`
      })
      show([`码道模型目录（${catalog.length} 个，缓存 ${catalogPath()}）`, ...lines].join('\n'))
    },
  })

  pi.registerCommand('codearts-doctor', {
    description: '码道自检：凭据 → 身份 → 目录 → 积分',
    handler: async (_args: string, _ctx: ExtensionCommandContext) => {
      show(await doctor(() => {
        const resolved = resolveCredentials()
        if (!resolved.ok) throw new Error([resolved.reason, ...resolved.attempts].join('\n'))
        return { credentials: resolved.credentials, source: resolved.source }
      }))
    },
  })

  // ---------------------------------------------------------------------------
  // 4. 状态栏
  // ---------------------------------------------------------------------------
  pi.on('session_start', async (_event, ctx) => {
    updateFooter(ctx)
    if (ctx.model?.provider === PROVIDER_ID) void refreshStatus().then(() => updateFooter(ctx))
  })
  pi.on('model_select', async (_event, ctx) => {
    updateFooter(ctx)
    if (ctx.model?.provider === PROVIDER_ID) void (refreshStatusIfStale() ?? Promise.resolve(undefined)).then(() => updateFooter(ctx))
  })
  pi.on('turn_end', async (_event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return
    void refreshStatusIfStale()?.then(() => updateFooter(ctx))
  })
}
