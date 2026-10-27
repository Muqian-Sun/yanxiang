import { createHash } from 'node:crypto'
import type { Job, Store } from '../store/store.js'
import { ImageError, type ImageClient } from '../yir.js'

export type ImageRequest = { type: string; prompt: string; params: Record<string, unknown>; references: number[]; node_run_id: number; candidate: number }

export const requestHash = (request: ImageRequest) => createHash('sha256').update(JSON.stringify(request)).digest('hex')

/**
 * Gets the picture for one request: an earlier job for the very same request (same node
 * run, same candidate) is reused or resumed where it stopped, so a restart never pays twice
 * (design 03 五, 06 五). Returns the media id.
 */
export async function image(store: Store, client: ImageClient, request: ImageRequest, sleep?: (ms: number) => Promise<void>): Promise<{ media: number; job: number }> {
  const hash = requestHash(request)
  const job = store.liveJob(hash) ?? store.addJob({ node_run_id: request.node_run_id, kind: 'image', provider: 'yir', request, request_hash: hash, idempotency_key: `yanxiang-job-${hash.slice(0, 32)}` })
  return { media: await drive(store, client, job, sleep), job: job.id }
}

async function drive(store: Store, client: ImageClient, job: Job, sleep?: (ms: number) => Promise<void>): Promise<number> {
  const request = job.request as ImageRequest
  try {
    let current = store.job(job.id)
    if (current.status === 'succeeded') return current.output_media_id!
    if (current.status === 'queued' || current.status === 'submitting' || current.status === 'unknown') {
      store.updateJob(job.id, { status: 'submitting', attempt: true })
      const submitted = await client.submit(current.idempotency_key!, request.prompt, request.params, request.references.map(id => store.mediaPath(id)))
      store.updateJob(job.id, { status: 'submitted', provider_job_id: submitted.providerJob, cost: submitted.quotedUsd })
      current = store.job(job.id)
    }
    if (current.status === 'submitted') {
      await client.wait(current.provider_job_id!, sleep)
      store.updateJob(job.id, { status: 'downloading' })
    }
    const { bytes, mime } = await client.download(store.job(job.id).provider_job_id!)
    const media = store.putMedia(bytes, mime)
    store.updateJob(job.id, { status: 'succeeded', output_media_id: media })
    return media
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.updateJob(job.id, { status: 'failed', error: message, error_code: error instanceof ImageError && error.moderated ? 'moderated' : null })
    throw error
  }
}
