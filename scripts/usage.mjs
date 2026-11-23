// 积分 / 签到 / 倍率报告（与 pi 里 /codearts-usage 相同）。只读接口，不消耗积分。
const { creds, status, catalog } = await (await import('./_shared.mjs')).load()
const r = creds.resolveCredentials()
if (!r.ok) { console.error(r.reason, r.attempts); process.exit(1) }
const snapshot = await status.fetchStatus(r.credentials)
console.log(status.formatUsageReport(snapshot, r.source, catalog.readCatalogCache()))
