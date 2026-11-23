/**
 * 协议层共享类型。刻意不引用任何宿主包，这样 `bin.ts` 与单测都能直接用。
 *
 * @module dsh-connect-codearts/protocol/types
 */

/**
 * DSH 的推理档位 id。
 *
 * 与宿主 `dsh-llm` 的 `ReasoningEffortId` 保持字符串兼容，但不 import 它 ——
 * 协议层一旦依赖宿主包，`bin.ts` 在纯 Node 解析下就会崩（见 tsdown 的
 * `neverBundle` 注释）。
 */
export type ReasoningEffortId = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max'

/**
 * 输出 token 的安全上界。
 *
 * M0 实测 `deepseek-v4.1-flash`：65536 / 65537 / 131072 正常，393216 静默
 * 空流。取 131072 作天花板，超过就夹住而不是发出去等空响应。
 */
export const CODEARTS_MAX_OUTPUT_CEILING = 131_072

/** 调用方没指定时的默认输出预算。约两万四千汉字，给正文留足空间。 */
export const CODEARTS_DEFAULT_MAX_OUTPUT = 32_768

/** 标记经 DSH 桌面端转发的同源写请求。 */
export const CODEARTS_WRITE_REQUEST_HEADER = 'x-dsh-codearts-request'

/** 快捷设置只写宿主声明允许热更的字段。 */
export const CODEARTS_POLL_INTERVALS_MS = [60_000, 300_000, 600_000, 1_800_000, 3_600_000] as const
export const CODEARTS_SETTINGS_PATH = '/plugins/dsh-connect-codearts/settings'
export const CODEARTS_SETTINGS_CHANGED = 'dsh-codearts-settings-changed'

export interface QuickSettings {
  readonly showCredits: boolean
  readonly pollIntervalMs: number
  readonly defaultEfforts: Readonly<Record<string, string>>
}

export interface SettingsSnapshot extends QuickSettings {
  readonly enabled: boolean
  /** 自定义网关地址，空串表示官方地址。 */
  readonly gateway: string
  /** 缺席表示宿主无法从本面板保存设置。 */
  readonly revision?: number
}

/** 界面上可见的偏好快照。 */
export interface PreferencesSnapshot {
  /** 用户在模型页签里勾掉的模型 id。 */
  readonly hiddenModelIds: readonly string[]
  /** 上一次自动签到成功的本地日期（`YYYY-MM-DD`）与金额。 */
  readonly lastCheckin: { readonly date: string; readonly amount?: number; readonly at: number } | null
  /** 今天（本地时区）是否已经签到成功。由服务端算，客户端不重算日界。 */
  readonly checkedInToday: boolean
  /** 自动签到的生效值。 */
  readonly autoCheckin: boolean
}

/** 写偏好的载荷。字段缺席表示「这一项不改」。 */
export interface PreferencesPatch {
  readonly hiddenModelIds?: readonly string[]
  readonly autoCheckin?: boolean
}

/** 网关根地址（华北-北京四，官方 FAQ 域名白名单里的对话网关）。 */
export const CODEARTS_GATEWAY = 'https://snap-access.cn-north-4.myhuaweicloud.com'

/** 对话补全（SSE）。 */
export const CODEARTS_CHAT_PATH = '/api/v2/chat/completions'

/** 内置模型目录。需要 `Agent-Type: PromptCenter` 头（不参与签名）。 */
export const CODEARTS_MODELS_PATH = '/v1/model/builtin'

/** 每个模型的思考档位表（POST）。 */
export const CODEARTS_THINKING_VARIANTS_PATH = '/v1/model/thinking-variants'

/** 当前账号身份：唯一能拿到的身份信息，没有昵称/邮箱/手机号。 */
export const CODEARTS_CURRENT_USER_PATH = '/snap-manager/v1/current/user'

/** 积分/用量。注意前缀必须是 `snap-manager`，缺了 404。 */
export const CODEARTS_STATISTICS_PATH = '/snap-manager/v1/statistics/plugin'

/** 企业/团队角色，纯展示用。 */
export const CODEARTS_MEMBER_ROLES_PATH = '/snap-manager/v1/member/roles'

/** 运营活动/福利列表。带 query，签名必须覆盖 CanonicalQueryString。 */
export const CODEARTS_OPS_DELIVERY_PATH = '/v1/ops/delivery'

/** 领取某个活动的奖励（POST）。 */
export const CODEARTS_OPS_CLAIM_PATH = '/v1/ops/claim'

/**
 * 每日签到的活动类型。
 *
 * 参考实现 madao 硬编码了 `campaignId === 34`。M0 实测本机确实是 34，但
 * campaignId 是华为侧可调的运营配置，硬编码会在调整时**静默失效**（界面
 * 显示「没有可签到活动」而不是报错）。按 `type` 识别才稳。
 */
export const CODEARTS_CHECKIN_CAMPAIGN_TYPE = 'USER_LOGIN'
