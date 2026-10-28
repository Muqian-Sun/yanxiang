/**
 * M1's review page (design 09): the review queue grouped by review point, each review with its
 * pictures, clips and the texts they came from; the progress of every node; grants, retries and
 * resubmits; the conversation assistant. Listens on loopback only.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Engine, Gpu } from '../pipeline/engine.js'
import { designScope, episode, fmtBeats, picturePrompt, type EntityEnv } from '../pipeline/entities.js'
import { cutState, fmtBlocking, keyframePrompt, sceneScope, segmentState } from '../pipeline/storyboard.js'
import { AssistantAction, type AssistantActionT, type BlockingT } from '../tasks.js'
import { lcs } from '../video/subtitles.js'
import type { Artifact, Review, Store } from '../store/store.js'
import type { Stories } from './storyflow.js'
import { describePending } from './env.js'
import { library } from './library.js'
import { SAMPLE } from './spec.js'

const POINTS: Record<number, string> = { 2: '故事方向', 3: '剧本', 4: '外观设计', 5: '定妆照与试音', 6: '站位、机位图与关键帧', 7: '草稿', 8: '整集草稿', 9: '交付片' }
/** Nodes in pipeline order, as the progress page shows them. */
const STAGES: [string, string][] = [
  ['brief', '外观设计'], ['desc', '定妆描述'], ['image', '定妆照'], ['derive', '三视图、特写与服装平铺'], ['plan', '分段'], ['blocking', '站位'], ['timeline', '时间轴'],
  ['views', '机位分组'], ['view', '机位图'], ['kfdesc', '关键帧描述'], ['keyframe', '关键帧'], ['audition', '试音'], ['voice', '音色'],
  ['draft', '草稿'], ['trim', '裁头尾'], ['cut_draft', '整集草稿'], ['refine', '精修'], ['cut_final', '交付片'],
]
/** Yir's 1K medium quotes on 2026-10-22 ranged 0.0067–0.0085 USD; the upper one, for an estimate. */
const IMAGE_USD = 0.0085

const UNCHANGED = '没有变化，和锁定的图一样'

const sentences = (t: string) => t.split(/(?<=[。！？；])|\n/).map(s => s.trim()).filter(Boolean)

/** Sentences dropped from `previous` and added in `next`, by longest common subsequence. */
export function changedSentences(previous: string, next: string): { removed: string[]; added: string[] } {
  const a = sentences(previous)
  const b = sentences(next)
  const match = lcs(a, b)
  const kept = new Set(match.filter(j => j >= 0))
  return { removed: a.filter((_, i) => match[i] === -1), added: b.filter((_, j) => !kept.has(j)) }
}

/**
 * What the creator needs beside an artifact to judge it: the design it was drawn from, the description,
 * what has changed by then. A description rewritten for the creator's note also shows the note, what
 * changed, and, given the engine's `env`, the exact prompt the picture would be drawn with.
 */
export function context(store: Store, a: Artifact, env?: EntityEnv): { title: string; body: string }[] {
  const text = (kind: string, scope: string) => (store.locked(kind, scope)?.payload as { text?: string } | undefined)?.text
  const out: { title: string; body: string }[] = []
  const run = a.node_run_id ? store.nodeRun(a.node_run_id) : undefined
  if (run?.review && run.instruction) {
    out.push({ title: '你的意见', body: run.instruction })
    const before = run.previous_id ? (store.artifact(run.previous_id).payload as { text?: string }).text : undefined
    const now = (a.payload as { text?: string }).text
    if (before !== undefined && now !== undefined) {
      const { removed, added } = changedSentences(before, now)
      out.push({ title: '和上一版比', body: [...removed.map(s => `删掉：${s}`), ...added.map(s => `新加：${s}`)].join('\n') || '一字未改' })
    }
  }
  if (env && a.kind === 'entity_desc') out.push({ title: '这次出图的提示词', body: picturePrompt(env, a.scope, (a.payload as { text: string }).text) })
  if (env && a.kind === 'keyframe_desc') out.push({ title: '这次出图的提示词', body: keyframePrompt(env, a.scope, (a.payload as { text: string }).text) })
  if (a.kind === 'entity_image') {
    const brief = text('entity_brief', designScope(a.scope))
    if (brief) out.push({ title: '外观要点', body: brief })
  }
  if (a.kind === 'keyframe') {
    const desc = text('keyframe_desc', a.scope)
    if (desc) out.push({ title: '关键帧描述', body: desc })
    const state = cutState(store, a.scope)
    if (state) out.push({ title: '此刻的状态', body: state.join('\n') || UNCHANGED })
  }
  if (a.kind === 'clip_draft') {
    const state = segmentState(store, a.scope)
    if (state) out.push({ title: '这一段开始时的状态', body: state.join('\n') || UNCHANGED })
  }
  if (a.kind === 'blocking') {
    const scene = episode(store)?.scenes.find(s => sceneScope(s.id) === a.scope)
    if (scene) out.push({ title: '这一场的剧本', body: fmtBeats(store, scene.beats.map(b => b.id)) })
  }
  return out
}

/** A staging is read as text beside the main picture it was decided on. */
function staging(store: Store, a: Artifact) {
  if (a.kind !== 'blocking') return {}
  const lock = store.inputsOf(a.id).map(id => store.artifact(id)).find(x => x.kind === 'entity_lock')
  return { reading: fmtBlocking(a.payload as BlockingT), still: lock ? store.artifact((lock.payload as { image_id: number }).image_id).media_id : undefined }
}

function progress(store: Store, engine: Engine) {
  const open = store.openReviews()
  return STAGES.flatMap(([node, title]) => {
    const def = engine.nodes.find(d => d.name === node)
    if (!def) return []
    let scopes: string[]
    try {
      scopes = def.scopes(store)
    } catch (error) {
      return [{ node, title, items: [{ scope: '*', status: 'failed', run: undefined, error: `调度时出错：${error instanceof Error ? error.message : String(error)}` }] }]
    }
    const items = scopes.map(scope => {
      const broken = engine.broken.get(`${node} ${scope}`)
      if (broken) return { scope, status: 'failed', run: undefined, error: `调度时出错：${broken}` }
      const run = store.latestNodeRun(node, scope)
      const locked = store.locked(def.output, scope)
      const inReview = open.some(r => r.scope === scope && r.artifact_ids.some(id => store.artifact(id).kind === def.output))
      const status = run?.status === 'running' ? 'running' : run?.status === 'queued' ? 'queued' : run?.status === 'failed' ? 'failed' : inReview ? 'review' : locked ? 'done' : 'waiting'
      return { scope, status, run: run?.id, error: run?.status === 'failed' ? run.error : null }
    })
    return items.length ? [{ node, title, items }] : []
  })
}

function state(store: Store, engine: Engine, gpu: Gpu) {
  const pending = engine.tick(true)
  const reviews = store.openReviews().map(r => ({
    ...r,
    title: POINTS[r.point] ?? `★${r.point}`,
    artifacts: r.artifact_ids.map(id => {
      const a = store.artifact(id)
      const media = a.media_id ? (store.db.prepare('SELECT mime FROM media WHERE id = ?').get(a.media_id) as { mime: string }) : undefined
      const timeline = a.kind === 'clip_draft' ? store.locked('timeline', a.scope)?.payload : undefined
      return { id: a.id, kind: a.kind, version: a.version, payload: a.payload, media: a.media_id, mime: media?.mime, context: context(store, a, engine.env as EntityEnv), timeline, ...staging(store, a), revisable: engine.revisable(a.id), editable: engine.editable(a.id) }
    }),
  }))
  const unknown = store.jobs(['unknown']).map(j => ({ id: j.id, error: j.error }))
  const spent = store.db.prepare("SELECT COALESCE(SUM(cost), 0) AS usd, SUM(kind = 'video') AS videos FROM job WHERE status = 'succeeded'").get() as { usd: number; videos: number | null }
  return { project: store.project().name, gpu: gpu.online, pending, summary: describePending(pending), reviews, progress: progress(store, engine), unknown, spent: { usd: spent.usd, videos: spent.videos ?? 0 }, imageUsd: IMAGE_USD }
}

/** What the page drives: the open project, whether it is ticking, the stories being written, and switching. */
export type App = {
  current(): { dir: string; store: Store; engine: Engine; gpu: Gpu }
  paused: boolean
  projects: string
  stories: Stories
  switchTo(dir: string): void
}

function projects(app: App) {
  if (!existsSync(app.projects)) return []
  return readdirSync(app.projects, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(app.projects, d.name, 'project.db'))).map(d => ({ dir: join(app.projects, d.name), name: d.name, current: join(app.projects, d.name) === app.current().dir }))
}

const NOUN: Record<string, string> = {
  entity_brief: '外观设计', entity_desc: '出图描述', entity_image: '设定图', keyframe: '关键帧', keyframe_desc: '关键帧描述',
  timeline: '时间轴', blocking: '站位', clip_draft: '草稿', cut_draft: '整集草稿', cut_final: '交付片', audition: '试音',
}
const noun = (a: Artifact) => NOUN[a.kind] ?? '这一版'
/** What a note on this artifact actually rewrites (a picture's note lands on its description). */
const rewrites = (a: Artifact) => a.kind === 'entity_image' ? '出图描述' : a.kind === 'keyframe' ? '关键帧描述' : a.kind === 'clip_draft' ? '时间轴' : noun(a)

type Shown = { artifact: Artifact; review?: Review; label: string; nth: number }

function labelOf(scope: string): string {
  const p = scope.split('/')
  if (p[1] === 'char' || p[1] === 'loc' || p[1] === 'prop') return p.slice(2).join(' ') || scope
  if (p.length === 3 && p[1] === 'scene') return `第 ${p[2]!.replace(/^\D+/, '')} 场`
  if (p.length === 3 && p[2]?.startsWith('c')) return `第 ${p[1]!.slice(1)} 段`
  if (p.length === 2 && p[1]?.startsWith('g')) return `第 ${p[1].slice(1)} 段`
  return scope === 'e1' ? '第 1 集' : scope
}

/** Artifacts open on this review point, plus everything they were built from. */
function shown(store: Store, point: number): { onPage: Shown[]; all: Shown[] } {
  const onPage: Shown[] = []
  for (const review of store.openReviews()) {
    if (review.point !== point) continue
    review.artifact_ids.forEach((id, nth) => {
      const artifact = store.artifact(id)
      onPage.push({ artifact, review, label: labelOf(artifact.scope), nth })
    })
  }
  const seen = new Set(onPage.map(s => s.artifact.id))
  const extra: Shown[] = []
  const walk = (id: number) => {
    for (const from of store.inputsOf(id)) {
      if (seen.has(from)) continue
      seen.add(from)
      const artifact = store.artifact(from)
      extra.push({ artifact, label: labelOf(artifact.scope), nth: 0 })
      walk(from)
    }
  }
  for (const s of onPage) walk(s.artifact.id)
  return { onPage, all: [...onPage, ...extra] }
}

function reaches(store: Store, from: number, target: number, seen = new Set<number>()): boolean {
  if (from === target) return true
  if (seen.has(from)) return false
  seen.add(from)
  return store.inputsOf(from).some(id => reaches(store, id, target, seen))
}

function namedIn(utterance: string, items: Shown[]): Shown[] {
  const cand = /候选\s*(\d+)/.exec(utterance)
  if (cand) {
    const hit = items.filter(s => s.nth === Number(cand[1]) - 1)
    if (hit.length) return hit
  }
  const labels = [...new Set(items.map(s => s.label).filter(l => l.length > 0 && utterance.includes(l)))]
  labels.sort((a, b) => b.length - a.length)
  const used = labels.filter((l, i) => !labels.slice(0, i).some(longer => longer.includes(l)))
  return used.length ? items.filter(s => used.includes(s.label)) : []
}

function uniqueReviews(items: Shown[]): Review[] {
  const map = new Map<number, Review>()
  for (const s of items) if (s.review) map.set(s.review.id, s.review)
  return [...map.values()]
}

const namesOf = (items: Shown[]) => [...new Set(items.map(s => s.label))].join('、')

function isVague(u: string): boolean {
  return /^(不对|不行|不好|不太行|都不行|都不对)[。！]?$/.test(u) || [...u].length < 2
}
function isRedo(u: string): boolean {
  return !/不重出|别重出|不要重出/.test(u) && /重出|再出一次|换个种子/.test(u)
}
function isApprove(u: string): boolean {
  if (/不通过|不能通过|先别通过|别通过|不可以/.test(u)) return false
  if (/^(通过|可以|可以了|就用这个|就这张|就它|采用|选定)[了吧啊。！]?$/.test(u)) return true
  if (/^候选\s*\d+\s*(可以|通过)?[。！]?$/.test(u)) return true
  return /这张可以|就用这张|可以用这张/.test(u) && [...u].length < 24
}
function isStatus(u: string): boolean {
  return /为什么|为啥|现在到哪|到哪一步|什么进度|在审什么/.test(u) && !/改|太|不要|加点|去掉/.test(u)
}

function withTime(u: string, at?: number): string {
  if (at === undefined || Number.isNaN(at)) return u
  if (new RegExp(`第\\s*${at}\\s*秒`).test(u)) return u
  return `${u}（第 ${at} 秒）`
}

function explain(point: number, onPage: Shown[], rounds: { user: string }[]): string {
  const title = POINTS[point] ?? `★${point}`
  const groups = new Map<string, number>()
  for (const s of onPage) {
    const key = `${s.label}的${noun(s.artifact)}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  const bits = [...groups].map(([k, n]) => (n > 1 ? `${k}（${n} 个候选）` : k))
  const last = rounds.at(-1)
  const heard = last ? `上一句是「${last.user}」。` : ''
  return `现在在 ★${point} ${title}，待审：${bits.join('、') || '没有'}。${heard}意见只改这一项，不会改提示词。`
}

function chooseRevise(utterance: string, pool: Shown[], all: Shown[], engine: Engine): Shown | undefined {
  if (/外观要点|外观设计/.test(utterance)) {
    const scopes = new Set(pool.filter(s => ['char', 'loc', 'prop'].includes(s.artifact.scope.split('/')[1] ?? '')).map(s => designScope(s.artifact.scope)))
    const brief = all.find(s => s.artifact.kind === 'entity_brief' && scopes.has(s.artifact.scope))
    if (brief && engine.revisable(brief.artifact.id)) return brief
  }
  const reviews = uniqueReviews(pool)
  if (reviews.length === 1) {
    const inReview = pool.filter(s => s.review?.id === reviews[0]!.id)
    const rev = inReview.find(s => engine.revisable(s.artifact.id))
    if (rev) return rev
  }
  if (pool.length === 1) return pool[0]
  if (pool.length > 1 && pool.every(s => s.artifact.scope === pool[0]!.artifact.scope)) return pool.find(s => engine.revisable(s.artifact.id)) ?? pool[0]
  return undefined
}

type Proposal = { action: AssistantActionT; confirm?: string }

/**
 * Turns one sentence about the open review point into an AssistantAction.
 * No model call: the page needs the two routes, and a call would spend money.
 * Prompt files are not read or written here.
 */
function interpret(store: Store, engine: Engine, utterance: string, point: number, focus: number | undefined, at: number | undefined, rounds: { user: string }[]): Proposal {
  const u = utterance.trim()
  if (!u) throw new Error('先写一句话')
  const { onPage, all } = shown(store, point)
  if (!onPage.length) throw new Error('这一页没有待审的产物')
  const named = namedIn(u, onPage)
  const pool = named.length ? named : focus && onPage.some(s => s.review!.id === focus) ? onPage.filter(s => s.review!.id === focus) : onPage
  const seconds = at ?? (/第\s*(\d+(?:\.\d+)?)\s*秒/.exec(u) ? Number(/第\s*(\d+(?:\.\d+)?)\s*秒/.exec(u)![1]) : undefined)
  const instruction = withTime(u, seconds)
  const which = namesOf(onPage)

  if (isStatus(u)) return { action: { kind: 'explain', text: explain(point, onPage, rounds) } }
  if (isVague(u)) return { action: { kind: 'ask', question: `哪里不对？说具体一点，例如衣服太素、石台再旧一些。${which ? `现在在审：${which}。` : ''}` } }
  if (isRedo(u)) {
    const reviews = uniqueReviews(pool)
    if (reviews.length !== 1) return { action: { kind: 'ask', question: `要重出哪一个？现在在审：${which}。` } }
    const s = pool.find(x => x.review) ?? pool[0]!
    const confirm = `不改上游，给${s.label}的${noun(s.artifact)}换个种子再出一次（还要再授权），对吗？`
    return { action: { kind: 'redo', target: String(s.artifact.id), confirm }, confirm }
  }
  if (isApprove(u)) {
    const reviews = uniqueReviews(pool)
    if (reviews.length !== 1) return { action: { kind: 'ask', question: `要通过哪一个？现在在审：${which}。` } }
    const review = reviews[0]!
    const inReview = pool.filter(s => s.review?.id === review.id)
    const picked = /候选\s*\d+/.test(u) ? inReview : inReview.length === 1 ? inReview : []
    if (picked.length !== 1 && review.artifact_ids.length > 1) return { action: { kind: 'ask', question: `这一组有 ${review.artifact_ids.length} 个候选。说「候选 1」，或直接点「选这张」。` } }
    const target = picked[0] ?? inReview[0]!
    const confirm = `通过${target.label}的这版${noun(target.artifact)}，对吗？`
    return { action: { kind: 'approve', target: String(target.artifact.id) }, confirm }
  }
  const target = chooseRevise(u, pool, all, engine)
  if (!target) return { action: { kind: 'ask', question: `你说的是哪一个？现在在审：${which}。` } }
  if (!engine.revisable(target.artifact.id)) return { action: { kind: 'ask', question: `${target.label}这一步没有可改的文字。不满意可以说「重出」，换个种子再出一次。` } }
  const confirm = `我会按这个意见改${target.label}的${rewrites(target.artifact)}：「${instruction}」，对吗？`
  return { action: { kind: 'revise', target: String(target.artifact.id), instruction, confirm }, confirm }
}

function execute(store: Store, engine: Engine, action: AssistantActionT) {
  if (action.kind === 'ask' || action.kind === 'explain') throw new Error('这句不用执行')
  const id = Number(action.target)
  if (!Number.isInteger(id)) throw new Error('产物编号不对')
  const allowed = store.openReviews().some(r => r.artifact_ids.some(aid => reaches(store, aid, id)))
  if (!allowed) throw new Error('这个产物不在当前审核页上')
  const review = store.openReviews().find(r => r.artifact_ids.includes(id))
  if (action.kind === 'revise') {
    if (!engine.revisable(id)) throw new Error('这一步没有可改的文字，只能重出')
    // Queues a rewrite of the text. Does not grant a permit and does not draw.
    engine.revise(id, action.instruction, review?.id)
    return
  }
  if (!review) throw new Error('这不是正在审的产物')
  if (action.kind === 'redo') {
    // Same inputs, another draw, still waiting for 「开始出图」.
    engine.redo(review.id)
    return
  }
  if (review.artifact_ids.length > 1 || review.point === 5 || review.point === 7) engine.pick(review.id, id)
  else engine.approve(review.id)
}

type Memory = { seq: number; rounds: { user: string; action: AssistantActionT }[]; pending?: { id: string; action: AssistantActionT } }
const memories = new Map<string, Memory>()
const memoryOf = (dir: string) => {
  let m = memories.get(dir)
  if (!m) memories.set(dir, m = { seq: 0, rounds: [] })
  return m
}
const needsConfirm = (a: AssistantActionT) => a.kind === 'revise' || a.kind === 'redo' || a.kind === 'approve'

export function serve(app: App, port: number): string {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: req => handle(app, req),
  })
  return `http://127.0.0.1:${server.port}/`
}

export async function handle(app: App, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
  const { store, engine, gpu } = app.current()
  try {
    if (path === '/api/projects') return Response.json({ projects: projects(app), paused: app.paused, sample: SAMPLE })
    if (path === '/api/projects/switch' && req.method === 'POST') {
      const dir = resolve(String(body.dir))
      if (!projects(app).some(p => p.dir === dir)) throw new Error(`没有这个项目：${dir}`)
      app.paused = true
      app.switchTo(dir)
      return Response.json({ ok: true })
    }
    if (path === '/api/pause' && req.method === 'POST') return (app.paused = Boolean(body.paused)), Response.json({ ok: true })
    if (path === '/api/stories') {
      if (req.method === 'POST') return Response.json(app.stories.start(String(body.idea ?? '')))
      return Response.json(app.stories.list().map(st => ({ ...st, busy: app.stories.isBusy(st.id) })))
    }
    const story = /^\/api\/stories\/(\w+)(?:\/(\w+))?$/.exec(path)
    if (story) {
      const [, id, action] = story as unknown as [string, string, string | undefined]
      if (!action) return Response.json({ ...app.stories.get(id!), busy: app.stories.isBusy(id!) })
      if (req.method !== 'POST') throw new Error('要用 POST')
      if (action === 'redirect') app.stories.redirect(id!, String(body.note ?? ''))
      else if (action === 'choose') app.stories.choose(id!, Number(body.index), Boolean(body.carry))
      else if (action === 'revise') app.stories.revise(id!, String(body.note ?? ''))
      else if (action === 'project') {
        const dir = app.stories.createProject(id!, app.projects)
        app.switchTo(dir)
        app.paused = false
        return Response.json({ ok: true, dir })
      } else throw new Error(`不认识的操作 ${action}`)
      return Response.json({ ok: true })
    }
    // Read on every request, so the page can be changed without restarting the engine.
    if (path === '/') return new Response(Bun.file(join(import.meta.dir, 'page.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (path === '/api/status') return Response.json(state(store, engine, gpu))
    if (path === '/api/library') return Response.json(library(store))
    if (path === '/api/revise' && req.method === 'POST') {
      if (!String(body.instruction ?? '').trim()) throw new Error('要写修改意见')
      engine.revise(Number(body.artifact), String(body.instruction))
      return Response.json({ ok: true })
    }
    const media = /^\/api\/media\/(\d+)$/.exec(path)
    if (media) return new Response(Bun.file(store.mediaPath(Number(media[1]))))
    const decision = /^\/api\/reviews\/(\d+)\/decision$/.exec(path)
    if (decision && req.method === 'POST') {
      const review = Number(decision[1])
      if (body.action === 'approve') engine.approve(review)
      else if (body.action === 'pick') engine.pick(review, Number(body.artifact))
      else if (body.action === 'redo') engine.redo(review)
      else if (body.action === 'revise' || body.action === 'edit') {
        if (!String(body.instruction ?? '').trim()) throw new Error('要写修改意见')
        if (body.action === 'edit') engine.edit(review, Number(body.artifact), String(body.instruction))
        else engine.revise(Number(body.artifact), String(body.instruction), review)
      } else throw new Error(`不认识的操作 ${body.action}`)
      return Response.json({ ok: true })
    }
    if (path === '/api/permits' && req.method === 'POST') {
      const pool = body.pool === 'video' ? 'video' : 'image'
      const count = Number(body.count)
      if (!Number.isInteger(count) || count <= 0) throw new Error('授权数量要是正整数')
      store.grant(String(body.scope), pool, count)
      return Response.json({ ok: true })
    }
    const retry = /^\/api\/node-runs\/(\d+)\/retry$/.exec(path)
    if (retry && req.method === 'POST') return engine.retry(Number(retry[1])), Response.json({ ok: true })
    const job = /^\/api\/jobs\/(\d+)\/resolve$/.exec(path)
    if (job && req.method === 'POST') return engine.resubmit(Number(job[1])), Response.json({ ok: true })
    if (path === '/api/rerun' && req.method === 'POST') return engine.rerun(String(body.node), String(body.scope)), Response.json({ ok: true })
    if (path === '/api/assistant' && req.method === 'POST') {
      const utterance = String(body.utterance ?? '')
      const point = Number(body.point)
      if (!Number.isInteger(point)) throw new Error('要在审核页上说')
      const at = body.at === undefined || body.at === null || body.at === '' ? undefined : Number(body.at)
      if (at !== undefined && !Number.isFinite(at)) throw new Error('时间点不对')
      const focus = body.review === undefined || body.review === null || body.review === '' ? undefined : Number(body.review)
      const mem = memoryOf(app.current().dir)
      const proposal = interpret(store, engine, utterance, point, focus, at, mem.rounds)
      const action = AssistantAction.parse(proposal.action)
      mem.rounds = [...mem.rounds, { user: utterance.trim(), action }].slice(-10)
      if (!needsConfirm(action)) {
        mem.pending = undefined
        return Response.json({ ok: true, action })
      }
      const id = String(++mem.seq)
      mem.pending = { id, action }
      return Response.json({ ok: true, id, action, confirm: proposal.confirm })
    }
    if (path === '/api/assistant/confirm' && req.method === 'POST') {
      const mem = memoryOf(app.current().dir)
      const id = String(body.id ?? '')
      if (!mem.pending || mem.pending.id !== id) throw new Error('这句确认已经过期，再说一次')
      if (body.cancel) {
        mem.pending = undefined
        return Response.json({ ok: true })
      }
      const pending = mem.pending
      mem.pending = undefined
      try {
        execute(store, engine, pending.action)
      } catch (error) {
        mem.pending = pending
        throw error
      }
      return Response.json({ ok: true })
    }
    return new Response('没有这个页面', { status: 404 })
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
