import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type TextRunner } from '../src/pipeline/engine.js'
import { ENTITY_NODES, type EntityEnv } from '../src/pipeline/entities.js'
import { STORYBOARD_NODES } from '../src/pipeline/storyboard.js'
import { loadPlugins } from '../src/plugins.js'
import type { Section } from '../src/runner.js'
import { Store } from '../src/store/store.js'
import type { PlanT, TimelineT } from '../src/tasks.js'
import type { ImageClient } from '../src/yir.js'

const ROOT = join(import.meta.dir, '..')
const style = loadPlugins(join(ROOT, 'config/plugins')).plugins.get('style:3d-guoman')!
const beat = (id: string, action: string) => ({ id, action, lines: [], seconds: 5, changes: [] })
const SCRIPT = { scenes: [{ id: 's1', location: '封剑洞', beats: [beat('b1', '谢无咎站起。')] }, { id: 's2', location: '封剑洞外', beats: [beat('b2', '谢无咎走出洞口。')] }] }
const ROSTER = {
  characters: [{ name: '谢无咎', gender: '男', age_look: '看起来三十岁', rank: '剑修', tier: '男主', needs: '', temperament: '', appearance_lines: [] }],
  locations: [{ name: '封剑洞', beats: ['b1'] }, { name: '封剑洞外', beats: ['b2'] }],
  props: [],
}
const PLAN: PlanT = { segments: [{ id: 'g1', beats: ['b1', 'b2'], seconds: 10, location: '封剑洞', continues: false, summary: '出洞' }], overflow: [] }
const TL: TimelineT = {
  seconds: 10,
  cuts: [
    { index: 1, start: 0, end: 5, camera: '固定', shot: '全景', present: { characters: ['谢无咎'], backs: [], props: [], view: '主视角' }, location: '封剑洞' },
    { index: 2, start: 5, end: 10, camera: '跟拍', shot: '中景', present: { characters: ['谢无咎'], backs: [], props: [], view: '主视角' }, location: '封剑洞外' },
  ],
  timeline: Array.from({ length: 10 }, (_, second) => ({ second, text: `第${second}秒`, changes: [] })),
  lines: [], ambience: '风', fight: false,
}

test('a segment that crosses scenes puts each shot at its own location: camera groups, views and keyframes', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'yx-cross-')))
  store.createProject({ name: '样片', entry: 'script', style: '3d-guoman', genre: 'xianxia', seconds_min: 1, seconds_max: 60, delivery: '1080p' })
  store.addArtifact({ kind: 'style_ref', scope: 'p', payload: {}, status: 'locked', created_by: 'program' })
  const script = store.addArtifact({ kind: 'script', scope: 'e1', payload: SCRIPT, status: 'locked', created_by: 'user' })
  store.addArtifact({ kind: 'roster', scope: 'e1', payload: ROSTER, inputs: [script.id], status: 'locked', created_by: 'user' })
  for (const [kind, name] of [['char', '谢无咎'], ['loc', '封剑洞'], ['loc', '封剑洞外']] as const) {
    const scope = `e1/${kind}/${name}`
    store.addArtifact({ kind: 'entity_brief', scope, payload: { text: '主色：白\n陈设：石台' }, status: 'locked', created_by: 'user' })
    store.addArtifact({ kind: 'entity_desc', scope, payload: { text: name }, status: 'locked', created_by: 'user' })
    for (const s of kind === 'char' ? [scope, `${scope}/三视图`, `${scope}/脸部特写`] : [scope]) {
      const img = store.addArtifact({ kind: 'entity_image', scope: s, payload: {}, media_id: store.putMedia(new TextEncoder().encode(s), 'image/png'), status: 'locked', created_by: 'user' })
      store.addArtifact({ kind: 'entity_lock', scope: s, payload: { image_id: img.id }, inputs: [img.id], status: 'locked', created_by: 'user' })
    }
  }
  const calls: { task: string; sections: Section[]; data?: unknown }[] = []
  const reply = (output: unknown) => ({ output, raw: '', attempts: [], system: '', user: '', promptVersion: 'v', model: 'fake' })
  const text: TextRunner = async ({ card, sections, data }) => {
    calls.push({ task: card.name, sections, data })
    if (card.name === 'segment-plan') return reply(PLAN)
    if (card.name === 'timeline') return reply(TL)
    if (card.name === 'view-groups') return reply({ views: [{ name: '主视角', camera: '', cuts: (data as { cuts: string[] }).cuts }] })
    return reply('关键帧描写')
  }
  const submits: string[] = []
  const images = { async submit(_k: string, prompt: string) { submits.push(prompt); return { providerJob: `j${submits.length}`, quotedUsd: 0 } }, async poll() { return 'succeeded' }, async wait() {}, async download(id: string) { return { bytes: new TextEncoder().encode(id), mime: 'image/png' } } } as unknown as ImageClient
  const e = new Engine({ store, root: ROOT, text, images, style } as EntityEnv, [...ENTITY_NODES, ...STORYBOARD_NODES])
  store.grant('e1', 'image', 10)
  for (let i = 0; i < 6; i++) {
    e.tick()
    await e.settle()
  }
  const timeline = calls.find(c => c.task === 'timeline')!
  expect(timeline.sections[0]!.body).toContain('地点：封剑洞 → 封剑洞外')
  expect((timeline.data as { locations: string[] }).locations).toEqual(['封剑洞', '封剑洞外'])
  const groups = calls.filter(c => c.task === 'view-groups').map(c => (c.data as { cuts: string[] }).cuts)
  expect(groups).toContainEqual(['g1/c1'])
  expect(groups).toContainEqual(['g1/c2'])
  const prompt = (scope: string) => (store.latest('keyframe', scope)!.payload as { prompt: string }).prompt
  expect(prompt('e1/g1/c1')).toContain('封剑洞的主图')
  expect(prompt('e1/g1/c2')).toContain('封剑洞外的主图')
})
