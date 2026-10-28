import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { handle, type App } from '../src/m1/web.js'
import { Engine, type NodeDef } from '../src/pipeline/engine.js'
import type { EntityEnv } from '../src/pipeline/entities.js'
import { Store } from '../src/store/store.js'

const ROOT = join(import.meta.dir, '..')

function node(name: string, output: string, scopes: string[], extra: Partial<NodeDef> = {}): NodeDef {
  return { name, pool: extra.pool ?? 'text', output, scopes: () => scopes, ready: () => ({ ok: false }), run: async () => [], ...extra }
}

function world(scopes: string[], nodes: NodeDef[]) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'yx-asst-')))
  store.createProject({ name: '样片', entry: 'script', style: '3d-guoman', genre: 'xianxia', seconds_min: 45, seconds_max: 60, delivery: '1080p' })
  let modelCalls = 0
  const text = async () => {
    modelCalls += 1
    throw new Error('助手不该调模型')
  }
  const engine = new Engine({ store, root: ROOT, text, images: null, style: {} } as unknown as EntityEnv, nodes.length ? nodes : [node('brief', 'entity_brief', scopes, { review: 4, ready: () => ({ ok: true, inputs: [] }) })])
  const app = {
    current: () => ({ dir: store.dir, store, engine, gpu: { online: false } }),
    paused: true,
    projects: store.dir,
    stories: {},
    switchTo() {},
  } as unknown as App
  return { store, engine, app, modelCalls: () => modelCalls }
}

function draft(store: Store, scope: string, text = '主色：白') {
  const artifact = store.addArtifact({ kind: 'entity_brief', scope, payload: { text }, status: 'draft', created_by: 'model' })
  const review = store.openReview(4, scope, [artifact.id])
  return { artifact, review }
}

async function post(app: App, path: string, data: unknown) {
  const res = await handle(app, new Request('http://127.0.0.1' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }))
  return { status: res.status, body: await res.json() as { ok?: boolean; error?: string; id?: string; confirm?: string; action?: { kind: string; target?: string; instruction?: string; confirm?: string; question?: string; text?: string } } }
}

const jobs = (store: Store) => (store.db.prepare('SELECT COUNT(*) AS n FROM job').get() as { n: number }).n
const permits = (store: Store) => (store.db.prepare('SELECT COUNT(*) AS n FROM permit').get() as { n: number }).n

test('a note becomes a revise, and only the confirmation queues it', async () => {
  const { store, app, modelCalls } = world(['e1/char/谢无咎'], [])
  const { artifact } = draft(store, 'e1/char/谢无咎')
  const said = await post(app, '/api/assistant', { utterance: '石台再旧一些，锁链上要有锈迹', point: 4 })
  expect(said.status).toBe(200)
  expect(said.body.action?.kind).toBe('revise')
  expect(said.body.action?.target).toBe(String(artifact.id))
  expect(said.body.action?.instruction).toContain('石台再旧一些')
  expect(said.body.confirm).toMatch(/对吗？$/)
  expect(store.latestNodeRun('brief', 'e1/char/谢无咎')).toBeUndefined()
  expect(modelCalls()).toBe(0)

  const done = await post(app, '/api/assistant/confirm', { id: said.body.id })
  expect(done.body.ok).toBe(true)
  const run = store.latestNodeRun('brief', 'e1/char/谢无咎')!
  expect(run.status).toBe('queued')
  expect(run.instruction).toContain('石台再旧一些')
  expect(jobs(store)).toBe(0)
  expect(permits(store)).toBe(0)
  expect(modelCalls()).toBe(0)
  expect((await post(app, '/api/assistant/confirm', { id: said.body.id })).status).toBe(400)
})

test('two open reviews need a name, and naming one revises only that one', async () => {
  const scopes = ['e1/char/谢无咎', 'e1/char/柳含烟']
  const { store, app } = world(scopes, [])
  draft(store, scopes[0]!, '主色：白')
  const other = draft(store, scopes[1]!, '主色：红')
  const vague = await post(app, '/api/assistant', { utterance: '衣服太素了', point: 4 })
  expect(vague.body.action?.kind).toBe('ask')
  expect(vague.body.id).toBeUndefined()
  expect(store.nodeRuns(['queued'])).toHaveLength(0)

  const named = await post(app, '/api/assistant', { utterance: '柳含烟的衣服太素了', point: 4 })
  expect(named.body.action?.kind).toBe('revise')
  expect(named.body.action?.target).toBe(String(other.artifact.id))
  await post(app, '/api/assistant/confirm', { id: named.body.id })
  expect(store.latestNodeRun('brief', 'e1/char/柳含烟')!.instruction).toContain('柳含烟')
  expect(store.latestNodeRun('brief', 'e1/char/谢无咎')).toBeUndefined()
})

test('passing and redoing wait for confirmation, and neither draws or spends a permit', async () => {
  const scope = 'e1/char/谢无咎'
  const { store, app, modelCalls } = world([scope], [])
  const { artifact, review } = draft(store, scope)
  const pass = await post(app, '/api/assistant', { utterance: '通过', point: 4 })
  expect(pass.body.confirm).toMatch(/对吗？$/)
  expect(store.artifact(artifact.id).status).toBe('draft')
  await post(app, '/api/assistant/confirm', { id: pass.body.id })
  expect(store.artifact(artifact.id).status).toBe('locked')
  expect(store.review(review).status).toBe('closed')

  const image = store.addArtifact({ kind: 'entity_image', scope, payload: {}, status: 'draft', created_by: 'model' })
  const open = store.openReview(5, scope, [image.id])
  let draws = 0
  const imageNode = node('image', 'entity_image', [scope], {
    pool: 'image', review: 5, paid: { pool: 'image', count: 2 },
    reviseVia: (s, a) => s.locked('entity_desc', a.scope),
    run: async () => { draws += 1; throw new Error('不应出图') },
  })
  const eng = new Engine({ store, root: ROOT, text: async () => { throw new Error('助手不该调模型') }, images: null, style: {} } as unknown as EntityEnv, [imageNode])
  const app2 = { current: () => ({ dir: store.dir, store, engine: eng, gpu: { online: false } }), paused: true, projects: store.dir, stories: {}, switchTo() {} } as unknown as App
  const redo = await post(app2, '/api/assistant', { utterance: '重出一次', point: 5 })
  expect(redo.body.action?.kind).toBe('redo')
  expect(redo.body.confirm).toContain('还要再授权')
  expect(redo.body.confirm).toMatch(/对吗？$/)
  await post(app2, '/api/assistant/confirm', { id: redo.body.id })
  expect(store.latestNodeRun('image', scope)!.status).toBe('queued')
  expect(store.latestNodeRun('image', scope)!.instruction).toBeNull()
  expect(store.review(open).status).toBe('closed')
  expect(jobs(store)).toBe(0)
  expect(permits(store)).toBe(0)
  expect(draws).toBe(0)
  expect(modelCalls()).toBe(0)
})

test('a second on a video note is kept, and cancelling does not queue', async () => {
  const scope = 'e1/g1'
  const { store, app } = world([scope], [node('draft', 'clip_draft', [scope], { review: 7, pool: 'video', paid: { pool: 'video', count: 1 }, reviseVia: s => s.locked('timeline', scope) })])
  store.addArtifact({ kind: 'timeline', scope, payload: { seconds: 8 }, status: 'locked', created_by: 'model' })
  const clip = store.addArtifact({ kind: 'clip_draft', scope, payload: {}, status: 'draft', created_by: 'model', inputs: [store.locked('timeline', scope)!.id] })
  store.openReview(7, scope, [clip.id])
  const said = await post(app, '/api/assistant', { utterance: '这里太暗', point: 7, at: 3 })
  expect(said.body.action?.instruction).toContain('第 3 秒')
  const dropped = await post(app, '/api/assistant/confirm', { id: said.body.id, cancel: true })
  expect(dropped.body.ok).toBe(true)
  expect(store.nodeRuns(['queued'])).toHaveLength(0)
  expect((await post(app, '/api/assistant/confirm', { id: said.body.id })).body.error).toContain('过期')
})

test('asking where things stand does not execute, and a closed review cannot be confirmed', async () => {
  const scope = 'e1/char/谢无咎'
  const { store, engine, app } = world([scope], [])
  const { review } = draft(store, scope)
  const where = await post(app, '/api/assistant', { utterance: '现在到哪了', point: 4 })
  expect(where.body.action?.kind).toBe('explain')
  expect(where.body.action?.text).toContain('谢无咎')
  expect(where.body.id).toBeUndefined()

  const said = await post(app, '/api/assistant', { utterance: '头发改成半束', point: 4 })
  engine.approve(review)
  const failed = await post(app, '/api/assistant/confirm', { id: said.body.id })
  expect(failed.status).toBe(400)
  expect(failed.body.error).toContain('不在当前审核页')
  expect(store.nodeRuns(['queued'])).toHaveLength(0)
})

test('a note on a picture rewrites its description and does not draw', async () => {
  const scope = 'e1/char/谢无咎'
  const descNode = node('desc', 'entity_desc', [scope])
  const imageNode = node('image', 'entity_image', [scope], {
    pool: 'image', review: 5, paid: { pool: 'image', count: 2 },
    reviseVia: (s, a) => s.locked('entity_desc', a.scope),
    run: async () => { throw new Error('不应出图') },
  })
  const { store, app, modelCalls } = world([scope], [descNode, imageNode])
  const desc = store.addArtifact({ kind: 'entity_desc', scope, payload: { text: '白衣' }, status: 'locked', created_by: 'model' })
  const image = store.addArtifact({ kind: 'entity_image', scope, payload: {}, status: 'draft', created_by: 'model', inputs: [desc.id] })
  const review = store.openReview(5, scope, [image.id])
  const said = await post(app, '/api/assistant', { utterance: '衣服太素了', point: 5 })
  expect(said.body.action?.kind).toBe('revise')
  expect(said.body.action?.target).toBe(String(image.id))
  expect(said.body.confirm).toContain('出图描述')
  expect(said.body.confirm).toMatch(/对吗？$/)
  await post(app, '/api/assistant/confirm', { id: said.body.id })
  expect(store.latestNodeRun('desc', scope)!.instruction).toBe('衣服太素了')
  expect(store.latestNodeRun('image', scope)).toBeUndefined()
  expect(store.review(review).status).toBe('closed')
  expect(jobs(store)).toBe(0)
  expect(permits(store)).toBe(0)
  expect(modelCalls()).toBe(0)
})

test('a note that names the design revises the brief upstream, and does not draw', async () => {
  const scope = 'e1/char/谢无咎'
  const briefNode = node('brief', 'entity_brief', [scope], { review: 4 })
  const descNode = node('desc', 'entity_desc', [scope])
  const imageNode = node('image', 'entity_image', [scope], {
    pool: 'image', review: 5, paid: { pool: 'image', count: 2 },
    reviseVia: (s, a) => s.locked('entity_desc', a.scope),
    run: async () => { throw new Error('不应出图') },
  })
  const { store, app, modelCalls } = world([scope], [briefNode, descNode, imageNode])
  const brief = store.addArtifact({ kind: 'entity_brief', scope, payload: { text: '年龄：三十出头' }, status: 'locked', created_by: 'model' })
  const desc = store.addArtifact({ kind: 'entity_desc', scope, payload: { text: '白衣' }, status: 'locked', created_by: 'model', inputs: [brief.id] })
  const image = store.addArtifact({ kind: 'entity_image', scope, payload: {}, status: 'draft', created_by: 'model', inputs: [desc.id] })
  const review = store.openReview(5, scope, [image.id])
  const said = await post(app, '/api/assistant', { utterance: '外观要点改成五十岁上下', point: 5 })
  expect(said.body.action?.kind).toBe('revise')
  expect(said.body.action?.target).toBe(String(brief.id))
  expect(said.body.confirm).toContain('外观设计')
  await post(app, '/api/assistant/confirm', { id: said.body.id })
  expect(store.latestNodeRun('brief', scope)!.instruction).toContain('五十岁')
  expect(store.review(review).status).toBe('open')
  expect(jobs(store)).toBe(0)
  expect(modelCalls()).toBe(0)
})

test('the review page is a bench: pictures and decisions on the left, talk on the right', () => {
  const html = readFileSync(join(ROOT, 'src/m1/page.html'), 'utf8')
  expect(html).toContain('id="talk"')
  expect(html).toContain('id="workspace"')
  expect(html).toContain('class="talk-form"')
  expect(html).toContain('都不行，说哪里不对')
  expect(html).toContain('选这张')
  expect(html).toContain('开始出图')
  expect(html).toContain('phase-block')
  expect(html).toContain('等授权')
  expect(html).toContain('>重试<')
  expect(html).toContain("c.title === '你的意见' || c.title === '和上一版比'")
  expect(html).not.toContain('评审意见（几张都不对时用）')
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  if (!script) throw new Error('页面没有脚本')
  new Function(script)
})
