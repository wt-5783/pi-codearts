// 逐级自检：凭据 → 身份 → 目录 → 积分。只读接口，不消耗积分。
const { creds, status } = await (await import('./_shared.mjs')).load()
console.log(await status.doctor(() => {
  const r = creds.resolveCredentials()
  if (!r.ok) throw new Error([r.reason, ...r.attempts].join('\n'))
  return { credentials: r.credentials, source: r.source }
}))
