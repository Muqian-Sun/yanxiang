import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { Job, Store } from '../store/store.js'
import { ComfyError, savedVideo, type VideoClient } from '../video/comfy.js'
import { probe } from '../video/media.js'
import { build, canvas, frameCount, type Lora, type Models, type Role } from '../video/workflow.js'

export type H3Profile = {
  url: string
  ratio: '16:9' | '9:16'
  models: Models
  sampling: { sampler: string; scheduler: string; steps: number; turboStrength: number }
  sparse: { tau: number; start: number; end: number }
  draft: { shortEdge: number }
  refine: { scale: number; sigmas: number[] }
  fight: { lora: string; strength: number; trigger: string }
  pollSeconds: number
  timeoutSeconds: number
}

export type VideoRequest = {
  prompt: string
  seconds: number
  seed: number
  refine: boolean
  loras: Lora[]
  references: { role: Role; media: number; at?: number }[]
  node_run_id: number
  candidate: number
}

export const requestHash = (r: VideoRequest) => createHash('sha256').update(JSON.stringify(r)).digest('hex')
/** A seed of 48 bits from the run and candidate, so a redo (a new run) draws a new one and a restart the same one. */
export const seedFor = (nodeRunId: number, candidate: number) => Number.parseInt(createHash('sha256').update(`seed-${nodeRunId}-${candidate}`).digest('hex').slice(0, 12), 16)
/** ComfyUI has no idempotency key; this output prefix is how a crashed submit is found again (design 07 六). */
export const prefixOf = (job: Job) => `yanxiang/job-${job.id}`

/** The job asked whether it was submitted; it waits for the creator (design 07 六: never resubmitted by itself). */
export class Unknown extends Error {}

export async function video(store: Store, client: VideoClient, profile: H3Profile, request: VideoRequest, sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))): Promise<{ media: number; job: number }> {
  const hash = requestHash(request)
  const job = store.liveJob(hash) ?? store.addJob({ node_run_id: request.node_run_id, kind: 'video', provider: 'comfyui', request, request_hash: hash, idempotency_key: '' })
  return { media: await drive(store, client, profile, job.id, sleep), job: job.id }
}

export function graphFor(profile: H3Profile, request: VideoRequest, names: string[], prefix: string) {
  const { width, height } = canvas(profile.ratio, profile.draft.shortEdge)
  return build({
    prompt: request.prompt, width, height, frames: frameCount(request.seconds), steps: profile.sampling.steps, seed: request.seed,
    turboStrength: profile.sampling.turboStrength, sampler: profile.sampling.sampler, scheduler: profile.sampling.scheduler,
    references: request.references.map((r, i) => ({ role: r.role, name: names[i]!, ...(r.at !== undefined ? { at: r.at } : {}) })),
    loras: request.loras, sparse: profile.sparse, refine: request.refine ? profile.refine : null, prefix,
  }, profile.models)
}

async function drive(store: Store, client: VideoClient, profile: H3Profile, id: number, sleep: (ms: number) => Promise<void>): Promise<number> {
  const request = store.job(id).request as VideoRequest
  try {
    let job = store.job(id)
    if (job.status === 'succeeded') return job.output_media_id!
    if (job.status === 'unknown') throw new Unknown(`视频任务 ${id} 可能没提交成功：要重提就在审核页点「重提」`)
    if (job.status === 'submitting') {
      // The process died between upload and the answer to /prompt: look for it by prefix before anything else.
      const found = await client.findByPrefix(prefixOf(job))
      if (!found) {
        store.updateJob(id, { status: 'unknown', error: 'ComfyUI 的队列和历史里都找不到这个任务' })
        throw new Unknown(`视频任务 ${id} 可能没提交成功：ComfyUI 的队列和历史里都找不到它`)
      }
      store.updateJob(id, { status: 'submitted', provider_job_id: found })
    }
    if (job.status === 'queued') {
      // Validate the whole graph with placeholder names before touching the server's input folder.
      const placeholders = request.references.map((r, i) => `pending/${i}${extname(store.mediaPath(r.media))}`)
      await client.preflight(graphFor(profile, request, placeholders, prefixOf(job)))
      const folder = prefixOf(job)
      const names: string[] = []
      for (const [i, r] of request.references.entries()) names.push(await client.upload(folder, store.mediaPath(r.media), `${String(i + 1).padStart(2, '0')}${extname(store.mediaPath(r.media))}`))
      store.updateJob(id, { status: 'submitting', attempt: true })
      const promptId = await client.submit(graphFor(profile, request, names, prefixOf(job)))
      store.updateJob(id, { status: 'submitted', provider_job_id: promptId })
    }
    job = store.job(id)
    if (job.status === 'submitted') {
      const deadline = Date.now() + profile.timeoutSeconds * 1000
      for (;;) {
        const entry = await client.history(job.provider_job_id!)
        if (entry?.status?.completed || entry?.status?.status_str === 'error') {
          savedVideo(entry, job.provider_job_id!)
          break
        }
        if (!entry && !(await client.queued(job.provider_job_id!))) {
          // Neither finished nor waiting: the server restarted and lost it.
          store.updateJob(id, { status: 'unknown', error: 'ComfyUI 的队列和历史里都没有这个任务（GPU 可能重启过）' })
          throw new Unknown(`视频任务 ${id} 在 ComfyUI 上不见了（GPU 可能重启过）：要重提就在审核页点「重提」`)
        }
        if (Date.now() > deadline) throw new ComfyError(`视频任务 ${id} 等了 ${profile.timeoutSeconds} 秒还没跑完`, 'timeout')
        await sleep(profile.pollSeconds * 1000)
      }
      store.updateJob(id, { status: 'downloading' })
    }
    const saved = savedVideo((await client.history(store.job(id).provider_job_id!))!, store.job(id).provider_job_id!)
    let bytes: Uint8Array | undefined
    for (let attempt = 1; !bytes; attempt++) {
      try {
        bytes = await client.download(saved)
      } catch (error) {
        // Design 07 七: a download is retried three times.
        if (attempt >= 3) throw error
        await sleep(2000)
      }
    }
    const scratch = join(mkdtempSync(join(tmpdir(), 'yx-video-')), 'clip.mp4')
    writeFileSync(scratch, bytes)
    const info = await probe(scratch)
    const media = store.putMedia(bytes, 'video/mp4', { width: info.width, height: info.height, duration_s: info.duration, has_audio: info.hasAudio })
    store.updateJob(id, { status: 'succeeded', output_media_id: media })
    return media
  } catch (error) {
    // The tunnel or the server dropped after submission: the prompt may still be running there, so the job stays as it is and a retry resumes it.
    const lost = error instanceof ComfyError && error.code === 'offline' && ['submitted', 'downloading'].includes(store.job(id).status)
    if (!(error instanceof Unknown) && !lost) {
      const message = error instanceof Error ? error.message : String(error)
      store.updateJob(id, { status: 'failed', error: message, error_code: error instanceof ComfyError ? error.code : null })
    }
    throw error
  }
}
