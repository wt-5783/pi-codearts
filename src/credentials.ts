/**
 * 华为云 IAM 访问密钥（AK/SK）的读取。
 *
 * 读取顺序（第一个完整可用的即采用）：
 *   1. 环境变量 CODEARTS_CLI_AK / CODEARTS_CLI_SK（与 dsh-connect-codearts 同名，方便共用）
 *   2. 文件 ~/.pi/agent/codearts.credentials.json   {"accessKey":"…","secretKey":"…"}  （建议 0600）
 *      路径可用环境变量 PI_CODEARTS_CREDENTIALS 覆盖。
 *
 * AK/SK 是长期云凭证：不要提交进仓库、不要贴进对话；泄露等于整个华为云账号泄露。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodeArtsCredentials } from '../vendor/dsh-connect-codearts/protocol/sign.ts'

export const ENV_ACCESS_KEY = 'CODEARTS_CLI_AK'
export const ENV_SECRET_KEY = 'CODEARTS_CLI_SK'

export const credentialsFilePath = (): string =>
  process.env['PI_CODEARTS_CREDENTIALS'] ?? join(homedir(), '.pi', 'agent', 'codearts.credentials.json')

export type CredentialResolution =
  | { readonly ok: true; readonly credentials: CodeArtsCredentials; readonly source: string }
  | { readonly ok: false; readonly reason: string; readonly attempts: readonly string[] }

const readJsonCredentials = (path: string): CodeArtsCredentials | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const accessKey = typeof record['accessKey'] === 'string' ? record['accessKey'].trim() : ''
  const secretKey = typeof record['secretKey'] === 'string' ? record['secretKey'].trim() : ''
  if (accessKey === '' || secretKey === '') return undefined
  return { accessKey, secretKey }
}

export const resolveCredentials = (): CredentialResolution => {
  const attempts: string[] = []

  const envAk = process.env[ENV_ACCESS_KEY]?.trim() ?? ''
  const envSk = process.env[ENV_SECRET_KEY]?.trim() ?? ''
  if (envAk !== '' && envSk !== '') {
    return { ok: true, credentials: { accessKey: envAk, secretKey: envSk }, source: `环境变量 ${ENV_ACCESS_KEY}/${ENV_SECRET_KEY}` }
  }
  attempts.push(envAk === '' && envSk === '' ? `· 环境变量 ${ENV_ACCESS_KEY}/${ENV_SECRET_KEY}：未设置` : `✗ 环境变量：${ENV_ACCESS_KEY} 与 ${ENV_SECRET_KEY} 只设了一个`)

  const path = credentialsFilePath()
  let exists = true
  try {
    readFileSync(path, 'utf8')
  } catch {
    exists = false
  }
  if (!exists) {
    attempts.push(`· 文件 ${path}：不存在`)
  } else {
    const loaded = readJsonCredentials(path)
    if (loaded !== undefined) return { ok: true, credentials: loaded, source: path }
    attempts.push(`✗ 文件 ${path}：不是 {"accessKey":"…","secretKey":"…"} 格式`)
  }

  return { ok: false, reason: '没有可用的华为云 IAM 访问密钥。', attempts }
}

export const requireCredentials = (): CodeArtsCredentials => {
  const resolved = resolveCredentials()
  if (resolved.ok) return resolved.credentials
  throw new Error(
    [
      resolved.reason,
      ...resolved.attempts,
      '',
      '处理：华为云控制台 → 右上角头像 → 我的凭证 → 访问密钥 → 新增访问密钥，然后',
      `  写入 ${credentialsFilePath()}（内容 {"accessKey":"…","secretKey":"…"}，chmod 600），或`,
      `  export ${ENV_ACCESS_KEY}=… ${ENV_SECRET_KEY}=…`,
    ].join('\n'),
  )
}

/** 只露前 4 后 4，用于日志和诊断输出。 */
export const maskAccessKey = (accessKey: string): string =>
  accessKey.length <= 8 ? '****' : `${accessKey.slice(0, 4)}…${accessKey.slice(-4)}`
