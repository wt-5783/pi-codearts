// 拉取模型目录并写入 pi 用的缓存；打印每个模型的上下文 / 输出上限 / 档位 / 倍率。
const { creds, catalog } = await (await import('./_shared.mjs')).load()
const r = creds.resolveCredentials()
if (!r.ok) { console.error(r.reason, r.attempts); process.exit(1) }
const entries = await catalog.fetchCatalog(r.credentials)
catalog.writeCatalogCache(entries)
console.log(`模型 ${entries.length} 个，已缓存到 ${catalog.catalogPath()}`)
for (const e of entries) {
  const ctx = e.contextWindow > 0 ? `${Math.round(e.contextWindow / 1024)}K` : '—'
  const max = e.maxTokens > 0 ? `${Math.round(e.maxTokens / 1024)}K` : '—'
  const st = e.strengths.length ? `  档位 ${e.strengths.join('/')}${e.defaultStrength ? `（默认 ${e.defaultStrength}）` : ''}` : ''
  console.log(`  ${e.id.padEnd(26)} ${(e.ratioDisplay ?? '—').padEnd(7)} ctx ${ctx.padEnd(5)} out ${max.padEnd(5)}${e.supportsImages ? ' 眼睛' : ''}${st}`)
}
