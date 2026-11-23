# 码道网关协议

插件通过 HTTPS 访问配置的网关。请求使用 `SDK-HMAC-SHA256` 签名。规范化路径、查询串、签名头和实际发送的请求体共同参与签名。

| 用途 | 请求 |
| --- | --- |
| 获取模型 | `GET /v1/model/builtin` |
| 获取思考档位 | `POST /v1/model/thinking-variants` |
| 对话流 | `POST /api/v2/chat/completions` |
| 读取账号 | `GET /snap-manager/v1/current/user` |
| 读取积分 | `GET /snap-manager/v1/statistics/plugin` |
| 读取福利 | `GET /v1/ops/delivery?channel=IDE` |
| 领取福利 | `POST /v1/ops/claim` |

对话使用 JSON 请求和 SSE 增量。插件将宿主 `developer` 角色映射为 `system`，按上游索引组装工具调用，并识别流里的业务错误。后台签到选择活动列表中可领取的 `USER_LOGIN` 条目，按本地日期记录成功结果。
