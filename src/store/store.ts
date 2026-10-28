import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from './schema.js'

export type ArtifactStatus = 'draft' | 'locked' | 'stale' | 'superseded' | 'failed'
export type Artifact = {
  id: number
  kind: string
  scope: string
  version: number
  status: ArtifactStatus
  payload: unknown
  media_id: number | null
  input_digest: string
  prompt_version: string | null
  node_run_id: number | null
  created_by: 'model' | 'user' | 'program'
  created_at: string
}
export type NewArtifact = {
  kind: string
  scope: string
  payload: unknown
  status?: 'draft' | 'locked' | 'failed'
  inputs?: number[]
  media_id?: number | null
  prompt_version?: string | null
  node_run_id?: number | null
  created_by: Artifact['created_by']
}
export type Project = { id: number; name: string; entry: 'idea' | 'novel' | 'script'; style: string; genre: string; seconds_min: number; seconds_max: number; delivery: '720p' | '1080p'; created_at: string }
export type Review = { id: number; point: number; scope: string; artifact_ids: number[]; status: 'open' | 'closed'; opened_at: string; closed_at: string | null }
export type NodeRunStatus = 'queued' | 'running' | 'waiting_review' | 'done' | 'failed'
export type NodeRun = { id: number; node: string; scope: string; status: NodeRunStatus; attempt: number; error: string | null; started_at: string | null; ended_at: string | null; instruction: string | null; previous_id: number | null }
export type JobStatus = 'queued' | 'submitting' | 'submitted' | 'unknown' | 'downloading' | 'succeeded' | 'failed'
export type Job = {
  id: number
  node_run_id: number | null
  kind: 'image' | 'video'
  provider: 'yir' | 'comfyui'
  request: unknown
  request_hash: string
  idempotency_key: string | null
  status: JobStatus
  provider_job_id: string | null
  attempts: number
  error_code: string | null
  error: string | null
  cost: number | null
  output_media_id: number | null
}

/** A decision on a review that is no longer open (another window got there first, or it went stale). */
export class ReviewClosed extends Error {}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/wav': 'wav' }
/** How long a write waits for another process's transaction; a guess, well above one tick. */
const BUSY_MS = 5000
const now = () => new Date().toISOString()
const digest = (ids: number[]) => createHash('sha256').update([...ids].sort((a, b) => a - b).join(',')).digest('hex')

type Row = Record<string, unknown>
const toArtifact = (row: Row): Artifact => ({ ...(row as unknown as Artifact), payload: JSON.parse(row.payload as string) })
const toReview = (row: Row): Review => ({ ...(row as unknown as Review), artifact_ids: JSON.parse(row.artifact_ids as string) })

/** One project's database and media directory (design 03). */
export class Store {
  readonly db: DatabaseSync

  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'media'), { recursive: true })
    this.db = new DatabaseSync(join(dir, 'project.db'))
    // The runner and the command line write the same file; without a wait the second writer fails at once (M1, 2026-10-27).
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_MS}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`)
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    for (let v = version; v < MIGRATIONS.length; v++) this.tx(() => {
      this.db.exec(MIGRATIONS[v]!)
      this.db.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }

  close() {
    this.db.close()
  }

  /** Runs fn in a transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  createProject(p: { name: string; entry: 'idea' | 'novel' | 'script'; style: string; genre: string; seconds_min: number; seconds_max: number; delivery: '720p' | '1080p' }): number {
    return this.tx(() => {
      const id = Number(this.db.prepare('INSERT INTO project (name, entry, style, genre, seconds_min, seconds_max, delivery, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(p.name, p.entry, p.style, p.genre, p.seconds_min, p.seconds_max, p.delivery, now()).lastInsertRowid)
      this.db.prepare('INSERT INTO episode (project_id, number, created_at) VALUES (?, 1, ?)').run(id, now())
      return id
    })
  }

  project(): Project {
    const row = this.db.prepare('SELECT * FROM project ORDER BY id LIMIT 1').get() as Project | undefined
    if (!row) throw new Error(`${this.dir} 里还没有项目`)
    return row
  }

  /** Stores the bytes once by content; the same file twice is the same media row. */
  putMedia(bytes: Uint8Array, mime: string, meta: { width?: number; height?: number; duration_s?: number; frames?: number; has_audio?: boolean } = {}): number {
    const ext = EXT[mime]
    if (!ext) throw new Error(`不认识的媒体类型 ${mime}`)
    const sha = createHash('sha256').update(bytes).digest('hex')
    const existing = this.db.prepare('SELECT id FROM media WHERE sha256 = ?').get(sha) as { id: number } | undefined
    if (existing) return existing.id
    const rel = join('media', sha.slice(0, 2), `${sha}.${ext}`)
    mkdirSync(join(this.dir, 'media', sha.slice(0, 2)), { recursive: true })
    if (!existsSync(join(this.dir, rel))) writeFileSync(join(this.dir, rel), bytes)
    return Number(this.db.prepare('INSERT INTO media (sha256, path, mime, width, height, duration_s, frames, has_audio, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(sha, rel, mime, meta.width ?? null, meta.height ?? null, meta.duration_s ?? null, meta.frames ?? null, meta.has_audio == null ? null : Number(meta.has_audio), now()).lastInsertRowid)
  }

  mediaPath(id: number): string {
    const row = this.db.prepare('SELECT path FROM media WHERE id = ?').get(id) as { path: string } | undefined
    if (!row) throw new Error(`没有媒体 ${id}`)
    return join(this.dir, row.path)
  }

  /**
   * A new version for (kind, scope), with an edge from every input. An input that is
   * already stale or superseded makes the new one stale on arrival (design 04, 边界情况).
   */
  addArtifact(a: NewArtifact): Artifact {
    return this.tx(() => {
      const inputs = [...new Set(a.inputs ?? [])]
      const states = inputs.map(id => this.artifact(id).status)
      const status = states.some(s => s === 'stale' || s === 'superseded') ? 'stale' : (a.status ?? 'draft')
      const { v } = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM artifact WHERE kind = ? AND scope = ?').get(a.kind, a.scope) as { v: number }
      const id = Number(this.db.prepare('INSERT INTO artifact (project_id, kind, scope, version, status, payload, media_id, input_digest, prompt_version, node_run_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(this.project().id, a.kind, a.scope, v, status, JSON.stringify(a.payload), a.media_id ?? null, digest(inputs), a.prompt_version ?? null, a.node_run_id ?? null, a.created_by, now()).lastInsertRowid)
      const edge = this.db.prepare('INSERT INTO edge (from_id, to_id) VALUES (?, ?)')
      for (const from of inputs) edge.run(from, id)
      return this.artifact(id)
    })
  }

  artifact(id: number): Artifact {
    const row = this.db.prepare('SELECT * FROM artifact WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`没有产物 ${id}`)
    return toArtifact(row)
  }

  /** The newest version of (kind, scope), optionally only among the given statuses. */
  latest(kind: string, scope: string, statuses?: ArtifactStatus[]): Artifact | undefined {
    const rows = this.db.prepare('SELECT * FROM artifact WHERE kind = ? AND scope = ? ORDER BY version DESC').all(kind, scope) as Row[]
    const row = rows.find(r => !statuses || statuses.includes(r.status as ArtifactStatus))
    return row ? toArtifact(row) : undefined
  }

  locked(kind: string, scope: string): Artifact | undefined {
    return this.latest(kind, scope, ['locked'])
  }

  inputsOf(id: number): number[] {
    return (this.db.prepare('SELECT from_id FROM edge WHERE to_id = ? ORDER BY from_id').all(id) as { from_id: number }[]).map(r => r.from_id)
  }

  /**
   * Locks an artifact. The scope's previous locked version is superseded, and everything
   * built on it goes stale (design 03 四). Returns the ids that went stale.
   */
  lock(id: number): number[] {
    return this.tx(() => {
      const a = this.artifact(id)
      if (a.status !== 'draft') throw new Error(`产物 ${id} 是 ${a.status}，只有 draft 能锁定`)
      const previous = this.db.prepare("SELECT id FROM artifact WHERE kind = ? AND scope = ? AND status = 'locked'").all(a.kind, a.scope) as { id: number }[]
      this.db.prepare("UPDATE artifact SET status = 'locked' WHERE id = ?").run(id)
      const stale: number[] = []
      for (const { id: old } of previous) {
        this.db.prepare("UPDATE artifact SET status = 'superseded' WHERE id = ?").run(old)
        stale.push(...this.invalidate(old))
      }
      return stale
    })
  }

  /**
   * Drafts dropped from a review (not picked, or replaced by a revise). Anything already built
   * on such a draft goes stale too: the next character's brief is written from this one's draft.
   */
  supersede(ids: number[]): number[] {
    const update = this.db.prepare("UPDATE artifact SET status = 'superseded' WHERE id = ? AND status = 'draft'")
    return this.tx(() => ids.flatMap(id => (Number(update.run(id).changes) ? this.invalidate(id) : [])))
  }

  /** Breadth-first along edges from `from`: locked and draft artifacts downstream go stale and their open reviews close. */
  invalidate(from: number): number[] {
    return this.tx(() => {
      const next = this.db.prepare('SELECT to_id FROM edge WHERE from_id = ?')
      const mark = this.db.prepare("UPDATE artifact SET stale_from = status, status = 'stale' WHERE id = ? AND status IN ('locked', 'draft')")
      const seen = new Set([from])
      const queue = [from]
      const stale: number[] = []
      while (queue.length) {
        const id = queue.shift()!
        for (const { to_id } of next.all(id) as { to_id: number }[]) {
          if (seen.has(to_id)) continue
          seen.add(to_id)
          if (Number(mark.run(to_id).changes)) stale.push(to_id)
          queue.push(to_id)
        }
      }
      if (stale.length) this.closeReviewsOf(stale)
      return stale
    })
  }

  /**
   * Undoes a staleness that turned out to change nothing: `stale` (the old version) gets its
   * status back and `replacement` (an identical rewrite) is dropped; then, breadth-first,
   * each stale descendant whose inputs are all live again gets its status back too.
   * Returns the revived ids.
   */
  revive(stale: number, replacement: number): number[] {
    return this.tx(() => {
      const restore = this.db.prepare("UPDATE artifact SET status = stale_from, stale_from = NULL WHERE id = ? AND status = 'stale' AND stale_from IS NOT NULL")
      if (!Number(restore.run(stale).changes)) throw new Error(`产物 ${stale} 不是可以恢复的过期版本`)
      this.db.prepare("UPDATE artifact SET status = 'superseded' WHERE id = ?").run(replacement)
      // The old version now stands on the inputs the rewrite read, so the next upstream change still reaches it.
      for (const from of this.inputsOf(replacement)) this.db.prepare('INSERT OR IGNORE INTO edge (from_id, to_id) VALUES (?, ?)').run(from, stale)
      const revived = [stale]
      const queue = [stale]
      const seen = new Set(queue)
      while (queue.length) {
        for (const { to_id } of this.db.prepare('SELECT to_id FROM edge WHERE from_id = ?').all(queue.shift()!) as { to_id: number }[]) {
          if (seen.has(to_id)) continue
          seen.add(to_id)
          if (this.artifact(to_id).status !== 'stale') continue
          if (this.inputsOf(to_id).some(id => ['stale', 'superseded'].includes(this.artifact(id).status))) continue
          if (Number(restore.run(to_id).changes)) {
            revived.push(to_id)
            queue.push(to_id)
          }
        }
      }
      return revived
    })
  }

  openReview(point: number, scope: string, artifactIds: number[]): number {
    return Number(this.db.prepare("INSERT INTO review (point, scope, artifact_ids, status, opened_at) VALUES (?, ?, ?, 'open', ?)").run(point, scope, JSON.stringify(artifactIds), now()).lastInsertRowid)
  }

  review(id: number): Review {
    const row = this.db.prepare('SELECT * FROM review WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`没有审核 ${id}`)
    return toReview(row)
  }

  openReviews(): Review[] {
    return (this.db.prepare("SELECT * FROM review WHERE status = 'open' ORDER BY id").all() as Row[]).map(toReview)
  }

  private closeReviewsOf(ids: number[]) {
    const close = this.db.prepare("UPDATE review SET status = 'closed', closed_at = ? WHERE id = ?")
    for (const r of this.openReviews()) if (r.artifact_ids.some(id => ids.includes(id))) close.run(now(), r.id)
  }

  /**
   * Records a decision and closes the review, in one transaction that first checks the
   * review is still open, so the second of two windows gets ReviewClosed (design 04).
   */
  decide(reviewId: number, d: { action: 'approve' | 'pick' | 'revise' | 'redo'; artifact_id?: number; utterance?: string; instruction?: string }, apply: () => void = () => {}) {
    this.tx(() => {
      if (this.review(reviewId).status !== 'open') throw new ReviewClosed(`审核 ${reviewId} 已经关闭`)
      this.db.prepare('INSERT INTO decision (review_id, action, artifact_id, utterance, instruction, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(reviewId, d.action, d.artifact_id ?? null, d.utterance ?? null, d.instruction ?? null, now())
      this.db.prepare("UPDATE review SET status = 'closed', closed_at = ? WHERE id = ?").run(now(), reviewId)
      apply()
    })
  }

  grant(scope: string, pool: 'image' | 'video', count: number): number {
    return Number(this.db.prepare('INSERT INTO permit (scope, pool, count, granted_at) VALUES (?, ?, ?, ?)').run(scope, pool, count, now()).lastInsertRowid)
  }

  private permitsFor(scope: string, pool: 'image' | 'video') {
    const permits = this.db.prepare('SELECT id, scope, count - used AS left FROM permit WHERE pool = ? AND used < count ORDER BY id').all(pool) as { id: number; scope: string; left: number }[]
    return permits.filter(p => scope === p.scope || scope.startsWith(`${p.scope}/`))
  }

  permitsLeft(scope: string, pool: 'image' | 'video'): number {
    return this.permitsFor(scope, pool).reduce((sum, p) => sum + p.left, 0)
  }

  /** Takes one unit of permission for a paid generation under `scope`; false when none is left. */
  usePermit(scope: string, pool: 'image' | 'video'): boolean {
    return this.usePermits(scope, pool, 1)
  }

  /** Takes `n` units at once, or none: a node that draws two candidates never gets only one. */
  usePermits(scope: string, pool: 'image' | 'video', n: number): boolean {
    return this.tx(() => {
      if (this.permitsLeft(scope, pool) < n) return false
      let need = n
      for (const p of this.permitsFor(scope, pool)) {
        const take = Math.min(need, p.left)
        this.db.prepare('UPDATE permit SET used = used + ? WHERE id = ?').run(take, p.id)
        need -= take
        if (!need) break
      }
      return true
    })
  }

  /** Artifacts of (kind, scope) in the given statuses, oldest first. */
  artifacts(kind: string, scope: string, statuses: ArtifactStatus[]): Artifact[] {
    return (this.db.prepare(`SELECT * FROM artifact WHERE kind = ? AND scope = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY version`).all(kind, scope, ...statuses) as Row[]).map(toArtifact)
  }

  addNodeRun(node: string, scope: string, extra: { instruction?: string; previous_id?: number } = {}): NodeRun {
    const id = Number(this.db.prepare("INSERT INTO node_run (node, scope, status, instruction, previous_id) VALUES (?, ?, 'queued', ?, ?)").run(node, scope, extra.instruction ?? null, extra.previous_id ?? null).lastInsertRowid)
    return this.nodeRun(id)
  }

  nodeRun(id: number): NodeRun {
    const row = this.db.prepare('SELECT * FROM node_run WHERE id = ?').get(id) as NodeRun | undefined
    if (!row) throw new Error(`没有节点运行 ${id}`)
    return row
  }

  latestNodeRun(node: string, scope: string): NodeRun | undefined {
    return this.db.prepare('SELECT * FROM node_run WHERE node = ? AND scope = ? ORDER BY id DESC LIMIT 1').get(node, scope) as NodeRun | undefined
  }

  nodeRuns(statuses: NodeRunStatus[]): NodeRun[] {
    return this.db.prepare(`SELECT * FROM node_run WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id`).all(...statuses) as NodeRun[]
  }

  /** A run started again (after a restart) counts one more attempt; SQLite evaluates the right-hand sides on the old row. */
  setNodeRun(id: number, status: NodeRunStatus, error?: string) {
    if (status === 'running') this.db.prepare("UPDATE node_run SET status = 'running', error = NULL, attempt = attempt + (started_at IS NOT NULL), started_at = COALESCE(started_at, ?) WHERE id = ?").run(now(), id)
    else if (status === 'queued') this.db.prepare("UPDATE node_run SET status = 'queued' WHERE id = ?").run(id)
    else this.db.prepare('UPDATE node_run SET status = ?, error = ?, ended_at = ? WHERE id = ?').run(status, error ?? null, now(), id)
  }

  addLlmCall(c: { node_run_id: number; task: string; model: string; prompt_version: string; system_text: string; user_text: string; response_text: string; tokens_in: number; tokens_out: number; ms: number; ok: boolean; error?: string }) {
    this.db.prepare('INSERT INTO llm_call (node_run_id, task, model, prompt_version, system_text, user_text, response_text, tokens_in, tokens_out, ms, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.node_run_id, c.task, c.model, c.prompt_version, c.system_text, c.user_text, c.response_text, c.tokens_in, c.tokens_out, c.ms, Number(c.ok), c.error ?? null, now())
  }

  addJob(j: { node_run_id: number; kind: 'image' | 'video'; provider: 'yir' | 'comfyui'; request: unknown; request_hash: string; idempotency_key: string }): Job {
    const id = Number(this.db.prepare("INSERT INTO job (node_run_id, kind, provider, request, request_hash, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)")
      .run(j.node_run_id, j.kind, j.provider, JSON.stringify(j.request), j.request_hash, j.idempotency_key, now()).lastInsertRowid)
    return this.job(id)
  }

  job(id: number): Job {
    const row = this.db.prepare('SELECT * FROM job WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`没有生成任务 ${id}`)
    return { ...(row as unknown as Job), request: JSON.parse(row.request as string) }
  }

  /** The newest job for this exact request that has not failed, so a resumed node does not pay twice. */
  liveJob(requestHash: string): Job | undefined {
    const row = this.db.prepare("SELECT id FROM job WHERE request_hash = ? AND status NOT IN ('failed') ORDER BY id DESC LIMIT 1").get(requestHash) as { id: number } | undefined
    return row ? this.job(row.id) : undefined
  }

  jobs(statuses: JobStatus[]): Job[] {
    return (this.db.prepare(`SELECT id FROM job WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id`).all(...statuses) as { id: number }[]).map(r => this.job(r.id))
  }

  updateJob(id: number, fields: Partial<Pick<Job, 'status' | 'provider_job_id' | 'error_code' | 'error' | 'cost' | 'output_media_id'>> & { attempt?: boolean }) {
    const { attempt, ...rest } = fields
    const sets = Object.keys(rest).map(key => `${key} = ?`)
    if (attempt) sets.push('attempts = attempts + 1')
    if (rest.status === 'submitted') sets.push(`submitted_at = '${now()}'`)
    if (rest.status === 'succeeded' || rest.status === 'failed') sets.push(`finished_at = '${now()}'`)
    if (!sets.length) return
    this.db.prepare(`UPDATE job SET ${sets.join(', ')} WHERE id = ?`).run(...(Object.values(rest) as (string | number | null)[]), id)
  }
}
