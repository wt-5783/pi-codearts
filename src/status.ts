/**
 * 账号、积分、签到。
 *
 * 余额只取 usageTotalPackageCredit.package_credit_remain —— 基础/赠送/按需是总额的构成项，
 * 相加会重复计算（DSH 插件 M0 实测：总额 700 = 基础 500 + 赠送 200 + 按需 0）。
 */
import type { CodeArtsCredentials } from '../vendor/dsh-connect-codearts/protocol/sign.ts'
import { signRequest } from '../vendor/dsh-connect-codearts/protocol/sign.ts'
import { CODEARTS_CHECKIN_CAMPAIGN_TYPE } from '../vendor/dsh-connect-codearts/protocol/types.ts'
import type { AccountInfo, CreditInfo, WelfareItem } from '../vendor/dsh-connect-codearts/upstream.ts'
import { GATEWAY, client, fetchCatalog } from './catalog.ts'
import { credentialsFilePath } from './credentials.ts'

/** 网关的领取分 claim / confirm 两步，DSH 插件只封装了 claim；confirm 端点来自 HITZY2002/codearts2api 逆向记录 §6。 */
const CODEARTS_OPS_CONFIRM_PATH = '/v1/ops/confirm'

export interface StatusSnapshot {
  readonly fetchedAt: number
  readonly account?: AccountInfo
  readonly credit?: CreditInfo
  readonly welfare: readonly WelfareItem[]
  readonly problems: readonly string[]
}

/** 三个只读接口并行；任何一个失败都只记到 problems，不影响其余。 */
export const fetchStatus = async (credentials: CodeArtsCredentials, signal?: AbortSignal): Promise<StatusSnapshot> => {
  const problems: string[] = []
  const [account, credit, welfare] = await Promise.all([
    client.currentUser(credentials, signal).catch((error: Error) => {
      problems.push(`账号信息: ${error.message}`)
      return undefined
    }),
    client.credit(credentials, signal).catch((error: Error) => {
      problems.push(`积分: ${error.message}`)
      return undefined
    }),
    client.welfareItems(credentials, 'IDE', signal).catch((error: Error) => {
      problems.push(`签到活动: ${error.message}`)
      return [] as readonly WelfareItem[]
    }),
  ])
  return { fetchedAt: Date.now(), account, credit, welfare, problems }
}

/** 签到类活动（USER_LOGIN）。 */
export const checkinItems = (welfare: readonly WelfareItem[]): readonly WelfareItem[] =>
  welfare.filter((item) => item.type === CODEARTS_CHECKIN_CAMPAIGN_TYPE)

const num = (value: number | undefined): string => (value === undefined ? '—' : value.toLocaleString('zh-CN'))

/** 状态栏用的一行：剩余积分。 */
export const creditLine = (credit: CreditInfo | undefined): string | undefined => {
  if (credit === undefined) return undefined
  if (credit.remain === undefined && credit.total === undefined) return undefined
  const remain = credit.remain ?? credit.total ?? 0
  const used = credit.used ?? 0
  const total = credit.total ?? remain + used
  return `码道 积分 ${num(remain)}/${num(total)}`
}

/** 签到活动的一句话状态。 */
const welfareLine = (item: WelfareItem): string => {
  const amount = item.benefitAmount === undefined ? '' : ` ${num(item.benefitAmount)}${item.benefitUnit ?? ''}`
  const expire = item.expireAt === undefined ? '' : `（${item.expireAt.slice(0, 10)} 到期）`
  const state = item.claimable ? '可领取' : (item.status ?? '不可领')
  return `  · ${item.title}${amount} — ${state}${expire}`
}

/** `/codearts-usage` 的多行报告。 */
export const formatUsageReport = (
  snapshot: StatusSnapshot,
  source: string,
  catalog: readonly { id: string; ratioDisplay?: string; strengths: readonly string[] }[],
): string => {
  const lines: string[] = ['华为云码道 CodeArts']
  const account = snapshot.account
  lines.push(
    account === undefined
      ? '  账号：—'
      : `  账号：${account.userName ?? account.userId ?? '—'}${account.domainName === undefined ? '' : ` @ ${account.domainName}`}`,
  )
  const credit = snapshot.credit
  if (credit === undefined) {
    lines.push('  积分：读取失败')
  } else {
    const remain = credit.remain ?? (credit.total === undefined ? undefined : credit.total - (credit.used ?? 0))
    const total = credit.total ?? (remain === undefined ? undefined : remain + (credit.used ?? 0))
    lines.push(
      `  积分：剩余 ${num(remain)} / 总 ${num(total)}，已用 ${num(credit.used)}${credit.expiringAmount === undefined ? '' : `，即将到期 ${num(credit.expiringAmount)}`}`,
    )
    const parts = [
      credit.basic === undefined ? undefined : `基础 ${num(credit.basic)}`,
      credit.bonus === undefined ? undefined : `赠送 ${num(credit.bonus)}`,
      credit.onDemand === undefined ? undefined : `按需 ${num(credit.onDemand)}`,
    ].filter((part): part is string => part !== undefined)
    if (parts.length > 0) lines.push(`  构成：${parts.join(' · ')}`)
    if (credit.totalTokens !== undefined) lines.push(`  累计消耗：${num(credit.totalTokens)} tokens`)
  }
  const items = checkinItems(snapshot.welfare)
  lines.push(items.length === 0 ? '  签到：当前没有签到类活动' : `  签到（/codearts-checkin 领取）：\n${items.map(welfareLine).join('\n')}`)
  if (catalog.length > 0) {
    lines.push('  模型倍率：')
    for (const entry of catalog) {
      const strengths = entry.strengths.length === 0 ? '' : `  档位 ${entry.strengths.join('/')}`
      lines.push(`    ${entry.id.padEnd(28)} ${entry.ratioDisplay ?? '—'}${strengths}`)
    }
  }
  lines.push(`  凭证：${source}`)
  lines.push(`  刷新：${new Date(snapshot.fetchedAt).toLocaleTimeString('zh-CN')}`)
  for (const problem of snapshot.problems) lines.push(`  ⚠ ${problem}`)
  return lines.join('\n')
}

/**
 * 签到后的确认。网关的领取分 claim / confirm 两步：只 claim 不 confirm，积分不会落地
 * （HITZY2002/codearts2api 逆向记录 §6；DSH 插件只做 claim，这里补上 confirm）。
 */
const confirmWelfare = async (
  credentials: CodeArtsCredentials,
  campaignId: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> => {
  const url = new URL(`${GATEWAY}${CODEARTS_OPS_CONFIRM_PATH}`)
  const body = JSON.stringify({ campaignId })
  const signed = signRequest({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body, credentials })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...signed.headers, Accept: 'application/json', 'Agent-Type': 'PromptCenter', 'X-Language': 'zh-cn' },
      body,
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status} ${text.slice(0, 120)}` }
    let code: unknown
    try {
      code = (JSON.parse(text) as { code?: unknown }).code
    } catch {
      code = 0
    }
    return code === undefined || code === 0 || code === '0' ? { ok: true, detail: '已确认' } : { ok: false, detail: `业务码 ${String(code)}` }
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }
}

export interface CheckinResult {
  readonly title: string
  readonly ok: boolean
  readonly message: string
}

/** 领取所有可领的签到活动：claim → confirm。幂等键由 DSH 客户端生成（uuid），允许用户重试。 */
export const checkinAll = async (credentials: CodeArtsCredentials, signal?: AbortSignal): Promise<CheckinResult[]> => {
  const items = checkinItems(await client.welfareItems(credentials, 'IDE', signal))
  const results: CheckinResult[] = []
  for (const item of items) {
    if (!item.claimable) {
      results.push({ title: item.title, ok: false, message: `不可领（${item.status ?? '未知状态'}）` })
      continue
    }
    const claim = await client.claimWelfare(credentials, item.campaignId, signal)
    if (!claim.ok) {
      results.push({ title: item.title, ok: false, message: claim.error?.hint ?? '领取失败，原因未知' })
      continue
    }
    const confirm = await confirmWelfare(credentials, item.campaignId, signal)
    results.push({
      title: item.title,
      ok: true,
      message: `已领取${item.benefitAmount === undefined ? '' : ` ${num(item.benefitAmount)}${item.benefitUnit ?? ''}`}${confirm.ok ? '' : `，确认未完成（${confirm.detail}），下次签到会补确认`}`,
    })
  }
  return results
}

/** 已领取但未确认的活动补一次 confirm（用于「上次 claim 成功、confirm 失败」的情况）。 */
export const reconfirmPending = async (credentials: CodeArtsCredentials, signal?: AbortSignal): Promise<string[]> => {
  const notes: string[] = []
  for (const item of checkinItems(await client.welfareItems(credentials, 'IDE', signal))) {
    if (item.claimable || item.status === 'CONFIRMED' || item.status === 'CONSUMED') continue
    const confirm = await confirmWelfare(credentials, item.campaignId, signal)
    notes.push(`${item.title}: ${confirm.ok ? '已补确认' : `补确认失败（${confirm.detail}）`}`)
  }
  return notes
}

/** 诊断：逐级检查凭据 → 身份 → 目录 → 积分，给可执行建议。 */
export const doctor = async (resolve: () => { credentials: CodeArtsCredentials; source: string }): Promise<string> => {
  const lines: string[] = []
  let credentials: CodeArtsCredentials
  try {
    const resolved = resolve()
    credentials = resolved.credentials
    lines.push(`✓ 凭证：${resolved.source}`)
  } catch (error) {
    lines.push((error as Error).message)
    return lines.join('\n')
  }
  try {
    const account = await client.currentUser(credentials)
    lines.push(`✓ 身份：${account.userName ?? account.userId ?? '—'}${account.domainName === undefined ? '' : ` @ ${account.domainName}`}`)
  } catch (error) {
    const message = (error as Error).message
    const authish = /APIG\.0301|APIG\.0613|APIG\.0602|signature fail|Incorrect IAM authentication|认证失败/i.test(message)
    lines.push(authish ? '✗ 身份：AK/SK 校验未通过（凭证错误，或密钥已被删除/禁用）' : `✗ 身份：${message}`)
    lines.push('  → 核对华为云控制台「我的凭证 → 访问密钥」：AK 为 20 位、SK 为 40 位，需完整复制且未被删除。')
    lines.push(`  → 若凭证无误仍失败，确认该账号已开通码道套餐；当前文件：${credentialsFilePath()}`)
    return lines.join('\n')
  }
  try {
    const catalog = await fetchCatalog(credentials)
    lines.push(`✓ 目录：${catalog.length} 个模型（${catalog.slice(0, 5).map((entry) => entry.id).join(', ')}${catalog.length > 5 ? ', …' : ''}）`)
  } catch (error) {
    lines.push(`✗ 目录：${(error as Error).message}`)
  }
  try {
    const credit = await client.credit(credentials)
    lines.push(credit === undefined ? '· 积分：接口没有返回套餐积分' : `✓ 积分：剩余 ${num(credit.remain)} / 总 ${num(credit.total)}，已用 ${num(credit.used)}`)
  } catch (error) {
    lines.push(`✗ 积分：${(error as Error).message}`)
  }
  return lines.join('\n')
}
