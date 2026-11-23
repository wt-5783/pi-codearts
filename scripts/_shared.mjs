// 三个脚本共用：加载 src 里的 TS 模块（Node ≥ 22.19 的 type stripping）。
export const load = async () => {
  const creds = await import('../src/credentials.ts')
  const status = await import('../src/status.ts')
  const catalog = await import('../src/catalog.ts')
  return { creds, status, catalog }
}
