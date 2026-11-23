# pi-codearts — 华为云码道 CodeArts 作为 pi 的模型 provider

把华为云码道（CodeArts）代码智能体套餐里的模型接进 [pi coding agent](https://github.com/earendil-works/pi)，
和 GLM / Codex 等其他 provider 并列，**Ctrl+L 无感切换**；显示剩余积分、各模型积分倍率，支持每日签到。

- **直连**：进程内用 IAM 长期 AK/SK 对每个请求做 `SDK-HMAC-SHA256` 签名，直达
  `https://snap-access.cn-north-4.myhuaweicloud.com`。不开端口、不起子进程、不刷新 token、不用重新登录。
- **复用 pi 的成熟实现**：消息转换、工具调用、思考内容、用量统计、中断，全部由 pi 自带的
  `openai-completions` 实现处理；本项目只提供「带签名的 fetch」和模型目录。
- **协议层来自 [dsh-connect-codearts](https://github.com/anheon/dsh-connect-codearts)**（MIT），
  原样放在 `vendor/`，零 DSH 依赖，只 import Node 内置模块。

## 目录

```
~/projects/pi-codearts/
├── src/
│   ├── index.ts          pi 扩展入口：注册 provider、4 个命令、状态栏
│   ├── credentials.ts    AK/SK 读取（环境变量 → ~/.pi/agent/codearts.credentials.json）
│   ├── catalog.ts        模型目录 + 思考档位 → pi 模型定义；缓存到 ~/.pi/agent/cache/pi-codearts/
│   ├── signed-fetch.ts   签名 fetch：请求体归一化、签名、必须头、错误归一化 + 常见错误码中文提示
│   └── status.ts         账号 / 积分 / 签到 / 诊断
├── vendor/dsh-connect-codearts/   协议层（MIT，原样）：sign / body / sse / errors / upstream
├── scripts/
│   ├── doctor.mjs        自检：凭据 → 身份 → 目录 → 积分
│   ├── catalog.mjs       拉目录并写缓存
│   ├── usage.mjs         积分 / 签到 / 倍率报告
│   └── rpc-smoke.py      用 pi RPC 模式无终端地跑一遍命令
├── package.json          pi 扩展清单（pi.extensions → src/index.ts）
└── tsconfig.json         编辑器类型检查用（映射到全局安装的 pi）
```

安装方式是**符号链接**：`~/.pi/agent/extensions/pi-codearts → ~/projects/pi-codearts`。
改源码后在 pi 里 `/reload` 即生效；不需要构建步骤（pi 的加载器直接跑 TS）。

## 请求链路

```
pi（TUI / --print / 子代理）
  └─ provider "codearts"，model.api = "codearts" → 走扩展的 streamSimple
       └─ pi 自带 openai-completions：把对话转成标准 OpenAI 请求
            └─ signed-fetch：改写路径到 /api/v2/chat/completions、归一化请求体、
               SDK-HMAC-SHA256 签名（AK/SK）、加 Agent-Type / Session-Id 等头
                 └─ POST https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
                      └─ SSE 流回：思考 reasoning_content / 正文 / 工具调用 / usage
                           （HTTP 200 的内联错误帧会被转成带原因的异常）
```

## 使用

```bash
pi                                                    # 进 TUI；Ctrl+L → 「华为码道 CodeArts」
pi --provider codearts --model glm-5.3-flash --thinking low --print "你好"
pi --list-models | grep codearts
```

| 命令 | 作用 |
|---|---|
| `/codearts-usage` | 积分余额 / 总量 / 已用 / 即将到期 / 构成（基础·赠送·按需）/ 签到状态 / 各模型倍率与档位 |
| `/codearts-checkin` | 领取今日签到积分（先确认；claim → confirm 两步） |
| `/codearts-models` | 刷新模型目录（上下文 / 输出上限 / 档位 / 倍率 / 视觉） |
| `/codearts-doctor` | 逐级自检：凭据 → 身份 → 目录 → 积分 |

**状态栏**：当前模型是码道时显示 `码道 积分 剩余/总量`；切到别的 provider 自动消失。每次回复后最多 60 秒刷一次。

**思考档位**：按网关为每个模型声明的档位开放（例如 GLM-5.2 只有 high/max，glm-5.3 有 low/high/max，
openpangu 未声明 → 当作非推理模型、不发 `reasoning_effort`）。你 settings 里的 `defaultThinkingLevel: low`
在只有 high/max 的模型上会被 pi 夹到 `high`。

**模型名**：`显示名 · 模型ID 倍率`，例如 `GLM-5.3 · glm-5.3 0.79x`。便宜且快：`glm-5.3-flash`（0.08x）、
`openpangu-2.1-pro`（0.07x）；最贵：`kimi-k3`（2.38x）。

## 凭证

- 读取顺序：环境变量 `CODEARTS_CLI_AK` / `CODEARTS_CLI_SK` → `~/.pi/agent/codearts.credentials.json`
  （`{"accessKey":"…","secretKey":"…"}`，0600；路径可用 `PI_CODEARTS_CREDENTIALS` 覆盖）。
- AK/SK 在华为云控制台「我的凭证 → 访问密钥」创建。**它是长期云凭证，等同于账号**：不要提交、不要外传。
  想降风险可建一个 IAM 子用户再建 AK/SK（码道是否认子用户身份未验证）。
- 项目目录里没有任何密钥；`~/private/` 下的 CSV 是你自己的备份，扩展不读它。

## 缓存与非交互模式

pi 的 `--print` / `--list-models` / 子代理模式不联网刷新模型目录，扩展启动时读
`~/.pi/agent/cache/pi-codearts/catalog.json`（TUI 启动和每次 Ctrl+L 会刷新并写回）。
华为上下架模型后进一次 TUI，或跑 `node scripts/catalog.mjs`。

## 请求体归一化（signed-fetch.ts，规则来自 DSH 插件实测）

- `developer` 角色 → `system`（网关对 developer 报的错误文案极具误导性）
- `max_tokens` 夹到 ≤ 131072（393216 会得到空流），缺省 32768；思考与正文共用这份预算，太小会"只思考不回答"
- `tool_choice` 只保留字符串形式（对象形式会被判参数非法），有 tools 时缺省 `auto`
- `reasoning_effort` 为 `off`/`none` 时不传
- 丢掉网关不认识的字段：`store` `metadata` `parallel_tool_calls` `stream_options` `max_completion_tokens` 等

## 已验证（2026-11-23）

| 项 | 结果 |
|---|---|
| IAM AK/SK 直连（身份 / 目录 / 积分） | ✓ 1 秒内返回 |
| 对话（流式 + 思考 + usage 入账） | ✓ `391` / `408` / `221`，5–7 秒 |
| 工具调用往返（read → bash → 结果回传） | ✓ |
| 思考档位 `low` / `high` / `max` | ✓；未声明的档位会被 pi 就近夹取（low→high） |
| 无档位声明的模型（openpangu） | ✓ 不发 `reasoning_effort` |
| 图片输入（64×64 PNG，左右两色） | ✓ 回答"红色，蓝色" |
| 错误凭证 | ✓ 显示「AK/SK 校验未通过 + 核对方法」，不崩 |
| 无权限模型 | ✓ 显示 `TM.000010051` + 「不在套餐内」提示 |
| 首次运行无缓存（任意模式） | ✓ 工厂内 1.3 秒拉目录并写缓存 |
| 离线（`PI_OFFLINE=1` + 无缓存） | ✓ 降级为 0 模型，不崩溃 |
| 4 个命令（RPC 模式逐条执行） | ✓ |
| 默认不写 stderr / console（避免画花 TUI） | ✓ |

未验证：签到 `claim → confirm` 的 confirm 步骤（今天已确认过，无法重放）；并发子代理打满 3 会话时的排队表现。

## 可调环境变量

| 变量 | 作用 |
|---|---|
| `PI_CODEARTS_GATEWAY` | 覆盖网关地址（默认 `https://snap-access.cn-north-4.myhuaweicloud.com`，必须是 https） |
| `PI_CODEARTS_CREDENTIALS` | 覆盖凭证文件路径（默认 `~/.pi/agent/codearts.credentials.json`） |
| `PI_CODEARTS_CACHE` | 覆盖目录缓存路径（默认 `~/.pi/agent/cache/pi-codearts/catalog.json`） |
| `PI_CODEARTS_DEBUG` | 设为任意值则把扩展日志打到 stderr（默认只进内存，`/codearts-doctor` 末尾可见最近 30 条） |
| `CODEARTS_CLI_AK` / `CODEARTS_CLI_SK` | 直接给 AK/SK（与 dsh-connect-codearts 同名，优先于文件） |

## 已知边界

- **并发**：华为单账号约 3 个并发会话，释放较慢。并行子代理同时打码道会排队或报 `TM.00001041`（已附中文提示）。
- **思考与正文共享 `max_tokens`**：档位越高，思考占用越多；`max_tokens` 太小会出现「只思考、正文为空、`finish_reason: length`」。
- **积分计费**：pi 的 USD 成本表填 0（码道按积分计费，无法折算）；真实消耗看 `/codearts-usage` 与状态栏。
- **没有 `off` 档**：声明了档位的模型都「始终思考」（上游明确拒绝关闭），因此 pi 里这些模型没有关闭思考的选项。

## 排障

| 现象 | 处理 |
|---|---|
| `/codearts-doctor` 在「身份」处失败 | AK/SK 复制不全、密钥被禁用、或该账号未开通码道 |
| 对话报 `码道 TM.000010051 您当前无权调用该模型` | 该模型不在你的套餐里，换一个 |
| 对话报 `InferHub.ModelArts.81001 … 请使用 low、high 或 max` | 不应出现（档位按模型声明开放）；若出现说明网关改了档位表，`/codearts-models` 刷新 |
| 回复为空 / `finish_reason: length` | 思考吃光了 `max_tokens`，提高档位或换模型 |
| Ctrl+L 里没有码道模型 | `pi --list-models \| grep codearts`；为空则进一次 TUI 或 `node scripts/catalog.mjs` |
| 想换账号 | 改 `~/.pi/agent/codearts.credentials.json`，`/reload` |
| 状态栏不显示积分 | 确认 `settings.json` 的 `powerline.preset` 含 `extension_statuses`（`default` 预设自带），且 `hiddenExtensionStatusKeys` 里没有 `codearts` |
| 想深挖日志 | `PI_CODEARTS_DEBUG=1 pi`，或看 `/codearts-doctor` 末尾的最近日志 |

## 更新协议层

```bash
cd ~/projects/pi-codearts
git clone --depth 1 https://github.com/anheon/dsh-connect-codearts /tmp/dsh-cc
cp /tmp/dsh-cc/src/protocol/*.ts vendor/dsh-connect-codearts/protocol/
cp /tmp/dsh-cc/src/upstream.ts vendor/dsh-connect-codearts/
node scripts/doctor.mjs && node scripts/rpc-smoke.py   # 回归
```

## 卸载

```bash
rm ~/.pi/agent/extensions/pi-codearts
rm -rf ~/.pi/agent/cache/pi-codearts ~/.pi/agent/codearts.credentials.json
rm -rf ~/projects/pi-codearts
```
