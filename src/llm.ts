import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

const Provider = z.object({
  protocol: z.enum(['anthropic', 'openai']),
  baseUrl: z.string().url(),
  auth: z.enum(['x-api-key', 'bearer', 'both']),
  keyRef: z.object({ service: z.string(), account: z.string() }),
})
const Route = z.object({ provider: z.string(), model: z.string() })
const Image = z.object({ baseUrl: z.string().url(), model: z.string(), keyEnv: z.string(), maxCostUsd: z.string().regex(/^\d+(\.\d+)?$/) })
const Models = z.object({
  providers: z.record(z.string(), Provider),
  text: Route.optional(),
  vision: Route.optional(),
  image: Image.optional(),
  tasks: z.record(z.string(), Route).default({}),
})

export type ModelsConfig = z.infer<typeof Models>
export type Resolved = { name: string; provider: z.infer<typeof Provider>; model: string }

export class LlmError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message)
  }
}

export function loadModels(path: string): ModelsConfig {
  return Models.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/** The task's own route if it has one, else the default text model. */
export function resolve(config: ModelsConfig, task: string): Resolved {
  const route = config.tasks[task] ?? config.text
  if (!route) throw new LlmError('没有配置文本模型：在 config/models.json 里设置 text')
  const provider = config.providers[route.provider]
  if (!provider) throw new LlmError(`模型服务 ${route.provider} 没有配置`)
  return { name: route.provider, provider, model: route.model }
}

export function readKey(ref: { service: string; account: string }): string {
  const result = spawnSync('security', ['find-generic-password', '-s', ref.service, '-a', ref.account, '-w'], { encoding: 'utf8' })
  const key = result.stdout?.trim()
  if (result.status !== 0 || !key) throw new LlmError(`钥匙串里没有 ${ref.service}/${ref.account} 的密钥`)
  return key
}

export type Completion = { text: string; tokensIn: number; tokensOut: number; ms: number }

function headers(provider: Resolved['provider'], key: string): Record<string, string> {
  const auth: Record<string, string> = {}
  if (provider.auth !== 'bearer') auth['x-api-key'] = key
  if (provider.auth !== 'x-api-key') auth.authorization = `Bearer ${key}`
  return { 'content-type': 'application/json', ...auth, ...(provider.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) }
}

export type Picture = { mime: string; base64: string }

/** An Anthropic answer read as server-sent events, `onText` getting everything written so far at each piece. */
export async function streamed(response: Response, url: string, maxTokens: number, started: number, onText: (text: string) => void): Promise<Completion> {
  let text = '', buffer = '', tokensIn = 0, tokensOut = 0, stop: string | undefined
  const decoder = new TextDecoder()
  const take = (line: string) => {
    if (!line.startsWith('data:')) return
    const event = JSON.parse(line.slice(5))
    if (event.type === 'error') throw new LlmError(`${url} 流里报错：${JSON.stringify(event.error ?? event).slice(0, 300)}`, true)
    if (event.type === 'message_start') tokensIn = event.message?.usage?.input_tokens ?? 0
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text += event.delta.text
    if (event.type === 'message_delta') {
      stop = event.delta?.stop_reason ?? stop
      tokensIn = event.usage?.input_tokens || tokensIn
      tokensOut = event.usage?.output_tokens ?? tokensOut
    }
  }
  try {
    for await (const chunk of response.body!) {
      const lines = (buffer + decoder.decode(chunk, { stream: true })).split('\n')
      buffer = lines.pop()!
      const before = text.length
      lines.forEach(take)
      if (text.length > before) onText(text)
    }
    take(buffer)
  } catch (error) {
    if (error instanceof LlmError) throw error
    throw new LlmError(`读 ${url} 的流中断：${error instanceof Error ? error.message : String(error)}`, true)
  }
  if (stop === 'max_tokens') throw new LlmError(`输出写到 max_tokens（${maxTokens}）被截断`)
  if (!stop) throw new LlmError(`${url} 的流没写完就断了`, true)
  if (!text.trim()) throw new LlmError('模型返回了空内容', true)
  return { text, tokensIn, tokensOut, ms: Date.now() - started }
}

async function once(target: Resolved, key: string, system: string, user: string, maxTokens: number, timeoutMs: number, images: Picture[], onText?: (text: string) => void): Promise<Completion> {
  const base = target.provider.baseUrl.replace(/\/$/, '')
  const anthropic = target.provider.protocol === 'anthropic'
  const url = anthropic ? `${base}/v1/messages` : `${base}/v1/chat/completions`
  // Qiniu's gateway returns its cached answer for a byte-identical request (2026-10-27: 0.2 s, same text),
  // so a rewrite or a retry would come back unchanged. A per-call id keeps every call a real generation.
  const nonce = `yanxiang-${randomUUID()}`
  // Pictures go before the text, each as its own block (the vision model reads them in order).
  const content = !images.length ? user : anthropic
    ? [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.base64 } })), { type: 'text', text: user }]
    : [...images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } })), { type: 'text', text: user }]
  const body = anthropic
    ? { model: target.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }], metadata: { user_id: nonce }, ...(onText ? { stream: true } : {}) }
    : { model: target.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content }], user: nonce }
  const started = Date.now()
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: headers(target.provider, key), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new LlmError(`请求 ${url} 失败：${error instanceof Error ? error.message : String(error)}`, true)
  }
  if (response.ok && anthropic && onText) return streamed(response, url, maxTokens, started, onText)
  const raw = await response.text()
  if (!response.ok) throw new LlmError(`${url} 返回 ${response.status}：${raw.slice(0, 300)}`, response.status === 429 || response.status >= 500)
  const data = JSON.parse(raw)
  const ms = Date.now() - started
  if (anthropic) {
    if (data.stop_reason === 'max_tokens') throw new LlmError(`输出写到 max_tokens（${maxTokens}）被截断`)
    const text = (data.content ?? []).filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('')
    if (!text.trim()) throw new LlmError('模型返回了空内容', true)
    return { text, tokensIn: data.usage?.input_tokens ?? 0, tokensOut: data.usage?.output_tokens ?? 0, ms }
  }
  const choice = data.choices?.[0]
  if (choice?.finish_reason === 'length') throw new LlmError(`输出写到 max_tokens（${maxTokens}）被截断`)
  const text = choice?.message?.content ?? ''
  if (!text.trim()) throw new LlmError('模型返回了空内容', true)
  // The OpenAI protocol is not streamed (untried against a gateway); the whole answer shows at once.
  onText?.(text)
  return { text, tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0, ms }
}

/**
 * One model call; network errors, 429 and 5xx are retried up to three times. With `onText` the answer
 * streams, and `onText` gets everything written so far; a retry starts again from empty.
 */
export async function complete(target: Resolved, system: string, user: string, options: { maxTokens?: number; timeoutMs?: number; images?: Picture[]; onText?: (text: string) => void } = {}): Promise<Completion> {
  const key = readKey(target.provider.keyRef)
  const delays = [2000, 4000, 8000]
  for (let attempt = 0; ; attempt++) {
    try {
      options.onText?.('')
      return await once(target, key, system, user, options.maxTokens ?? 8000, options.timeoutMs ?? 600_000, options.images ?? [], options.onText)
    } catch (error) {
      if (!(error instanceof LlmError) || !error.retryable || attempt >= delays.length) throw error
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
}
