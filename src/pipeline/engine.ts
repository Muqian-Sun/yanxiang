import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunResult, Section } from '../runner.js'
import { ReviewClosed, type Artifact, type NodeRun, type Store } from '../store/store.js'
import type { Card } from '../tasks.js'
import type { H3Profile } from '../jobs/videos.js'
import type { VideoClient } from '../video/comfy.js'
import type { ImageClient } from '../yir.js'

export type Ready = { ok: true; inputs: number[] } | { ok: false }
export type TextRunner = (o: { card: Card; sections: Section[]; data?: unknown; tag: string; nodeRunId: number }) => Promise<RunResult>

export type VisionRunner = (o: { card: Card; sections: Section[]; images: string[]; data?: unknown; tag: string; nodeRunId: number }) => Promise<RunResult>
/** The GPU side; `online` is refreshed by the runner from /system_stats, so a tick never waits on the network. */
export type Gpu = { client: VideoClient; profile: H3Profile; online: boolean }
/** Speech with times; whisper.cpp in production, a fake in tests. */
export type Listener = (source: string, dir: string) => { text: string; start: number; end: number }[] | Promise<{ text: string; start: number; end: number }[]>
export type Env = { store: Store; root: string; text: TextRunner; vision?: VisionRunner; images: ImageClient | null; gpu?: Gpu | null; listen?: Listener; sleep?: (ms: number) => Promise<void> }
export type Pool = 'text' | 'vision' | 'image' | 'video' | 'edit'

export interface NodeDef {
  name: string
  pool: Pool
  /** Kind of artifact it produces, at the instance's scope. */
  output: string
  /** Review point its drafts go to; without one, outputs are locked at once. */
  review?: number
  /**
   * For a paid node: the text artifact a creator's note on its output is applied to (a picture's
   * description, a draft's timeline); the output is redrawn from the rewritten text. Undefined
   * means a note cannot change it, only a redo can.
   */
  reviseVia?: (store: Store, artifact: Artifact) => Artifact | undefined
  /** Paid generations one run makes (pictures or video segments); such a run needs that many units of permission. */
  paid?: { pool: 'image' | 'video'; count: number }
  /**
   * A picture node that can draw again from one of its own candidates and the creator's note on it:
   * its run then has the note as `instruction` and that candidate as `previous_id`.
   */
  edits?: boolean
  scopes(store: Store): string[]
  ready(store: Store, scope: string): Ready
  /** Writes draft artifacts (with their inputs) and returns their ids. */
  run(env: Env, scope: string, run: NodeRun, inputs: number[]): Promise<number[]>
}

/** Pool limits from design 02; guesses to be tuned after M1, except video: one GPU runs one workflow at a time. */
const POOL_LIMIT: Record<Pool, number> = { text: 4, vision: 2, image: 4, video: 1, edit: 1 }
const KIND_NAMES: Record<string, string> = {
  script: '剧本', roster: '出场清单', entity_brief: '外观设计', entity_desc: '描述', entity_lock: '锁定图', style_ref: '风格参考图',
  segment_plan: '分段', timeline: '时间轴', view_plan: '机位归并', keyframe_desc: '关键帧描述', keyframe: '关键帧', entity_image: '设定图',
  audition: '试音', voice: '音色', clip_draft: '草稿', trim: '裁剪', cut_draft: '草稿成片', clip_final: '精修片', cut_final: '交付片',
}

/** Waiting for the creator to grant `count` units of `pool`, or (`gpu`) for the GPU to come online. */
export type Pending = { node: string; scope: string; pool: 'image' | 'video'; count: number; gpu?: boolean }
export type Event = { type: 'started' | 'review' | 'done' | 'failed' | 'stale'; node: string; scope: string; detail?: string }

/**
 * The scheduler and the decisions of design 04, over a fixed node table. Each tick starts
 * every instance whose prerequisites are locked and whose output is missing or stale (or
 * that a revise/redo queued), within pool limits; paid nodes also need permission.
 */
export class Engine {
  private inflight: Record<Pool, number> = { text: 0, vision: 0, image: 0, video: 0, edit: 0 }
  private running = new Set<Promise<void>>()

  constructor(readonly env: Env, readonly nodes: NodeDef[], private say: (e: Event) => void = () => {}) {}

  /** Design 04 五: a run that was going when the process died starts again; its paid jobs resume by request. */
  recover() {
    for (const run of this.env.store.nodeRuns(['running'])) this.env.store.setNodeRun(run.id, 'queued')
  }

  /** One scheduling pass. Returns what is waiting for the creator to press start; `dry` only looks. */
  tick(dry = false): Pending[] {
    const pending: Pending[] = []
    const broken = new Map<string, string>()
    for (const def of this.nodes) {
      // A node that cannot even tell whether it is ready (bad stored data, say) is reported and skipped; the rest keep going.
      try {
        for (const scope of def.scopes(this.env.store)) {
          try {
            this.visit(def, scope, dry, pending)
          } catch (error) {
            broken.set(`${def.name} ${scope}`, error instanceof Error ? error.message : String(error))
          }
        }
      } catch (error) {
        broken.set(`${def.name} *`, error instanceof Error ? error.message : String(error))
      }
    }
    if (dry) return pending
    for (const [key, message] of broken) {
      if (this.broken.get(key) === message) continue
      const space = key.indexOf(' ')
      this.say({ type: 'failed', node: key.slice(0, space), scope: key.slice(space + 1), detail: `调度时出错：${message}` })
    }
    this.broken = broken
    return pending
  }

  /** Instances whose scheduling threw on the last pass, with the message: shown on the progress page instead of stopping the process. */
  broken = new Map<string, string>()

  private visit(def: NodeDef, scope: string, dry: boolean, pending: Pending[]) {
    const { store } = this.env
    const last = store.latestNodeRun(def.name, scope)
    if (last?.status === 'running' || last?.status === 'failed') return
    const live = store.artifacts(def.output, scope, ['draft', 'locked'])
    const queued = last?.status === 'queued' ? last : undefined
    if (!queued && live.length) return
    const ready = def.ready(store, scope)
    if (!ready.ok || !this.settled(ready.inputs)) return
    const paid = def.paid && !queued?.started_at ? def.paid : undefined
    const offline = def.pool === 'video' && !this.env.gpu?.online
    if (dry) {
      if (paid && store.permitsLeft(scope, paid.pool) < paid.count) pending.push({ node: def.name, scope, pool: paid.pool, count: paid.count })
      else if (offline) pending.push({ node: def.name, scope, pool: 'video', count: 0, gpu: true })
      return
    }
    if (last?.status === 'waiting_review') store.setNodeRun(last.id, 'done')
    if (paid && store.permitsLeft(scope, paid.pool) < paid.count) {
      pending.push({ node: def.name, scope, pool: paid.pool, count: paid.count })
      return
    }
    // Design 07 五: a granted video job waits while the GPU is off and starts once it is on.
    if (offline) {
      pending.push({ node: def.name, scope, pool: 'video', count: 0, gpu: true })
      return
    }
    if (this.inflight[def.pool] >= POOL_LIMIT[def.pool]) return
    if (paid && !store.usePermits(scope, paid.pool, paid.count)) return
    this.start(def, scope, queued ?? store.addNodeRun(def.name, scope, this.patch(def, scope, ready.inputs)), ready.inputs)
  }

  /**
   * Nothing upstream, however far, is about to be replaced: no newer draft waiting for review
   * and no queued or running rerun. Otherwise a paid picture would be drawn from a version
   * the creator has already asked to change.
   */
  private settled(inputs: number[]): boolean {
    const { store } = this.env
    const seen = new Set<number>()
    const queue = [...inputs]
    while (queue.length) {
      const a = store.artifact(queue.shift()!)
      if (seen.has(a.id)) continue
      seen.add(a.id)
      if ((store.latest(a.kind, a.scope, ['draft'])?.version ?? 0) > a.version) return false
      for (const def of this.nodes) {
        if (def.output !== a.kind) continue
        const run = store.latestNodeRun(def.name, a.scope)
        if (run?.status === 'queued' || run?.status === 'running') return false
      }
      queue.push(...store.inputsOf(a.id))
    }
    return true
  }

  /**
   * A text output that went stale because an upstream changed is rewritten from its last
   * version, changing only what the change touches, so an approved design is not redrawn from scratch.
   */
  private patch(def: NodeDef, scope: string, inputs: number[]): { instruction?: string; previous_id?: number } {
    const { store, root } = this.env
    const previous = def.pool === 'text' ? store.latest(def.output, scope) : undefined
    if (previous?.status !== 'stale') return {}
    const before = store.inputsOf(previous.id)
    const changed = inputs.filter(id => !before.includes(id)).map(id => store.artifact(id)).map(a => `${a.scope.split('/').slice(2).join('/') || '本集'}的${KIND_NAMES[a.kind] ?? a.kind}（第 ${a.version} 版）`)
    return { previous_id: previous.id, instruction: `${readFileSync(join(root, 'config/prompts/stale.md'), 'utf8').trim()}\n有新版本的上游：${changed.join('、') || '无'}` }
  }

  /** Waits for everything started so far (tests and the command line). */
  async settle() {
    while (this.running.size) await Promise.all([...this.running])
  }

  private start(def: NodeDef, scope: string, run: NodeRun, inputs: number[]) {
    const { store } = this.env
    this.inflight[def.pool]++
    store.setNodeRun(run.id, 'running')
    this.say({ type: 'started', node: def.name, scope })
    const job = (async () => {
      try {
        const current = store.nodeRun(run.id)
        const ids = await def.run(this.env, scope, current, inputs)
        const fresh = ids.filter(id => store.artifact(id).status === 'draft')
        const previous = current.previous_id ? store.artifact(current.previous_id) : undefined
        if (previous?.status === 'stale' && ids.length === 1 && fresh.length === 1 && JSON.stringify(store.artifact(ids[0]!).payload) === JSON.stringify(previous.payload)) {
          // Rewritten for an upstream change and nothing changed: the old version and what was built on it stand.
          store.revive(previous.id, ids[0]!)
          store.setNodeRun(run.id, 'done')
          this.say({ type: 'done', node: def.name, scope, detail: '重写结果与上一版相同，恢复上一版' })
        } else if (fresh.length < ids.length) {
          // An input went stale while this ran: the next tick runs it again on the new inputs.
          store.setNodeRun(run.id, 'done')
          this.say({ type: 'stale', node: def.name, scope })
        } else if (def.review) {
          store.openReview(def.review, scope, ids)
          store.setNodeRun(run.id, 'waiting_review')
          this.say({ type: 'review', node: def.name, scope, detail: `★${def.review}` })
        } else {
          store.tx(() => ids.forEach(id => store.lock(id)))
          store.setNodeRun(run.id, 'done')
          this.say({ type: 'done', node: def.name, scope })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        store.setNodeRun(run.id, 'failed', message)
        this.say({ type: 'failed', node: def.name, scope, detail: message })
      } finally {
        this.inflight[def.pool]--
      }
    })()
    this.running.add(job)
    void job.finally(() => this.running.delete(job))
  }

  private nodeFor(kind: string, scope: string): NodeDef {
    const def = this.nodes.find(d => d.output === kind && d.scopes(this.env.store).includes(scope))
    if (!def) throw new Error(`没有节点产出 ${kind}（${scope}）`)
    return def
  }

  private closeRun(def: NodeDef, scope: string) {
    const last = this.env.store.latestNodeRun(def.name, scope)
    if (last?.status === 'waiting_review') this.env.store.setNodeRun(last.id, 'done')
  }

  /** ★3/★4/★6/★8/★9: every draft in the review is locked. Pictures also get their entity_lock. */
  approve(reviewId: number) {
    const { store } = this.env
    const review = store.review(reviewId)
    store.decide(reviewId, { action: 'approve' }, () => {
      for (const id of review.artifact_ids) this.lockOne(id)
    })
    this.closeRun(this.nodeFor(store.artifact(review.artifact_ids[0]!).kind, review.scope), review.scope)
  }

  /** ★2/★5/★7: the chosen candidate is locked, the others superseded. */
  pick(reviewId: number, artifactId: number) {
    const { store } = this.env
    const review = store.review(reviewId)
    if (!review.artifact_ids.includes(artifactId)) throw new Error(`产物 ${artifactId} 不在审核 ${reviewId} 里`)
    store.decide(reviewId, { action: 'pick', artifact_id: artifactId }, () => {
      this.lockOne(artifactId)
      store.supersede(review.artifact_ids.filter(id => id !== artifactId))
    })
    this.closeRun(this.nodeFor(store.artifact(artifactId).kind, review.scope), review.scope)
  }

  private lockOne(id: number) {
    const { store } = this.env
    const a = store.artifact(id)
    if (a.status !== 'draft') throw new Error(`产物 ${id} 是 ${a.status}，不能通过`)
    store.lock(id)
    if (a.kind === 'entity_image') store.lock(store.addArtifact({ kind: 'entity_lock', scope: a.scope, payload: { image_id: id }, inputs: [id], created_by: 'user' }).id)
  }

  /**
   * The creator's instruction against one artifact: its node runs again with the previous
   * version and the instruction. From a review, that review is closed and its drafts dropped.
   */
  /** Whether a note on this artifact can change it (for a paid output, whether it has a text to rewrite). */
  revisable(artifactId: number): boolean {
    const a = this.env.store.artifact(artifactId)
    const def = this.nodes.find(d => d.output === a.kind && d.scopes(this.env.store).includes(a.scope))
    return Boolean(def && (!def.paid || def.reviseVia?.(this.env.store, a)))
  }

  revise(artifactId: number, instruction: string, reviewId?: number) {
    const { store } = this.env
    const a = store.artifact(artifactId)
    const def = this.nodeFor(a.kind, a.scope)
    // A paid node does not read notes; the note goes to the text it was made from, and the output follows.
    const target = def.paid ? def.reviseVia?.(store, a) : a
    if (!target) throw new Error(`${def.name} 这一步没有可改的文字，写意见改不了，只能「重出」`)
    const targetDef = target === a ? def : this.nodeFor(target.kind, target.scope)
    const queue = () => store.addNodeRun(targetDef.name, target.scope, { instruction, previous_id: target.id })
    if (reviewId === undefined) return void store.tx(queue)
    const review = store.review(reviewId)
    store.decide(reviewId, { action: 'revise', artifact_id: artifactId, instruction }, () => {
      store.supersede(review.artifact_ids)
      this.closeRun(def, a.scope)
      queue()
    })
  }

  /** Whether a note on this picture can be drawn from the picture itself (`edit`). */
  editable(artifactId: number): boolean {
    const a = this.env.store.artifact(artifactId)
    const def = this.nodes.find(d => d.output === a.kind && d.scopes(this.env.store).includes(a.scope))
    return Boolean(def?.edits && a.media_id)
  }

  /**
   * ★5: the creator's note on one candidate. New candidates are drawn from that one with the note
   * (needs permission again); it stays as a draft and goes into the next review beside them.
   */
  edit(reviewId: number, artifactId: number, instruction: string) {
    const { store } = this.env
    const review = store.review(reviewId)
    if (!review.artifact_ids.includes(artifactId)) throw new Error(`产物 ${artifactId} 不在审核 ${reviewId} 里`)
    if (!this.editable(artifactId)) throw new Error(`产物 ${artifactId} 不能照着改，只能改描述或「重出」`)
    const def = this.nodeFor(store.artifact(artifactId).kind, review.scope)
    store.decide(reviewId, { action: 'revise', artifact_id: artifactId, instruction }, () => {
      store.supersede(review.artifact_ids.filter(id => id !== artifactId))
      this.closeRun(def, review.scope)
      store.addNodeRun(def.name, review.scope, { instruction, previous_id: artifactId })
    })
  }

  /** ★5/★6/★7: same inputs, draw again; needs permission again. */
  redo(reviewId: number) {
    const { store } = this.env
    const review = store.review(reviewId)
    const def = this.nodeFor(store.artifact(review.artifact_ids[0]!).kind, review.scope)
    store.decide(reviewId, { action: 'redo' }, () => {
      store.supersede(review.artifact_ids)
      this.closeRun(def, review.scope)
      store.addNodeRun(def.name, review.scope)
    })
  }

  /**
   * Reuses a picture already drawn (for a scope that no longer exists, say) as a draft of
   * `scope`, standing on what that scope's node would read now, and opens its review.
   */
  adopt(artifactId: number, scope: string): number {
    const { store } = this.env
    const source = store.artifact(artifactId)
    if (!source.media_id) throw new Error(`产物 ${artifactId} 不是图`)
    const def = this.nodeFor(source.kind, scope)
    if (!def.review) throw new Error(`${def.name} 没有审核点，不能沿用`)
    const ready = def.ready(store, scope)
    if (!ready.ok) throw new Error(`${scope} 的前置还没齐，不能沿用`)
    if (store.artifacts(def.output, scope, ['draft', 'locked']).length) throw new Error(`${scope} 已经有图了`)
    return store.tx(() => {
      const draft = store.addArtifact({ kind: source.kind, scope, payload: { ...(source.payload as object), adopted_from: artifactId }, media_id: source.media_id, inputs: ready.inputs, created_by: 'user' })
      return store.openReview(def.review!, scope, [draft.id])
    })
  }

  retry(nodeRunId: number) {
    const run = this.env.store.nodeRun(nodeRunId)
    if (run.status !== 'failed') throw new Error(`节点运行 ${nodeRunId} 是 ${run.status}，不是失败`)
    this.env.store.setNodeRun(nodeRunId, 'queued')
  }

  /** Writes a node's output again from its current inputs (after a prompt changed, say); its downstream goes stale once the new version locks. */
  rerun(node: string, scope: string) {
    const def = this.nodes.find(d => d.name === node)
    if (!def) throw new Error(`没有节点 ${node}`)
    if (!def.scopes(this.env.store).includes(scope)) throw new Error(`${node} 没有作用域 ${scope}`)
    if (def.paid) throw new Error(`${node} 花钱，用审核里的「重出」`)
    const last = this.env.store.latestNodeRun(node, scope)
    if (last?.status === 'queued' || last?.status === 'running') throw new Error(`${node} ${scope} 已经在排队或在跑`)
    this.env.store.addNodeRun(node, scope)
  }

  /**
   * Design 07 六: a video job that may or may not have reached ComfyUI is submitted again only
   * when the creator says so; its node run goes back to the queue on the permission it already used.
   */
  resubmit(jobId: number) {
    const { store } = this.env
    const job = store.job(jobId)
    if (job.status !== 'unknown') throw new Error(`任务 ${jobId} 是 ${job.status}，不是「可能没提交成功」`)
    store.tx(() => {
      store.updateJob(jobId, { status: 'queued', provider_job_id: null, error: null })
      if (job.node_run_id && store.nodeRun(job.node_run_id).status === 'failed') store.setNodeRun(job.node_run_id, 'queued')
    })
  }
}

export { ReviewClosed }
