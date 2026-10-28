import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageRequest } from '../src/jobs/images.js'
import { Engine, type NodeDef, type TextRunner } from '../src/pipeline/engine.js'
import { ENTITY_NODES, type EntityEnv } from '../src/pipeline/entities.js'
import { loadPlugins } from '../src/plugins.js'
import type { Section } from '../src/runner.js'
import { Store } from '../src/store/store.js'
import type { ImageClient } from '../src/yir.js'

const ROOT = join(import.meta.dir, '..')
const style = loadPlugins(join(ROOT, 'config/plugins')).plugins.get('style:3d-guoman')!

const beat = (id: string, action: string, seconds = 5) => ({ id, action, lines: [], seconds, changes: [] })
const SCRIPT = { scenes: [{ id: 's1', location: '封剑洞', beats: [beat('b1', '谢无咎跪在石台上。'), beat('b2', '柳含烟抽出婚书。')] }] }
const person = (name: string) => ({ name, gender: '男', age_look: '约三十岁', rank: '剑修', tier: '男主', needs: '跪着', temperament: '隐忍', appearance_lines: [] })
const ROSTER = {
  characters: [person('谢无咎'), person('柳含烟')],
  locations: [{ name: '封剑洞', beats: ['b1', 'b2'] }],
  props: [{ name: '石台', holder: '固定在洞中央', beats: ['b1'] }, { name: '婚书', holder: '柳含烟藏在袖中', beats: ['b2'] }],
}

function project() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'yx-engine-')))
  store.createProject({ name: '样片', entry: 'script', style: '3d-guoman', genre: 'xianxia', seconds_min: 45, seconds_max: 60, delivery: '1080p' })
  store.addArtifact({ kind: 'style_ref', scope: 'p', payload: {}, status: 'locked', created_by: 'program' })
  const script = store.addArtifact({ kind: 'script', scope: 'e1', payload: SCRIPT, status: 'locked', created_by: 'user' })
  store.addArtifact({ kind: 'roster', scope: 'e1', payload: ROSTER, inputs: [script.id], status: 'locked', created_by: 'user' })
  return store
}

/** The writer: a location brief places the stone table but not the marriage letter, which is carried. */
function fakeText(calls: { task: string; sections: Section[] }[] = []): TextRunner {
  return async ({ card, sections }) => {
    calls.push({ task: card.name, sections })
    // A creator's instruction changes the design; the note for an upstream change alone does not. A description follows its brief.
    const asked = sections.find(s => s.title === '创作者的修改意见')?.body
    const change = asked && !asked.startsWith('它用到的上游') ? `\n修改：${asked}` : ''
    const output = card.name === 'character-design' ? `脸型：长脸\n身高：比门框矮半头\n主色：白\n区分：散发${change}` : card.name === 'location-design' ? `陈设：石台居中\n道具位置：石台在洞中央${change}` : card.name === 'prop-design' ? `形制：长方${change}` : `${card.name}：${sections[0]!.body}`
    return { output, raw: output, attempts: [], system: '', user: '', promptVersion: 'v', model: 'fake' }
  }
}

type Fake = ImageClient & { submits: ImageRequest['prompt'][]; refs: string[][] }
function fakeImages(hold = false): Fake {
  let n = 0
  const fake = {
    submits: [] as string[],
    refs: [] as string[][],
    async submit(_key: string, prompt: string, _params: Record<string, unknown>, references: string[] = []) {
      fake.submits.push(prompt)
      fake.refs.push(references)
      return { providerJob: `job-${++n}`, quotedUsd: 0.007 }
    },
    async poll() { return 'succeeded' as const },
    async wait() { if (hold) await new Promise(() => {}) },
    async download(providerJob: string) { return { bytes: new TextEncoder().encode(providerJob), mime: 'image/png' } },
    async generate() { throw new Error('not used') },
  }
  return fake as unknown as Fake
}

const engine = (store: Store, text = fakeText(), images = fakeImages()) => new Engine({ store, root: ROOT, text, images, style } as EntityEnv, ENTITY_NODES)
async function round(e: Engine) {
  const pending = e.tick()
  await e.settle()
  return pending
}
const approveAll = (e: Engine, store: Store, point: number) => store.openReviews().filter(r => r.point === point).forEach(r => e.approve(r.id))
const pickFirst = (e: Engine, store: Store) => store.openReviews().filter(r => r.point === 5 && r.artifact_ids.length > 1).forEach(r => e.pick(r.id, r.artifact_ids[0]!))

test('the second character is designed after the first, seeing its colours', async () => {
  const store = project()
  const calls: { task: string; sections: Section[] }[] = []
  const e = engine(store, fakeText(calls))
  await round(e)
  expect(store.latest('entity_brief', 'e1/char/谢无咎')?.status).toBe('draft')
  expect(store.latest('entity_brief', 'e1/char/柳含烟')).toBeUndefined()
  await round(e)
  const second = calls.find(c => c.task === 'character-design' && c.sections[0]!.body.startsWith('柳含烟'))!
  expect(second.sections.find(s => s.title === '同集其他人物')!.body).toBe('谢无咎：主色 白；散发；身高 比门框矮半头')
})

test('a character is told the names of his props, not how they change hands', async () => {
  const store = project()
  const calls: { task: string; sections: Section[] }[] = []
  const e = engine(store, fakeText(calls))
  await round(e)
  await round(e)
  const props = (name: string) => calls.find(c => c.task === 'character-design' && c.sections[0]!.body.startsWith(name))!.sections.find(s => s.title === '和他有关的道具')!.body
  expect(props('谢无咎')).toBe('')
  expect(props('柳含烟')).toBe('婚书')
})

test('props are designed in order, and a location waits for its props and is told who holds them', async () => {
  const store = project()
  const calls: { task: string; sections: Section[] }[] = []
  const e = engine(store, fakeText(calls))
  await round(e)
  expect(calls.map(c => c.task).filter(t => t !== 'character-design').sort()).toEqual(['prop-design'])
  await round(e)
  const letter = calls.find(c => c.task === 'prop-design' && c.sections[0]!.body === '婚书')!
  expect(letter.sections.find(s => s.title === '已设计的道具')!.body).toBe('石台\n形制：长方')
  await round(e)
  const cave = calls.find(c => c.task === 'location-design')!
  expect(cave.sections.find(s => s.title === '场内的关键道具')!.body).toBe('石台：固定在洞中央\n婚书：柳含烟藏在袖中')
})

test('a location is designed from the episode setup and the screenplay\'s setting, as in the location experiments', async () => {
  const store = project()
  const setup = store.addArtifact({ kind: 'setup', scope: 'e1', payload: { text: '世界一角：青冥宗\n规则：同心印\n地点：\n封剑洞：青冥宗禁地，五百年无人\n独有时刻：膝印' }, status: 'locked', created_by: 'user' })
  const script = store.locked('script', 'e1')!
  store.db.prepare('UPDATE artifact SET payload = ? WHERE id = ?').run(JSON.stringify({ scenes: [{ ...SCRIPT.scenes[0], setting: '洞顶垂下四根锁链。' }] }), script.id)
  const calls: { task: string; sections: Section[] }[] = []
  const e = engine(store, fakeText(calls))
  for (let i = 0; i < 3; i++) await round(e)
  const cave = calls.find(c => c.task === 'location-design')!
  expect(cave.sections.map(s => s.title)).toEqual(['地点', '本集设定里的世界和地点', '剧本里这个地点的环境', '在这里发生的剧情', '场内的关键道具', '已设计的地点'])
  expect(cave.sections[1]!.body).toBe('世界一角：青冥宗\n\n地点：\n封剑洞：青冥宗禁地，五百年无人')
  expect(cave.sections[2]!.body).toBe('洞顶垂下四根锁链。')
  expect(store.inputsOf(store.latest('entity_brief', 'e1/loc/封剑洞')!.id)).toContain(setup.id)
})

test('nothing is drawn without permission, and two candidates take two units', async () => {
  const store = project()
  const images = fakeImages()
  const e = engine(store, fakeText(), images)
  await round(e)
  await round(e)
  approveAll(e, store, 4)
  await round(e)
  await round(e)
  const pending = await round(e)
  expect(images.submits).toHaveLength(0)
  expect(pending.map(p => p.scope).sort()).toEqual(['e1/char/柳含烟', 'e1/char/谢无咎', 'e1/prop/婚书', 'e1/prop/石台'])
  store.grant('e1/char/谢无咎', 'image', 3)
  await round(e)
  expect(images.submits).toHaveLength(2)
  expect(store.permitsLeft('e1/char/谢无咎', 'image')).toBe(1)
})

test('the scene waits for the props it places and binds the style reference and only those props', async () => {
  const store = project()
  const images = fakeImages()
  const e = engine(store, fakeText(), images)
  store.grant('e1', 'image', 100)
  for (let i = 0; i < 4; i++) {
    await round(e)
    approveAll(e, store, 4)
  }
  expect(store.latest('entity_image', 'e1/loc/封剑洞')).toBeUndefined()
  pickFirst(e, store)
  await round(e)
  const scene = store.artifacts('entity_image', 'e1/loc/封剑洞', ['draft'])
  expect(scene).toHaveLength(2)
  const prompt = (scene[0]!.payload as { prompt: string }).prompt
  expect(prompt).toContain('图 1 是风格参考图。图 2 是石台的设定图。')
  expect(prompt).not.toContain('婚书')
  const sceneRefs = images.refs.filter((_, i) => images.submits[i]!.includes('风格参考图'))
  expect(sceneRefs.map(r => r.length)).toEqual([2, 2])
})

test('picking a portrait leads to its three-view and face close-up', async () => {
  const store = project()
  const e = engine(store)
  store.grant('e1', 'image', 100)
  for (let i = 0; i < 4; i++) {
    await round(e)
    approveAll(e, store, 4)
  }
  pickFirst(e, store)
  await round(e)
  const turnaround = store.latest('entity_image', 'e1/char/谢无咎/三视图')!
  expect(turnaround.status).toBe('draft')
  expect((turnaround.payload as { prompt: string }).prompt).toContain('图 1 是谢无咎的定妆照。')
})

test('a revise from the review reruns with the previous version and the instruction', async () => {
  const store = project()
  const calls: { task: string; sections: Section[] }[] = []
  const e = engine(store, fakeText(calls))
  await round(e)
  await round(e)
  const review = store.openReviews().find(r => r.scope === 'e1/prop/婚书')!
  const v1 = review.artifact_ids[0]!
  e.revise(v1, '婚书改成竹简', review.id)
  expect(store.artifact(v1).status).toBe('superseded')
  await round(e)
  const last = calls.filter(c => c.task === 'prop-design').at(-1)!
  expect(last.sections.slice(-2)).toEqual([{ title: '上一版', body: '形制：长方' }, { title: '创作者的修改意见', body: '婚书改成竹简' }])
  expect(store.latest('entity_brief', 'e1/prop/婚书')!.version).toBe(2)
})

test('revising the first character in review stales the second, which was written from its draft', async () => {
  const store = project()
  const e = engine(store)
  await round(e)
  await round(e)
  const second = store.latest('entity_brief', 'e1/char/柳含烟')!
  const review = store.openReviews().find(r => r.scope === 'e1/char/谢无咎')!
  e.revise(review.artifact_ids[0]!, '更年轻', review.id)
  expect(store.artifact(second.id).status).toBe('stale')
  expect(store.openReviews().some(r => r.artifact_ids.includes(second.id))).toBe(false)
})

test('a design that went stale because an upstream changed is rewritten from its last version', async () => {
  const store = project()
  const calls: { task: string; sections: Section[] }[] = []
  const e = engine(store, fakeText(calls))
  await round(e)
  await round(e)
  approveAll(e, store, 4)
  e.revise(store.locked('entity_brief', 'e1/char/谢无咎')!.id, '改成散发')
  await round(e)
  approveAll(e, store, 4)
  expect(store.locked('entity_brief', 'e1/char/柳含烟')).toBeUndefined()
  await round(e)
  const redo = calls.filter(c => c.task === 'character-design' && c.sections[0]!.body.startsWith('柳含烟')).at(-1)!
  const tail = redo.sections.slice(-2)
  expect(tail[0]).toEqual({ title: '上一版', body: '脸型：长脸\n身高：比门框矮半头\n主色：白\n区分：散发' })
  expect(tail[1]!.title).toBe('创作者的修改意见')
  expect(tail[1]!.body).toContain('照上一版写')
  expect(tail[1]!.body).toContain('有新版本的上游：谢无咎的外观设计（第 2 版）')
})

test('a picture is not drawn while something upstream is being revised', async () => {
  const store = project()
  const images = fakeImages()
  const e = engine(store, fakeText(), images)
  for (let i = 0; i < 4; i++) {
    await round(e)
    approveAll(e, store, 4)
  }
  const scope = 'e1/prop/婚书'
  store.grant(scope, 'image', 2)
  e.revise(store.locked('entity_brief', scope)!.id, '画展开的样子')
  e.tick()
  expect(images.submits).toHaveLength(0)
  await e.settle()
  expect(images.submits).toHaveLength(0)
  expect(store.latest('entity_brief', scope)!.status).toBe('draft')
  approveAll(e, store, 4)
  await round(e)
  expect(store.locked('entity_desc', scope)!.version).toBe(2)
  await round(e)
  expect(images.submits).toHaveLength(2)
  expect(store.artifacts('entity_image', scope, ['draft']).every(a => store.inputsOf(a.id).includes(store.locked('entity_desc', scope)!.id))).toBe(true)
})

test('when the rewrite for an upstream change comes out the same, the old version and its pictures stand', async () => {
  const store = project()
  const images = fakeImages()
  const e = engine(store, fakeText(), images)
  store.grant('e1', 'image', 100)
  for (let i = 0; i < 4; i++) {
    await round(e)
    approveAll(e, store, 4)
  }
  pickFirst(e, store)
  await round(e)
  const scope = 'e1/prop/婚书'
  const before = { brief: store.locked('entity_brief', scope)!.id, desc: store.locked('entity_desc', scope)!.id, lock: store.locked('entity_lock', scope)!.id }
  const drawn = images.submits.length
  e.revise(store.locked('entity_brief', 'e1/prop/石台')!.id, '石台更高')
  await round(e)
  approveAll(e, store, 4)
  expect(store.artifact(before.brief).status).toBe('stale')
  await round(e)
  expect(store.locked('entity_brief', scope)!.id).toBe(before.brief)
  expect([before.desc, before.lock].map(id => store.artifact(id).status)).toEqual(['locked', 'locked'])
  expect(store.openReviews().some(r => r.scope === scope)).toBe(false)
  expect(store.inputsOf(before.brief)).toContain(store.locked('entity_brief', 'e1/prop/石台')!.id)
  await round(e)
  expect(images.submits.filter((_, i) => i >= drawn && images.submits[i]!.includes('婚书'))).toHaveLength(0)
})

test('a new locked brief stales its description, pictures, lock and derived pictures, and they are redone', async () => {
  const store = project()
  const e = engine(store)
  store.grant('e1', 'image', 100)
  for (let i = 0; i < 4; i++) {
    await round(e)
    approveAll(e, store, 4)
  }
  pickFirst(e, store)
  await round(e)
  const scope = 'e1/char/谢无咎'
  const old = { desc: store.locked('entity_desc', scope)!.id, lock: store.locked('entity_lock', scope)!.id, face: store.latest('entity_image', `${scope}/脸部特写`)!.id }
  e.revise(store.locked('entity_brief', scope)!.id, '改成四十岁')
  await round(e)
  approveAll(e, store, 4)
  expect([old.desc, old.lock, old.face].map(id => store.artifact(id).status)).toEqual(['stale', 'stale', 'stale'])
  await round(e)
  expect(store.locked('entity_desc', scope)!.version).toBe(2)
})

test('after a crash mid-picture, the restart resumes the same jobs and spends no new permission', async () => {
  const store = project()
  const first = fakeImages(true)
  const e1 = engine(store, fakeText(), first)
  await round(e1)
  await round(e1)
  approveAll(e1, store, 4)
  await round(e1)
  store.grant('e1/prop/石台', 'image', 2)
  e1.tick()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(first.submits).toHaveLength(2)
  expect(store.jobs(['submitted'])).toHaveLength(2)

  const second = fakeImages()
  const e2 = engine(store, fakeText(), second)
  e2.recover()
  await round(e2)
  expect(second.submits).toHaveLength(0)
  expect(store.artifacts('entity_image', 'e1/prop/石台', ['draft'])).toHaveLength(2)
  expect(store.jobs(['succeeded'])).toHaveLength(2)
  expect(store.permitsLeft('e1/prop/石台', 'image')).toBe(0)
})

test('a failed node waits for retry', async () => {
  const store = project()
  const broken: TextRunner = async () => { throw new Error('模型不可用') }
  const e = engine(store, broken)
  await round(e)
  const run = store.latestNodeRun('brief', 'e1/prop/石台')!
  expect(run.status).toBe('failed')
  await round(e)
  expect(store.latestNodeRun('brief', 'e1/prop/石台')!.id).toBe(run.id)
  e.retry(run.id)
  expect(store.nodeRun(run.id).status).toBe('queued')
})

test('a node whose readiness check throws is reported once and skipped; the others still run', async () => {
  const store = project()
  const events: string[] = []
  const bad: NodeDef = { name: 'bad', pool: 'text', output: 'bad_out', scopes: () => ['e1'], ready() { throw new Error('旧数据缺字段') }, run: async () => [] }
  const good: NodeDef = { name: 'good', pool: 'text', output: 'good_out', scopes: () => ['e1'], ready: () => ({ ok: true, inputs: [] }), run: async (env, scope, run) => [env.store.addArtifact({ kind: 'good_out', scope, payload: {}, node_run_id: run.id, created_by: 'program' }).id] }
  const e = new Engine({ store, root: ROOT, text: fakeText(), images: fakeImages(), style } as EntityEnv, [bad, good], ev => events.push(`${ev.type} ${ev.node} ${ev.detail ?? ''}`))
  expect(() => e.tick()).not.toThrow()
  await e.settle()
  expect(() => e.tick()).not.toThrow()
  expect(store.locked('good_out', 'e1')).toBeTruthy()
  expect(e.broken.get('bad e1')).toBe('旧数据缺字段')
  expect(events.filter(x => x.startsWith('failed bad'))).toEqual(['failed bad 调度时出错：旧数据缺字段'])
})

test('a note on a portrait rewrites its description, and the picture is drawn again from it; a turnaround takes no note', async () => {
  const store = project()
  const calls: { task: string; sections: Section[] }[] = []
  const images = fakeImages()
  const e = engine(store, fakeText(calls), images)
  for (let i = 0; i < 3; i++) {
    await round(e)
    approveAll(e, store, 4)
  }
  store.grant('e1', 'image', 20)
  await round(e)
  const review = store.openReviews().find(r => r.point === 5 && r.scope === 'e1/char/谢无咎')!
  expect(e.revisable(review.artifact_ids[0]!)).toBe(true)
  e.revise(review.artifact_ids[0]!, '头发改成半束', review.id)
  expect(store.latestNodeRun('desc', 'e1/char/谢无咎')!.instruction).toBe('头发改成半束')
  await round(e)
  const rewrite = calls.filter(c => c.task === 'portrait-desc').at(-1)!
  expect(rewrite.sections.find(s => s.title === '创作者的修改意见')!.body).toBe('头发改成半束')
  const drawn = images.submits.length
  await round(e)
  expect(images.submits.length).toBe(drawn + 2)
  e.pick(store.openReviews().find(r => r.point === 5 && r.scope === 'e1/char/谢无咎')!.id, store.latest('entity_image', 'e1/char/谢无咎', ['draft'])!.id)
  await round(e)
  const turnaround = store.openReviews().find(r => r.scope === 'e1/char/谢无咎/三视图')!
  expect(e.revisable(turnaround.artifact_ids[0]!)).toBe(false)
  expect(() => e.revise(turnaround.artifact_ids[0]!, '换个角度', turnaround.id)).toThrow('只能「重出」')
})

test('a note on one candidate draws new ones from it, and it stays in the next review beside them', async () => {
  const store = project()
  const images = fakeImages()
  const e = engine(store, fakeText(), images)
  for (let i = 0; i < 3; i++) {
    await round(e)
    approveAll(e, store, 4)
  }
  store.grant('e1/char/谢无咎', 'image', 2)
  await round(e)
  const review = store.openReviews().find(r => r.point === 5 && r.scope === 'e1/char/谢无咎')!
  const [first, second] = review.artifact_ids as [number, number]
  expect(e.editable(second)).toBe(true)
  e.edit(review.id, second, '袍子换成深青色')
  expect(store.artifact(first).status).toBe('superseded')
  expect(store.artifact(second).status).toBe('draft')
  const drawn = images.submits.length
  const pending = await round(e)
  expect(images.submits.length).toBe(drawn)
  expect(pending.some(p => p.scope === 'e1/char/谢无咎' && p.count === 2)).toBe(true)
  store.grant('e1/char/谢无咎', 'image', 2)
  await round(e)
  expect(images.submits.slice(drawn)).toHaveLength(2)
  for (const [i, prompt] of images.submits.slice(drawn).entries()) {
    expect(prompt).toContain('图 1 是要改的这张图。')
    expect(prompt).toContain('照图 1 改：袍子换成深青色\n除了这处修改，脸、发型、服装、饰物、颜色、身形和构图都和图 1 一致，不重新设计。')
    expect(images.refs[drawn + i]).toEqual([store.mediaPath(store.artifact(second).media_id!)])
  }
  const next = store.openReviews().find(r => r.point === 5 && r.scope === 'e1/char/谢无咎')!
  expect(next.artifact_ids).toHaveLength(3)
  expect(next.artifact_ids[0]).toBe(second)
  expect(next.artifact_ids.slice(1).map(id => store.artifact(id).payload)).toEqual(next.artifact_ids.slice(1).map(id => expect.objectContaining({ edited_from: second, instruction: '袍子换成深青色' })))
  e.pick(next.id, second)
  expect(store.locked('entity_image', 'e1/char/谢无咎')!.id).toBe(second)
  store.grant('e1/char/谢无咎/三视图', 'image', 1)
  await round(e)
  const turnaround = store.openReviews().find(r => r.scope === 'e1/char/谢无咎/三视图')!
  expect(e.editable(turnaround.artifact_ids[0]!)).toBe(false)
  expect(() => e.edit(turnaround.id, turnaround.artifact_ids[0]!, '换个角度')).toThrow('不能照着改')
})
