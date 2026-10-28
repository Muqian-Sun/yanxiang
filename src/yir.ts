import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

/** Yir's Cloudflare refuses a default client User-Agent with error 1010 (manju). */
const USER_AGENT = 'yanxiang/0.1'
const OPERATION = 'generate_image'
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const UPLOAD_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
/** Design 06: poll every 3 s, give up after 10 minutes. */
export const POLL_MS = 3000
const POLL_LIMIT_MS = 600_000
/** How long an uploaded reference may take to become ready; a guess carried over from manju. */
const FILE_READY_MS = 300_000
/** A request that hangs must fail rather than stall its job (M1 saw one hang past 6 minutes); guesses. */
const API_TIMEOUT_MS = 60_000
const TRANSFER_TIMEOUT_MS = 300_000

/** fetch with a deadline; a timeout or a dropped connection becomes a retryable ImageError naming what failed. */
async function send(what: string, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? `${timeoutMs / 1000} 秒没有响应` : error instanceof Error ? error.message : String(error)
    throw new ImageError(`${what}失败：${reason}`, true)
  }
}

export type ImageSettings = { baseUrl: string; model: string; keyEnv: string; maxCostUsd: string }
type Contract = { parameters?: Array<{ name: string; values?: unknown[] }>; input_constraints?: Record<string, { max_references?: number }> }
type ErrorBody = { code?: string; message?: string; retryable?: boolean }

export class ImageError extends Error {
  constructor(message: string, readonly retryable = false, readonly moderated = false) {
    super(message)
  }
}

export type Submitted = { providerJob: string; quotedUsd: number }
export type ImageClient = ReturnType<typeof yir>

export type ImageResult = { bytes: Uint8Array; ext: string; quotedUsd: number; providerJob: string }

/**
 * GPT Image through Yir's Standard API (design 06; protocol from manju's adapter):
 * read the model's contract, quote and refuse what costs more than the cap, submit
 * with an Idempotency-Key derived from our job id and the request, poll, download.
 * A parameter the contract does not declare is refused before anything is paid.
 * References are uploaded through the Files API, keyed on their content so a re-upload is free.
 */
export function yir(settings: ImageSettings, timeouts: { api?: number; transfer?: number } = {}) {
  const apiTimeout = timeouts.api ?? API_TIMEOUT_MS
  const transferTimeout = timeouts.transfer ?? TRANSFER_TIMEOUT_MS
  const key = process.env[settings.keyEnv]?.trim()
  if (!key) throw new ImageError(`环境变量 ${settings.keyEnv} 没有设置，取不到 Yir 的密钥`)
  const base = settings.baseUrl.replace(/\/$/, '')

  async function call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const response = await send(`Yir ${path} `, `${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'user-agent': USER_AGENT, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }, apiTimeout)
    const text = await response.text()
    if (!response.ok) {
      let error: ErrorBody = {}
      try {
        error = (JSON.parse(text) as { error?: ErrorBody }).error ?? {}
      } catch {}
      throw new ImageError(`Yir ${path} 返回 ${response.status}：${error.code ?? ''} ${error.message ?? text.slice(0, 200)}`.trim(), error.retryable ?? (response.status === 429 || response.status >= 500))
    }
    return (text ? JSON.parse(text) : {}) as T
  }

  async function contract(): Promise<Contract> {
    const document = await call<{ models?: Array<{ id: string; aliases?: string[]; operations?: Array<Contract & { operation: string }> }> }>('GET', '/v1/models?include=parameters')
    const entry = document.models?.find(m => m.id === settings.model || m.aliases?.includes(settings.model))
    const operation = entry?.operations?.find(o => o.operation === OPERATION)
    if (!operation) throw new ImageError(`Yir 的模型 ${settings.model} 没有 ${OPERATION} 合同`)
    return operation
  }

  // Two jobs with the same reference (a portrait's three-view and close-up) must not upload it at
  // the same moment under the same key: Yir's storage answered 500 to the second (M1, 2026-10-27).
  // A file that did upload stays for this process, so a later picture does not register it again.
  const uploaded = new Map<string, Promise<string>>()
  function upload(path: string): Promise<string> {
    const pending = uploaded.get(path)
    if (pending) return pending
    const promise = uploadOnce(path)
    uploaded.set(path, promise)
    void promise.catch(() => {
      if (uploaded.get(path) === promise) uploaded.delete(path)
    })
    return promise
  }

  async function uploadOnce(path: string): Promise<string> {
    const content = readFileSync(path)
    const mediaType = UPLOAD_TYPES[extname(path).toLowerCase()]
    if (!mediaType) throw new ImageError(`参考图 ${path} 不是 PNG、JPEG 或 WebP`)
    const body = { files: [{ name: basename(path), media_type: mediaType, size: content.length }] }
    // Yir refuses a reused key whose body differs, and the body carries the name.
    const key = `yanxiang-file-${createHash('sha256').update(content).digest('hex').slice(0, 32)}-${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16)}`
    // Yir stores a 503 against this key and replays it on every later try (the style reference, 2026-10-28).
    // The same body with a new key is accepted, so a retryable refusal here is asked once more.
    const plan = await postFile(body, key).catch(error => {
      if (!(error instanceof ImageError) || !error.retryable) throw error
      return postFile(body, `${key}-${Date.now().toString(36)}`)
    })
    const file = plan.files[0]!
    if (file.status === 'pending_upload') {
      let offset = 0
      for (const part of [...(file.upload?.parts ?? [])].sort((a, b) => a.part_number - b.part_number)) {
        const put = await send('参考图上传', part.url, { method: 'PUT', body: content.subarray(offset, offset + part.size), headers: { 'content-type': mediaType, 'user-agent': USER_AGENT } }, transferTimeout)
        if (!put.ok) throw new ImageError(`参考图上传返回 ${put.status}`, put.status >= 500)
        offset += part.size
      }
      if (offset !== content.length) throw new ImageError('上传分片没有盖住整个文件')
      await call('POST', `/v1/files/${file.id}/complete`, {}).catch(error => {
        if (!(error instanceof ImageError) || !error.message.includes('FILE_NOT_READY')) throw error
      })
    }
    const deadline = Date.now() + FILE_READY_MS
    for (;;) {
      const { status } = await call<{ status: string }>('GET', `/v1/files/${file.id}`)
      if (status === 'ready') return file.id
      if (status === 'failed' || status === 'expired') throw new ImageError(`参考图上传 ${status}`)
      if (Date.now() > deadline) throw new ImageError('参考图迟迟没有就绪', true)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }

  function postFile(body: { files: Array<{ name: string; media_type: string; size: number }> }, idempotencyKey: string) {
    return call<{ files: Array<{ id: string; status: string; upload?: { parts: Array<{ part_number: number; size: number; url: string }> } }> }>('POST', '/v1/files', body, idempotencyKey)
  }

  /** Quote, refuse what costs more than the cap, submit. The same key and body get the same Yir job back. */
  async function submit(idempotencyKey: string, prompt: string, params: Record<string, unknown>, references: string[] = []): Promise<Submitted> {
    const operation = await contract()
    const mode = references.length ? 'image' : 'text'
    const limit = operation.input_constraints?.[mode]?.max_references ?? (mode === 'text' ? 0 : Infinity)
    if (references.length > limit) throw new ImageError(`参考图 ${references.length} 张，超过合同的 ${limit} 张`)
    const declared = new Map((operation.parameters ?? []).map(p => [p.name, p]))
    const accepted = Object.entries(params).filter(([name, value]) => declared.has(name) && (!declared.get(name)!.values || declared.get(name)!.values!.includes(value)))
    const dropped = Object.keys(params).filter(name => !accepted.some(([kept]) => kept === name))
    if (dropped.length) throw new ImageError(`合同里没有这些参数或取值，没有提交：${dropped.join('、')}`)
    const files: string[] = []
    for (const path of references) files.push(await upload(path))
    const input = { type: mode, prompt, ...(files.length ? { references: files.map(file_id => ({ role: 'reference_image', file_id })) } : {}) }
    const body = { model: settings.model, input, parameters: Object.fromEntries(accepted), max_cost: settings.maxCostUsd }
    const { max_cost: _cap, ...quoted } = body
    const quote = await call<{ supply?: { available?: boolean }; expected_amount?: string | number; primary?: { amount?: string | number } }>('POST', '/v1/images/quotes', quoted)
    if (!quote.supply?.available) throw new ImageError('Yir 现在没有能跑这个请求的通道', true)
    const quotedUsd = Number(quote.expected_amount ?? quote.primary?.amount ?? 0)
    if (quotedUsd > Number(settings.maxCostUsd)) throw new ImageError(`报价 ${quotedUsd} 美元超过单张上限 ${settings.maxCostUsd} 美元，没有提交`)
    const { id: providerJob } = await call<{ id: string }>('POST', '/v1/images/generations', body, idempotencyKey)
    return { providerJob, quotedUsd }
  }

  /** One look at the job: still running, or done; a failed or cancelled job throws (moderated when Yir says so). */
  async function poll(providerJob: string): Promise<'pending' | 'succeeded'> {
    const { status } = await call<{ status?: string }>('GET', `/v1/jobs/${providerJob}/status`)
    if (status === 'succeeded') return 'succeeded'
    if (status === 'failed' || status === 'cancelled') {
      const job = await call<{ error?: ErrorBody }>('GET', `/v1/jobs/${providerJob}`)
      const text = `${job.error?.code ?? ''} ${job.error?.message ?? ''}`.trim()
      throw new ImageError(`Yir 任务${status === 'failed' ? '失败' : '被取消'}：${text}`, false, /safety|moderat|policy/i.test(text))
    }
    return 'pending'
  }

  async function download(providerJob: string): Promise<{ bytes: Uint8Array; mime: string }> {
    for (let attempt = 0; ; attempt++) {
      const job = await call<{ result?: { availability?: string; files?: Array<{ url: string; media_type?: string }> } }>('GET', `/v1/jobs/${providerJob}`)
      const file = job.result?.availability === 'available' ? job.result.files?.[0] : undefined
      if (!file) throw new ImageError('Yir 的结果已经取不到了')
      if (!file.url.startsWith('https://')) throw new ImageError('结果地址不是 HTTPS')
      const response = await send('下载结果', file.url, { headers: { 'user-agent': USER_AGENT } }, transferTimeout)
      // A signed URL may have expired: read the job again for a fresh one, once.
      if ([400, 403, 404].includes(response.status) && attempt === 0) continue
      if (!response.ok) throw new ImageError(`下载结果返回 ${response.status}`, response.status >= 500)
      return { bytes: new Uint8Array(await response.arrayBuffer()), mime: file.media_type && EXT[file.media_type] ? file.media_type : 'image/png' }
    }
  }

  async function wait(providerJob: string, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
    const deadline = Date.now() + POLL_LIMIT_MS
    while ((await poll(providerJob)) !== 'succeeded') {
      if (Date.now() > deadline) throw new ImageError(`Yir 任务 ${providerJob} 十分钟没有完成`, true)
      await sleep(POLL_MS)
    }
  }

  return {
    submit,
    poll,
    download,
    wait,
    /** The whole round trip, for one-off scripts. `references` are local image files; with any, this is an edit of them. */
    async generate(jobId: string, prompt: string, params: Record<string, unknown>, references: string[] = []): Promise<ImageResult> {
      const key = `yanxiang-${jobId}-${createHash('sha256').update(JSON.stringify({ prompt, params, references })).digest('hex').slice(0, 24)}`
      const { providerJob, quotedUsd } = await submit(key, prompt, params, references)
      await wait(providerJob)
      const { bytes, mime } = await download(providerJob)
      return { bytes, ext: EXT[mime]!, quotedUsd, providerJob }
    },
  }
}
