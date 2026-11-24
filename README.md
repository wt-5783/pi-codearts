# pi-codearts — 华为云码道 CodeArts 作为 pi 的模型 provider

> **改编自（adapted from）[anheon/dsh-connect-codearts](https://github.com/anheon/dsh-connect-codearts)**（MIT License）
> ——那是 DeepSeek Harness（DSH）的码道插件；本项目把它移植为 [pi coding agent](https://github.com/earendil-works/pi) 的扩展。
> 协议层（`vendor/dsh-connect-codearts/`）原样复用，其余为针对 pi 的重新实现。详见[来源与致谢](#来源与致谢attribution)。

把华为云码道（CodeArts）代码智能体套餐里的模型接进 pi，
和 GLM / Codex 等其他 provider 并列，**Ctrl+L 无感切换**；显示剩余积分、各模型积分倍率，支持每日签到。

- **直连**：进程内用 IAM 长期 AK/SK 对每个请求做 `SDK-HMAC-SHA256` 签名，直达
  `https://snap-access.cn-north-4.myhuaweicloud.com`。不开端口、不起子进程、不刷新 token、不用重新登录。
- **复用 pi 的成熟实现**：消息转换、工具调用、思考内容、用量统计、中断，全部由 pi 自带的
  `openai-completions` 实现处理；本项目只提供「带签名的 fetch」和模型目录。
- **协议层改编自 [dsh-connect-codearts](https://github.com/anheon/dsh-connect-codearts)**（MIT），
  原样放在 `vendor/`，零 DSH 依赖，只 import Node 内置模块。

## 目录

```
pi-codearts/
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
└── tsconfig.json         编辑器类型检查用（paths 指向本机全局安装的 pi，换机器按 `npm root -g` 调整）
```

## 安装

前提：Node.js ≥ 22.19、pi coding agent，以及华为云 IAM 访问密钥（控制台「我的凭证 → 访问密钥」）。

### 1. 安装扩展（两种方式二选一，不要同时用，否则 provider 会被注册两次）

```bash
# 方式一：让 pi 从 GitHub 拉取（推荐，pi 会钉住 tag）
pi install git:github.com/wt-5783/pi-codearts@v0.1.0

# 方式二：克隆后用符号链接（适合改源码：改完 /reload 即生效，无需构建）
git clone https://github.com/wt-5783/pi-codearts ~/projects/pi-codearts
ln -s ~/projects/pi-codearts ~/.pi/agent/extensions/pi-codearts
```

### 2. 配置凭证并自检

写入 `~/.pi/agent/codearts.credentials.json`（推荐，`0600` 权限）：

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/codearts.credentials.json << 'EOF'
{"accessKey":"你的AK","secretKey":"你的SK"}
EOF
chmod 600 ~/.pi/agent/codearts.credentials.json
```

或者通过环境变量传入：

```bash
export CODEARTS_CLI_AK="你的AK"
export CODEARTS_CLI_SK="你的SK"
```

配置完成后，启动 `pi` 执行 `/codearts-doctor`（或运行 `node scripts/doctor.mjs`）自检。

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
openpangu 未声明 → 当作非推理模型、不发 `reasoning_effort`）。若 `settings.json` 中配置的
`defaultThinkingLevel`（如 `low`）不在当前模型支持的档位内（如仅支持 `high/max`），pi 会自动夹取到最接近的可用档位（`high`）。

**模型名**：`显示名 · 模型ID 倍率`，例如 `GLM-5.3 · glm-5.3 0.79x`。以下倍率为示例，具体以 `/codearts-models` 实时返回为准（如 `glm-5.3-flash` 约 `0.08x`、`openpangu-2.1-pro` 约 `0.07x`、`kimi-k3` 约 `2.38x`）。

## 凭证

- 读取顺序：环境变量 `CODEARTS_CLI_AK` / `CODEARTS_CLI_SK` → `~/.pi/agent/codearts.credentials.json`
  （`{"accessKey":"…","secretKey":"…"}`，0600；路径可用 `PI_CODEARTS_CREDENTIALS` 覆盖）。
- AK/SK 在华为云控制台「我的凭证 → 访问密钥」创建。**它是长期云凭证，等同于账号**：不要提交、不要外传。
  想降风险可建一个 IAM 子用户再建 AK/SK（码道是否认子用户身份未验证）。
- 项目目录里不保存任何密钥，扩展也不会读取其他位置的个人备份文件。

## 缓存与非交互模式

pi 的 `--print` / `--list-models` / 子代理模式在已有缓存时不联网刷新模型目录，扩展启动时直接读取
`~/.pi/agent/cache/pi-codearts/catalog.json`（仅首次无缓存且未设 `PI_OFFLINE` 时会在初始化阶段拉取一次并写缓存；TUI 启动和每次 `Ctrl+L` 会自动刷新并写回）。
华为上下架模型后进一次 TUI（或按 `Ctrl+L`），也可以直接运行 `node scripts/catalog.mjs` 更新缓存。

## 请求体归一化（signed-fetch.ts，规则来自 DSH 插件实测）

- `developer` 角色 → `system`（网关对 developer 报的错误文案极具误导性）
- `max_tokens` 夹到 ≤ 131072（393216 会得到空流），缺省 32768；思考与正文共用这份预算，太小会"只思考不回答"
- `tool_choice` 只保留字符串形式（对象形式会被判参数非法），有 tools 时缺省 `auto`
- `reasoning_effort` 为 `off`/`none` 时不传
- 丢掉网关不认识的字段：`store` `metadata` `parallel_tool_calls` `stream_options` `max_completion_tokens` 等

## 实测状态（2026-11-23）

| 项 | 结果 |
|---|---|
| IAM AK/SK 直连（身份 / 目录 / 积分） | ✓ 1 秒内返回 |
| 对话（流式 + 思考 + usage 入账） | ✓ 正常返回并统计用量（约 5–7 秒） |
| 工具调用往返（read → bash → 结果回传） | ✓ |
| 思考档位 `low` / `high` / `max` | ✓；未声明的档位会被 pi 就近夹取（如 low → high） |
| 无档位声明的模型（openpangu） | ✓ 不发 `reasoning_effort` |
| 图片输入（64×64 PNG，左右两色） | ✓ 正确识别图像内容 |
| 错误凭证 | ✓ 显示「AK/SK 校验未通过 + 核对方法」，不崩 |
| 无权限模型 | ✓ 显示 `TM.000010051` + 「不在套餐内」提示 |
| 首次运行无缓存（任意模式） | ✓ 扩展初始化阶段约 1.3 秒拉目录并写缓存 |
| 离线（`PI_OFFLINE=1` + 无缓存） | ✓ 降级为 0 模型，不崩溃 |
| 4 个命令（RPC 模式逐条执行） | ✓ |
| 默认不写 stderr / console（避免画花 TUI） | ✓ |

未覆盖实测项：签到 `claim → confirm` 中的 `confirm` 步骤（按逆向记录实现，因测试账号当日已签到无法重放未确认流）；并发子代理打满 3 会话时的排队表现。

## 可调环境变量

| 变量 | 作用 |
|---|---|
| `PI_CODEARTS_GATEWAY` | 覆盖网关地址（默认 `https://snap-access.cn-north-4.myhuaweicloud.com`，必须是 https） |
| `PI_CODEARTS_CREDENTIALS` | 覆盖凭证文件路径（默认 `~/.pi/agent/codearts.credentials.json`） |
| `PI_CODEARTS_CACHE` | 覆盖目录缓存路径（默认 `~/.pi/agent/cache/pi-codearts/catalog.json`） |
| `PI_CODEARTS_DEBUG` | 只要有定义（包括 `0` 或空串，取消请 `unset`）就把扩展日志打到 stderr；默认只进内存，`/codearts-doctor` 末尾可见最近 30 条 |
| `CODEARTS_CLI_AK` / `CODEARTS_CLI_SK` | 直接给 AK/SK（与 dsh-connect-codearts 同名，优先于文件） |

## 已知边界

- **并发**：华为单账号约 3 个并发会话，释放较慢。并行子代理同时打码道会排队或报 `TM.00001041`（已附中文提示）。
- **思考与正文共享 `max_tokens`**：档位越高，思考占用越多；`max_tokens` 太小会出现「只思考、正文为空、`finish_reason: length`」。
- **积分计费**：pi 的 USD 成本表填 0（码道按积分计费，无法折算）；真实消耗看 `/codearts-usage` 与状态栏。
- **没有 `off` 档**：声明了档位的模型都「始终思考」（上游明确拒绝关闭），因此 pi 里这些模型没有关闭思考的选项。

## 来源与致谢（Attribution）

本项目**改编自** [anheon/dsh-connect-codearts](https://github.com/anheon/dsh-connect-codearts) v0.1.6（commit `ded7a7e`，MIT License）。
它不是 GitHub 意义上的 fork（宿主从 DSH 换成了 pi，代码库不同），而是移植 + 改编：

| 部分 | 来源 | 说明 |
|---|---|---|
| `vendor/dsh-connect-codearts/protocol/{types,sign,body,sse,errors}.ts`、`upstream.ts` | dsh-connect-codearts，**原样复制** | `SDK-HMAC-SHA256` 签名、请求体归一化规则、SSE 解析、错误分类、模型目录 / 思考档位 / 积分 / 福利接口客户端 |
| `src/signed-fetch.ts` 的归一化规则 | 依据其 `protocol/body.ts` 的实测结论重写 | 在 pi 的 `fetch` 层做同样的事 |
| 签到 `confirm` 端点 | [HITZY2002/codearts2api](https://github.com/HITZY2002/codearts2api) 的逆向记录 §6 | DSH 插件只封装了 `claim`；`confirm` 的路径与请求体来自该记录 |
| 其余（provider 注册、`streamSimple`、命令、状态栏、目录缓存） | 本项目新写 | 针对 pi 的扩展 API |

`vendor/` 内源码的注释还提到它们所参考的更上游实现（均为 MIT）：[XLNC-L/dsh-connect-madao](https://github.com/XLNC-L/dsh-connect-madao)、
Alanine-孔硕 的 dsh-huaweicloud-connect。原始许可见 `vendor/dsh-connect-codearts/LICENSE`，声明见 `THIRD_PARTY_NOTICES.md`。

## 免责声明

- 本项目为**非官方**实现，与华为云、DeepSeek Harness、pi 均无关联，也未获其背书。
- 接入方式基于对码道官方客户端协议的逆向，可能违反华为云服务条款；账号风险由使用者自行承担。
- IAM 访问密钥等同于你的华为云账号，请只放在 0600 权限的本地文件或环境变量中，不要提交进任何仓库。

## 排障

| 现象 | 处理 |
|---|---|
| `/codearts-doctor` 在「身份」处失败 | AK/SK 复制不全、密钥被禁用、或该账号未开通码道 |
| 对话报 `码道 TM.000010051 您当前无权调用该模型` | 该模型不在你的套餐里，换一个 |
| 对话报 `InferHub.ModelArts.81001 … 请使用 low、high 或 max` | 不应出现（档位按模型声明开放）；若出现说明网关改了档位表，运行 `/codearts-models` 刷新缓存后按 `Ctrl+L`（或 `/reload`） |
| 回复为空 / `finish_reason: length` | 思考吃光了 `max_tokens`，降低思考档位（如 `--thinking low`）或换非推理 / 更大输出上限的模型 |
| Ctrl+L 里没有码道模型 | `pi --list-models \| grep codearts`；为空则进一次 TUI 或 `node scripts/catalog.mjs` |
| 想换账号 | 改 `~/.pi/agent/codearts.credentials.json`（确保未设置 `CODEARTS_CLI_AK`/`SK` 覆盖它），然后 `/reload` |
| 状态栏不显示积分 | 确认 `settings.json` 的 `powerline.preset` 含 `extension_statuses`（`default` 预设自带），且 `hiddenExtensionStatusKeys` 里没有 `codearts` |
| 想深挖日志 | `PI_CODEARTS_DEBUG=1 pi`，或看 `/codearts-doctor` 末尾的最近日志 |

## 更新协议层

```bash
cd ~/projects/pi-codearts
git clone --depth 1 https://github.com/anheon/dsh-connect-codearts /tmp/dsh-cc
cp /tmp/dsh-cc/src/protocol/*.ts vendor/dsh-connect-codearts/protocol/
cp /tmp/dsh-cc/src/upstream.ts vendor/dsh-connect-codearts/
node scripts/doctor.mjs && python3 scripts/rpc-smoke.py   # 回归（也可用 npm run doctor && npm run rpc-smoke）
```

## 卸载

```bash
# 若通过方式一安装：
pi remove git:github.com/wt-5783/pi-codearts@v0.1.0

# 若通过方式二（克隆 + 符号链接）安装：
rm ~/.pi/agent/extensions/pi-codearts
rm -rf ~/projects/pi-codearts

# 清理本地缓存与凭证（两种方式通用）：
rm -rf ~/.pi/agent/cache/pi-codearts ~/.pi/agent/codearts.credentials.json
```
