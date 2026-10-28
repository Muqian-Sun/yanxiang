/**
 * M1's review page (design 09 二, one project, no assistant yet): the review queue grouped by
 * review point, each review with its pictures, clips and the texts they came from; the progress
 * of every node; grants, retries and resubmits. Listens on loopback only.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Engine, Gpu } from '../pipeline/engine.js'
import type { Artifact, Store } from '../store/store.js'
import type { Stories } from './storyflow.js'
import { describePending } from './env.js'
import { library } from './library.js'

const POINTS: Record<number, string> = { 2: '故事方向', 3: '剧本', 4: '外观设计', 5: '定妆照与试音', 6: '机位图与关键帧', 7: '草稿', 8: '整集草稿', 9: '交付片' }
/** Nodes in pipeline order, as the progress page shows them. */
const STAGES: [string, string][] = [
  ['brief', '外观设计'], ['desc', '定妆描述'], ['image', '定妆照'], ['derive', '三视图与特写'], ['plan', '分段'], ['timeline', '时间轴'],
  ['views', '机位分组'], ['view', '机位图'], ['kfdesc', '关键帧描述'], ['keyframe', '关键帧'], ['audition', '试音'], ['voice', '音色'],
  ['draft', '草稿'], ['trim', '裁头尾'], ['cut_draft', '整集草稿'], ['refine', '精修'], ['cut_final', '交付片'],
]
/** Yir's 1K medium quotes on 2026-10-22 ranged 0.0067–0.0085 USD; the upper one, for an estimate. */
const IMAGE_USD = 0.0085

/** What the creator needs beside an artifact to judge it: the design it was drawn from, the description, the timeline. */
function context(store: Store, a: Artifact): { title: string; body: string }[] {
  const root = a.scope.split('/').slice(0, 3).join('/')
  const text = (kind: string, scope: string) => (store.locked(kind, scope)?.payload as { text?: string } | undefined)?.text
  const out: { title: string; body: string }[] = []
  if (a.kind === 'entity_image') {
    const brief = text('entity_brief', root)
    if (brief) out.push({ title: '外观要点', body: brief })
  }
  if (a.kind === 'keyframe') {
    const desc = text('keyframe_desc', a.scope)
    if (desc) out.push({ title: '关键帧描述', body: desc })
  }
  return out
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
      return { id: a.id, kind: a.kind, version: a.version, payload: a.payload, media: a.media_id, mime: media?.mime, context: context(store, a), timeline, revisable: engine.revisable(a.id) }
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

export function serve(app: App, port: number): string {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
      const { store, engine, gpu } = app.current()
      try {
        if (path === '/api/projects') return Response.json({ projects: projects(app), paused: app.paused })
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
          else if (action === 'choose') app.stories.choose(id!, Number(body.index))
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
          else if (body.action === 'revise') {
            if (!String(body.instruction ?? '').trim()) throw new Error('要写修改意见')
            engine.revise(Number(body.artifact), String(body.instruction), review)
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
        return new Response('没有这个页面', { status: 404 })
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 })
      }
    },
  })
  return `http://127.0.0.1:${server.port}/`
}
