import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { MODEL_INPUTS } from './workflow.js'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export class ComfyError extends Error {
  constructor(message: string, readonly code: 'offline' | 'missing' | 'rejected' | 'execution' | 'timeout' | 'output' | 'http') {
    super(message)
  }
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>
export type HistoryEntry = { status?: { status_str?: string; completed?: boolean; messages?: unknown[] }; outputs?: Record<string, Record<string, { filename: string; subfolder?: string; type?: string }[] | unknown>>; prompt?: unknown[] }
export type Saved = { filename: string; subfolder: string; type: string }

/** What the video jobs need from ComfyUI; the real one is HTTP, tests use a fake server. */
export interface VideoClient {
  stats(): Promise<{ gpu: string; vramFree: number }>
  preflight(graph: Graph): Promise<void>
  upload(folder: string, path: string, name: string): Promise<string>
  submit(graph: Graph): Promise<string>
  /** The finished or failed entry, or undefined while it is queued or running. */
  history(promptId: string): Promise<HistoryEntry | undefined>
  /** Whether a prompt is still in the queue (running or pending). */
  queued(promptId: string): Promise<boolean>
  /** A prompt submitted with this output prefix, found in the queue or history after a crash. */
  findByPrefix(prefix: string): Promise<string | undefined>
  download(saved: Saved): Promise<Uint8Array>
}

/** Design 07 五: only a loopback address (the SSH tunnel) is accepted, so a request never goes elsewhere. */
export function comfy(url: string): VideoClient {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || !LOOPBACK.has(parsed.hostname)) throw new ComfyError(`ComfyUI 地址必须是本机回环地址（SSH 隧道），现在是 ${url}`, 'http')
  const base = url.replace(/\/$/, '')
  const call = async (path: string, init?: RequestInit & { timeoutMs?: number }) => {
    try {
      return await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(init?.timeoutMs ?? 30_000) })
    } catch (error) {
      throw new ComfyError(`连不上 ComfyUI（${base}${path}）：${error instanceof Error ? error.message : String(error)}；GPU 开机、SSH 隧道和 ComfyUI 都起来了吗`, 'offline')
    }
  }
  const json = async (path: string, init?: RequestInit & { timeoutMs?: number }) => {
    const response = await call(path, init)
    const body = await response.text()
    if (!response.ok) throw new ComfyError(`ComfyUI ${path} 返回 ${response.status}：${body.slice(0, 500)}`, response.status === 400 ? 'rejected' : 'http')
    return JSON.parse(body)
  }
  const prefixOf = (prompt: unknown): string | undefined => {
    const graph = (Array.isArray(prompt) ? prompt[2] : undefined) as Graph | undefined
    const save = graph && Object.values(graph).find(n => n.class_type === 'SaveVideo')
    return save?.inputs.filename_prefix as string | undefined
  }

  return {
    async stats() {
      const data = await json('/system_stats', { timeoutMs: 5000 })
      const device = data.devices?.[0]
      return { gpu: String(device?.name ?? '?'), vramFree: Number(device?.vram_free ?? 0) }
    },

    async preflight(graph) {
      const infos = new Map<string, { input?: { required?: Record<string, unknown> } }>()
      for (const [id, node] of Object.entries(graph)) {
        let info = infos.get(node.class_type)
        if (!info) {
          info = (await json(`/object_info/${encodeURIComponent(node.class_type)}`))[node.class_type]
          if (!info) throw new ComfyError(`服务器上没有节点 ${node.class_type}，要先装上`, 'missing')
          infos.set(node.class_type, info)
        }
        const required = info.input?.required ?? {}
        const given = new Set(Object.keys(node.inputs).map(k => k.split('.')[0]))
        const lacking = Object.keys(required).filter(k => !given.has(k))
        if (lacking.length) throw new ComfyError(`节点 ${id} ${node.class_type} 缺输入 ${lacking.join('、')}`, 'rejected')
        const modelInput = MODEL_INPUTS[node.class_type]
        if (!modelInput) continue
        const spec = required[modelInput]
        // A combo is [options, {...}] (V1) or ["COMBO", {options}] (V3).
        const options = Array.isArray(spec) ? (Array.isArray(spec[0]) ? spec[0] : spec[0] === 'COMBO' ? (spec[1] as { options?: unknown[] })?.options : undefined) : undefined
        const file = node.inputs[modelInput]
        if (options && !options.includes(file)) throw new ComfyError(`服务器上没有模型文件 ${file}`, 'missing')
      }
    },

    async upload(folder, path, name) {
      const form = new FormData()
      form.append('image', new Blob([readFileSync(path)]), name)
      form.append('subfolder', folder)
      form.append('type', 'input')
      form.append('overwrite', 'true')
      const result = await json('/upload/image', { method: 'POST', body: form, timeoutMs: 300_000 })
      if (!result?.name) throw new ComfyError(`上传 ${basename(path)} 返回的内容不对`, 'http')
      return result.subfolder ? `${result.subfolder}/${result.name}` : result.name
    },

    async submit(graph) {
      const data = await json('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: 'yanxiang' }) })
      if (typeof data?.prompt_id !== 'string' || !data.prompt_id) throw new ComfyError('ComfyUI 没有返回 prompt_id', 'http')
      return data.prompt_id
    },

    async history(promptId) {
      const data = await json(`/history/${encodeURIComponent(promptId)}`)
      return data?.[promptId]
    },

    async queued(promptId) {
      const data = await json('/queue')
      return [...(data.queue_running ?? []), ...(data.queue_pending ?? [])].some((item: unknown[]) => item[1] === promptId)
    },

    async findByPrefix(prefix) {
      const queue = await json('/queue')
      for (const item of [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])] as unknown[][]) if (prefixOf(item) === prefix) return item[1] as string
      const history = await json('/history?max_items=200')
      for (const [id, entry] of Object.entries(history as Record<string, HistoryEntry>)) if (prefixOf(entry.prompt) === prefix) return id
      return undefined
    },

    async download(saved) {
      const query = new URLSearchParams({ filename: saved.filename, subfolder: saved.subfolder, type: saved.type })
      const response = await call(`/view?${query}`, { timeoutMs: 600_000 })
      if (!response.ok) throw new ComfyError(`下载 ${saved.filename} 返回 ${response.status}`, 'http')
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

/** The mp4 a finished entry saved, or an error saying what went wrong. */
export function savedVideo(entry: HistoryEntry, promptId: string): Saved {
  if (entry.status?.status_str === 'error') throw new ComfyError(`ComfyUI 执行出错（${promptId}）：${JSON.stringify(entry.status.messages ?? []).slice(0, 800)}`, 'execution')
  for (const output of Object.values(entry.outputs ?? {})) {
    for (const key of ['images', 'videos', 'gifs']) {
      for (const item of ((output as Record<string, unknown>)[key] as Saved[] | undefined) ?? []) {
        if (item.filename?.toLowerCase().endsWith('.mp4')) return { filename: item.filename, subfolder: item.subfolder ?? '', type: item.type ?? 'output' }
      }
    }
  }
  throw new ComfyError(`ComfyUI 跑完了但没有保存 mp4（${promptId}）`, 'output')
}
