import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageRequest } from '../src/jobs/images.js'
import { context } from '../src/m1/web.js'
import { Engine, type TextRunner, type VisionRunner } from '../src/pipeline/engine.js'
import { ENTITY_NODES, type EntityEnv } from '../src/pipeline/entities.js'
import { STORYBOARD_NODES } from '../src/pipeline/storyboard.js'
import { loadPlugins } from '../src/plugins.js'
import type { Section } from '../src/runner.js'
import { Store } from '../src/store/store.js'
import type { BlockingData, PlanData, PlanT, TimelineT } from '../src/tasks.js'
import type { ImageClient } from '../src/yir.js'

const ROOT = join(import.meta.dir, '..')
const style = loadPlugins(join(ROOT, 'config/plugins')).plugins.get('style:3d-guoman')!

const beat = (id: string, action: string, seconds = 5, lines: { speaker: string; text: string }[] = [], changes: string[] = []) =>
  ({ id, action, lines, seconds, changes })
const SCRIPT = {
  scenes: [{
    id: 'sc1', location: '封剑洞', setting: '石台居中，柳含烟立在洞口。',
    beats: [
      beat('b1', '谢无咎跪在石台上。', 5, [], ['锁链束住双腕']),
      beat('b2', '柳含烟抽出婚书。', 5, [{ speaker: '柳含烟', text: '签字。' }], ['婚书展开']),
      beat('b3', '两人僵持。', 4),
    ],
  }],
}
const person = (name: string) => ({ name, gender: '男', age_look: '约三十岁', rank: '剑修', tier: '男主', needs: '跪着', temperament: '隐忍', appearance_lines: [] })
const ROSTER = {
  characters: [person('谢无咎'), { ...person('柳含烟'), gender: '女', tier: '女主' }],
  locations: [{ name: '封剑洞', beats: ['b1', 'b2', 'b3'] }],
  props: [{ name: '石台', holder: '固定在洞中央', beats: ['b1'] }, { name: '婚书', holder: '柳含烟藏在袖中', beats: ['b2'] }],
}

const PLAN: PlanT = {
  segments: [
    { id: 'g1', beats: ['b1', 'b2'], seconds: 10, location: '封剑洞', continues: false, summary: '逼签' },
    { id: 'g2', beats: ['b3'], seconds: 4, location: '封剑洞', continues: true, summary: '僵持' },
  ],
  overflow: [],
}

const cut = (index: number, start: number, end: number, view: string, characters: string[], props: string[]): TimelineT['cuts'][number] =>
  ({ index, start, end, camera: '固定', shot: '中景', present: { characters, backs: [], props, view } })

const TL1: TimelineT = {
  seconds: 10,
  cuts: [
    cut(1, 0, 5, '封剑洞内主视角，正对石台', ['谢无咎'], ['石台']),
    cut(2, 5, 10, '从石台侧面看向洞口', ['谢无咎', '柳含烟'], ['婚书']),
  ],
  timeline: Array.from({ length: 10 }, (_, second) => ({ second, text: `第${second}秒`, changes: second === 5 ? ['婚书展开'] : [] })),
  lines: [{ speaker: '柳含烟', text: '签字。', start: 6, end: 8 }],
  ambience: '洞风',
  fight: false,
}

const TL2: TimelineT = {
  seconds: 4,
  cuts: [
    cut(1, 0, 2, '沿用上一段机位', ['谢无咎', '柳含烟'], []),
    cut(2, 2, 4, '石台侧面，越过谢无咎肩头看向洞口', ['柳含烟'], ['婚书']),
  ],
  timeline: Array.from({ length: 4 }, (_, second) => ({ second, text: `续${second}`, changes: [] })),
  lines: [],
  ambience: '洞风',
  fight: false,
}

/** Stands in for the staging model: everyone stands in one spot from the beat he comes on. */
const staging = (data: BlockingData) => ({
  spots: [{ name: '石台前', kind: '站位', where: '石台靠镜头一侧，主图画面中央' }],
  people: Object.entries(data.first).map(([name, from]) => ({ name, from, spot: '石台前', pose: '站着，背对镜头', how: from === 'b1' ? '开场就在' : '从洞口走进来' })),
})

function project() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'yx-sb-')))
  store.createProject({ name: '样片', entry: 'script', style: '3d-guoman', genre: 'xianxia', seconds_min: 45, seconds_max: 60, delivery: '1080p' })
  store.addArtifact({ kind: 'style_ref', scope: 'p', payload: {}, status: 'locked', created_by: 'program' })
  const script = store.addArtifact({ kind: 'script', scope: 'e1', payload: SCRIPT, status: 'locked', created_by: 'user' })
  store.addArtifact({ kind: 'roster', scope: 'e1', payload: ROSTER, inputs: [script.id], status: 'locked', created_by: 'user' })
  return store
}

/** Lock every roster entity (and character derives) as if ★5 were done. */
function lockEntities(store: Store) {
  for (const kind of ['char', 'loc', 'prop'] as const) {
    const list = kind === 'char' ? ROSTER.characters : kind === 'loc' ? ROSTER.locations : ROSTER.props
    for (const row of list) {
      const scope = `e1/${kind}/${row.name}`
      store.addArtifact({ kind: 'entity_brief', scope, payload: { text: kind === 'char' ? '脸型：长\n主色：白\n区分：散发' : kind === 'loc' ? '格局：洞口朝南\n陈设：石台居中\n光源：洞口天光从南面照入' : '形制：长方' }, status: 'locked', created_by: 'user' })
      store.addArtifact({ kind: 'entity_desc', scope, payload: { text: `${row.name}描述` }, status: 'locked', created_by: 'user' })
      const media = store.putMedia(new TextEncoder().encode(scope), 'image/png')
      const img = store.addArtifact({ kind: 'entity_image', scope, payload: { job_id: 0, prompt: scope }, media_id: media, status: 'locked', created_by: 'user' })
      store.addArtifact({ kind: 'entity_lock', scope, payload: { image_id: img.id }, inputs: [img.id], status: 'locked', created_by: 'user' })
      if (kind === 'char') for (const derived of ['三视图', '脸部特写']) {
        const dscope = `${scope}/${derived}`
        const dmedia = store.putMedia(new TextEncoder().encode(dscope), 'image/png')
        const dimg = store.addArtifact({ kind: 'entity_image', scope: dscope, payload: { job_id: 0, prompt: dscope }, media_id: dmedia, status: 'locked', created_by: 'user' })
        store.addArtifact({ kind: 'entity_lock', scope: dscope, payload: { image_id: dimg.id }, inputs: [dimg.id], status: 'locked', created_by: 'user' })
      }
    }
  }
}

type Call = { task: string; sections: Section[]; data?: unknown; images?: string[] }
function fakeText(calls: Call[] = []): TextRunner & VisionRunner {
  return async ({ card, sections, data, images }: Parameters<TextRunner>[0] & { images?: string[] }) => {
    calls.push({ task: card.name, sections, data, images })
    if (card.name === 'blocking') return { output: staging(data as BlockingData), raw: '{}', attempts: [], system: '', user: '', promptVersion: 'v', model: 'fake' }
    if (card.name === 'segment-plan') return { output: PLAN, raw: '{}', attempts: [], system: '', user: '', promptVersion: 'v', model: 'fake' }
    if (card.name === 'timeline') {
      const body = sections.find(s => s.title === '这一段')!.body
      const output = body.startsWith('g1') ? TL1 : TL2
      return { output, raw: '{}', attempts: [], system: '', user: '', promptVersion: 'v', model: 'fake' }
    }
    if (card.name === 'view-groups') {
      // Stands in for the model: cuts whose view mentions the side of the table share one camera.
      const cuts = (data as { cuts: string[] }).cuts
      const listed = sections.find(s => s.title === '镜头')!.body.split('\n')
      const side = cuts.filter(c => listed.find(l => l.startsWith(`${c}｜`))!.includes('侧面'))
      const output = { views: [{ name: '主视角', camera: '', cuts: cuts.filter(c => !side.includes(c)) }, { name: '侧面', camera: '站在石台侧面看向洞口', cuts: side }] }
      return { output, raw: '{}', attempts: [], system: '', user: '', promptVersion: 'v', model: 'fake' }
    }
    if (card.name === 'location-view-desc') return { output: '从侧面看石台，洞口在画面右侧。', raw: '', attempts: [], system: '', user: '', promptVersion: 'v', model: 'fake' }
    if (card.name === 'keyframe-desc') return { output: '图 1 穿白袍的谢无咎跪在画面中央。', raw: '', attempts: [], system: '', user: '', promptVersion: 'v', model: 'fake' }
    return { output: `${card.name}`, raw: '', attempts: [], system: '', user: '', promptVersion: 'v', model: 'fake' }
  }
}

type Fake = ImageClient & { submits: ImageRequest['prompt'][] }
function fakeImages(): Fake {
  let n = 0
  const fake = {
    submits: [] as string[],
    async submit(_key: string, prompt: string) {
      fake.submits.push(prompt)
      return { providerJob: `job-${++n}`, quotedUsd: 0.007 }
    },
    async poll() { return 'succeeded' as const },
    async wait() {},
    async download(providerJob: string) { return { bytes: new TextEncoder().encode(providerJob), mime: 'image/png' } },
    async generate() { throw new Error('not used') },
  }
  return fake as unknown as Fake
}

const engine = (store: Store, text = fakeText(), images = fakeImages()) =>
  new Engine({ store, root: ROOT, text, vision: text, images, style } as EntityEnv, [...ENTITY_NODES, ...STORYBOARD_NODES])

/** ★6 on every scene's staging, as the creator would. */
function approveStagings(e: Engine, store: Store) {
  for (const r of store.openReviews().filter(r => r.scope.startsWith('e1/scene/'))) e.approve(r.id)
}

async function round(e: Engine) {
  const pending = e.tick()
  await e.settle()
  return pending
}

test('plan waits for every root entity lock, then timelines follow; a continues segment waits for the previous timeline', async () => {
  const store = project()
  const calls: Call[] = []
  const e = engine(store, fakeText(calls))
  await round(e)
  expect(store.latest('segment_plan', 'e1')).toBeUndefined()
  expect(store.latest('blocking', 'e1/scene/sc1')).toBeUndefined()
  lockEntities(store)
  await round(e)
  expect(store.locked('segment_plan', 'e1')!.payload).toEqual(PLAN)
  expect((calls.find(c => c.task === 'segment-plan')!.data as { beats: string[] }).beats).toEqual(['b1', 'b2', 'b3'])

  // The scene's staging is decided looking at the location's main picture, and reviewed at ★6 before any timeline.
  const staged = calls.find(c => c.task === 'blocking')!
  // She is in the scene's setting, so she is there from its first beat although she first acts in b2.
  expect(staged.data).toEqual({ beats: ['b1', 'b2', 'b3'], first: { 谢无咎: 'b1', 柳含烟: 'b1' } })
  expect(staged.images).toEqual([store.mediaPath(store.artifact((store.locked('entity_lock', 'e1/loc/封剑洞')!.payload as { image_id: number }).image_id).media_id!)])
  const review = store.openReviews().find(r => r.scope === 'e1/scene/sc1')!
  expect(review.point).toBe(6)
  expect(context(store, store.artifact(review.artifact_ids[0]!))).toEqual([{ title: '这一场的剧本', body: expect.stringContaining('b2（封剑洞，约 5 秒）柳含烟抽出婚书。') }])
  await round(e)
  expect(store.latestNodeRun('timeline', 'e1/g1')).toBeUndefined()
  e.approve(review.id)
  await round(e)
  expect(store.locked('timeline', 'e1/g1')).toBeTruthy()
  expect(store.locked('timeline', 'e1/g2')).toBeUndefined()
  const g1 = calls.find(c => c.task === 'timeline' && c.sections[0]!.body.startsWith('g1'))!
  expect(g1.sections.find(s => s.title === '这一段开始时的状态')!.body).toBe('')
  expect(g1.sections.find(s => s.title === '地点的格局')!.body).toBe('封剑洞\n格局：洞口朝南\n陈设：石台居中')
  expect(g1.sections.find(s => s.title === '站位')!.body).toBe([
    '封剑洞的位置（画面左右是主图的左右）：', '石台前（站位）：石台靠镜头一侧，主图画面中央',
    '这一段开始时：', '还没有人在场',
    '这一段里：', 'b1 起，谢无咎：石台前，站着，背对镜头；开场就在', 'b1 起，柳含烟：石台前，站着，背对镜头；开场就在',
  ].join('\n'))
  await round(e)
  expect(store.locked('timeline', 'e1/g2')).toBeTruthy()
  const g2 = calls.find(c => c.task === 'timeline' && c.sections[0]!.body.startsWith('g2'))!
  expect(g2.sections.find(s => s.title === '上一段最后一个镜头')!.body).toContain('最后一秒：第9秒')
  expect(g2.sections.find(s => s.title === '这一段开始时的状态')!.body).toContain('锁链束住双腕')
  expect(g2.sections.find(s => s.title === '这一段开始时的状态')!.body).toContain('婚书展开')
  expect(g2.sections.find(s => s.title === '站位')!.body).toContain('这一段开始时：\n谢无咎：石台前，站着，背对镜头\n柳含烟：石台前，站着，背对镜头\n这一段里：\n没有人换位置')
})

/** Plan, both timelines and the location's camera groups. */
async function upToViews(e: Engine, store: Store) {
  lockEntities(store)
  for (let i = 0; i < 4; i++) {
    await round(e)
    approveStagings(e, store)
  }
  expect(store.locked('view_plan', 'e1/loc/封剑洞')).toBeTruthy()
}

test('cuts worded differently but from the same camera share one view picture; the main view uses the root picture', async () => {
  const store = project()
  const calls: Call[] = []
  const images = fakeImages()
  const e = engine(store, fakeText(calls), images)
  await upToViews(e, store)
  // The first cut of a continuing segment gets no keyframe, so it is not grouped either.
  expect((calls.find(c => c.task === 'view-groups')!.data as { cuts: string[] }).cuts).toEqual(['g1/c1', 'g1/c2', 'g2/c2'])

  const pending = await round(e)
  expect(store.locked('keyframe_desc', 'e1/g1/c1')).toBeTruthy()
  expect(pending.filter(p => p.node === 'view').map(p => p.scope)).toEqual(['e1/loc/封剑洞/侧面'])
  expect(store.latest('keyframe_desc', 'e1/g1/c2')).toBeUndefined()

  store.grant('e1/loc/封剑洞', 'image', 1)
  await round(e)
  expect(images.submits).toHaveLength(1)
  expect(calls.find(c => c.task === 'location-view-desc')!.sections.find(s => s.title === '需要的视角')!.body).toBe('站在石台侧面看向洞口')
  e.approve(store.openReviews().find(r => r.scope === 'e1/loc/封剑洞/侧面')!.id)
  await round(e)
  expect(store.locked('keyframe_desc', 'e1/g1/c2')).toBeTruthy()
  expect(store.locked('keyframe_desc', 'e1/g2/c2')).toBeTruthy()
  expect(store.latest('keyframe_desc', 'e1/g2/c1')).toBeUndefined()

  for (const cut of ['e1/g1/c1', 'e1/g1/c2', 'e1/g2/c2']) store.grant(cut, 'image', 1)
  await round(e)
  const prompt = (scope: string) => (store.latest('keyframe', scope)!.payload as { prompt: string }).prompt
  expect(prompt('e1/g1/c1')).toContain('图 2 是封剑洞的主图。')
  expect(prompt('e1/g1/c2')).toContain('图 3 是封剑洞的侧面。')
  expect(prompt('e1/g2/c2')).toContain('图 2 是封剑洞的侧面。')
  expect(store.latest('keyframe', 'e1/g2/c1')).toBeUndefined()

  // The review shows what has changed by each picture, as its description was told.
  const told = (n: number) => calls.filter(c => c.task === 'keyframe-desc')[n]!.sections.find(s => s.title === '此刻的状态')!.body
  const shown = (scope: string) => context(store, store.latest('keyframe', scope)!).find(c => c.title === '此刻的状态')!.body
  expect(told(2)).toBe('锁链束住双腕\n婚书展开')
  expect(shown('e1/g2/c2')).toBe('锁链束住双腕\n婚书展开')
  expect(told(1)).toBe('')
  expect(shown('e1/g1/c2')).toBe('没有变化，和锁定的图一样')
  // It is told what its camera position shows, where the light comes from and where everyone is.
  const section = (n: number, title: string) => calls.filter(c => c.task === 'keyframe-desc')[n]!.sections.find(s => s.title === title)!.body
  expect(section(0, '这个视角')).toBe('主图：封剑洞描述')
  expect(section(1, '这个视角')).toBe('相机：站在石台侧面看向洞口\n这个机位的图：从侧面看石台，洞口在画面右侧。')
  expect(section(0, '光源')).toBe('光源：洞口天光从南面照入')
  expect(section(2, '站位')).toContain('这一段开始时：\n谢无咎：石台前，站着，背对镜头')
  const clip = store.addArtifact({ kind: 'clip_draft', scope: 'e1/g2', payload: {}, created_by: 'model' })
  expect(context(store, clip)).toEqual([{ title: '这一段开始时的状态', body: '锁链束住双腕\n婚书展开' }])

  // A note on a keyframe rewrites its description, which comes back at ★6 with the prompt it would be drawn with.
  const first = store.openReviews().find(r => r.scope === 'e1/g1/c1')!
  e.revise(first.artifact_ids[0]!, '谢无咎再靠左', first.id)
  await round(e)
  const descReview = store.openReviews().find(r => r.scope === 'e1/g1/c1')!
  expect(descReview.point).toBe(6)
  expect(store.artifact(descReview.artifact_ids[0]!).kind).toBe('keyframe_desc')
  const noted = context(store, store.artifact(descReview.artifact_ids[0]!), e.env as EntityEnv)
  expect(noted.find(c => c.title === '你的意见')!.body).toBe('谢无咎再靠左')
  const preview = noted.find(c => c.title === '这次出图的提示词')!.body
  store.grant('e1/g1/c1', 'image', 1)
  await round(e)
  expect(store.latest('keyframe', 'e1/g1/c1')!.status).toBe('superseded')
  e.approve(descReview.id)
  await round(e)
  expect(prompt('e1/g1/c1')).toBe(preview)
})

/** A locked picture at `scope`, as if ★5 were done. */
function lockPicture(store: Store, scope: string) {
  const img = store.addArtifact({ kind: 'entity_image', scope, payload: { job_id: 0, prompt: scope }, media_id: store.putMedia(new TextEncoder().encode(scope), 'image/png'), status: 'locked', created_by: 'user' })
  store.addArtifact({ kind: 'entity_lock', scope, payload: { image_id: img.id }, inputs: [img.id], status: 'locked', created_by: 'user' })
}

test('a cut binds the costume worn through its segment, and a name for several people binds the flat lay', async () => {
  const store = project()
  const roster = { ...ROSTER, characters: [{ ...ROSTER.characters[0]!, count: 2 }, { ...ROSTER.characters[1]!, costumes: [{ name: '嫁衣', from: 'b3' }] }] }
  store.db.prepare('UPDATE artifact SET payload = ? WHERE id = ?').run(JSON.stringify(roster), store.locked('roster', 'e1')!.id)
  const costume = 'e1/char/柳含烟/造型/嫁衣'
  store.addArtifact({ kind: 'entity_brief', scope: costume, payload: { text: '锚点：凤冠\n主色：大红' }, status: 'locked', created_by: 'user' })
  store.addArtifact({ kind: 'entity_desc', scope: costume, payload: { text: '嫁衣描述' }, status: 'locked', created_by: 'user' })
  lockPicture(store, costume)
  lockPicture(store, 'e1/char/谢无咎/服装平铺')
  const calls: Call[] = []
  const e = engine(store, fakeText(calls))
  await upToViews(e, store)
  expect((calls.find(c => c.task === 'segment-plan')!.data as PlanData).changes).toEqual([{ name: '柳含烟', costume: '嫁衣', from: 'b3' }])
  expect(calls.find(c => c.task === 'segment-plan')!.sections.find(s => s.title === '换装')!.body).toBe('柳含烟从 b3 起换上嫁衣')

  store.grant('e1/loc/封剑洞', 'image', 1)
  await round(e)
  e.approve(store.openReviews().find(r => r.scope === 'e1/loc/封剑洞/侧面')!.id)
  await round(e)
  for (const cut of ['e1/g1/c1', 'e1/g1/c2', 'e1/g2/c2']) store.grant(cut, 'image', 1)
  await round(e)
  const prompt = (scope: string) => (store.latest('keyframe', scope)!.payload as { prompt: string }).prompt
  expect(prompt('e1/g1/c1')).toContain('图 1 是谢无咎的服装平铺（2 个人都穿这一套，脸和身形各不相同）。')
  // Before the change she wears the opening costume; the segment that starts at it binds the new one and its colours.
  expect(prompt('e1/g1/c2')).toContain('图 2 是柳含烟的定妆照。')
  expect(prompt('e1/g2/c2')).toContain('图 1 是柳含烟（嫁衣）的定妆照。')
  const g2c2 = calls.filter(c => c.task === 'keyframe-desc').find(c => c.sections.find(s => s.title === '参考图')!.body.includes('嫁衣'))!
  expect(g2c2.sections.find(s => s.title === '人物主色')!.body).toBe('柳含烟：大红')
})

test('a picture drawn earlier can be adopted for a view without drawing again', async () => {
  const store = project()
  const images = fakeImages()
  const e = engine(store, fakeText(), images)
  await upToViews(e, store)
  const old = store.latest('entity_image', 'e1/loc/封剑洞')!
  const review = e.adopt(old.id, 'e1/loc/封剑洞/侧面')
  const draft = store.latest('entity_image', 'e1/loc/封剑洞/侧面')!
  expect(draft.media_id).toBe(old.media_id)
  expect(store.inputsOf(draft.id)).toContain(store.locked('view_plan', 'e1/loc/封剑洞')!.id)
  expect(() => e.adopt(old.id, 'e1/loc/封剑洞/侧面')).toThrow('已经有图了')
  expect(() => e.adopt(old.id, 'e1/loc/封剑洞/没有这个机位')).toThrow()
  e.approve(review)
  expect(store.locked('entity_lock', 'e1/loc/封剑洞/侧面')).toBeTruthy()
  await round(e)
  expect(store.locked('keyframe_desc', 'e1/g1/c2')).toBeTruthy()
  expect(images.submits).toHaveLength(0)
})

test('a timeline stored before back views were marked still reads, as portraits', async () => {
  const store = project()
  const e = engine(store)
  await upToViews(e, store)
  await round(e)
  expect(store.locked('keyframe_desc', 'e1/g1/c1')).toBeTruthy()
  const tl = store.locked('timeline', 'e1/g1')!
  const old = { ...(tl.payload as TimelineT), cuts: (tl.payload as TimelineT).cuts.map(c => ({ ...c, present: { characters: c.present.characters, props: c.present.props, view: c.present.view } })) }
  store.db.prepare('UPDATE artifact SET payload = ? WHERE id = ?').run(JSON.stringify(old), tl.id)
  expect(() => e.tick(true)).not.toThrow()
})
