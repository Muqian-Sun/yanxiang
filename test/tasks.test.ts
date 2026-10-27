import { expect, test } from 'bun:test'
import { CARDS } from '../src/tasks.js'

const check = (name: string, out: unknown, data?: unknown) => CARDS[name]!.checks!(out as never, data as never)

test('a description that writes the background is sent back', () => {
  expect(check('portrait-desc', '她站在浅灰背景前，长发及腰。')).toHaveLength(1)
  expect(check('portrait-desc', '她长发及腰，发尾微卷。')).toEqual([])
  expect(check('portrait-desc', '她正面朝镜头，颈部挺直。')).toEqual([])
})

test('a scene description may write its light but not the camera', () => {
  expect(check('location-desc', '门缝透进一道冷白光线，照亮地面。')).toEqual([])
  expect(check('location-desc', '机位放在大殿门口。')).toHaveLength(1)
})

test('a character design without the colour and distinction lines is sent back', () => {
  expect(check('character-design', '脸型：鹅蛋脸\n发型：半挽半披')).toHaveLength(2)
  expect(check('character-design', '脸型：鹅蛋脸\n主色：雪白，辅色石青\n区分：唯一穿白的人')).toEqual([])
})

const timeline = (lines: { speaker: string; text: string; start: number; end: number }[]) => ({
  seconds: 4,
  cuts: [{ index: 1, start: 0, end: 4, camera: '固定', shot: '中景', present: { characters: [], props: [], view: '主视角' } }],
  timeline: [0, 1, 2, 3].map(second => ({ second, text: '动作', changes: [] })),
  lines,
  ambience: '风声',
})

test('a timeline that changes a word of the dialogue is sent back', () => {
  const data = { seconds: 4, lines: [{ speaker: '沈照雪', text: '祖师在上。' }] }
  expect(check('timeline', timeline([{ speaker: '沈照雪', text: '祖师在上。', start: 1, end: 3 }]), data)).toEqual([])
  expect(check('timeline', timeline([{ speaker: '沈照雪', text: '祖师在上！', start: 1, end: 3 }]), data)).toHaveLength(2)
})

test('a plan that leaves a beat out is sent back', () => {
  const data = { beats: ['b1', 'b2'], lines: [], min: 96, max: 144, locations: ['石殿'] }
  const plan = (beats: string[]) => ({ segments: [{ id: 'g1', beats, seconds: 8, location: '石殿', continues: false, summary: '开场' }], overflow: [] })
  expect(check('segment-plan', plan(['b1', 'b2']), data)).toEqual([])
  expect(check('segment-plan', plan(['b1']), data)).toEqual(['这些拍没有落进任何一段：b2'])
})

test('a plan that names a location outside the roster is sent back', () => {
  const data = { beats: ['b1'], lines: [], min: 96, max: 144, locations: ['封剑洞外'] }
  const plan = (location: string) => ({ segments: [{ id: 'g1', beats: ['b1'], seconds: 8, location, continues: false, summary: '回望' }], overflow: [] })
  expect(check('segment-plan', plan('封剑洞外'), data)).toEqual([])
  expect(check('segment-plan', plan('封剑洞外（望向洞内石台）'), data)).toHaveLength(1)
})

test('view groups must place every cut exactly once and describe each non-main camera', () => {
  const data = { cuts: ['g1/c1', 'g1/c2', 'g2/c2'] }
  const ok = { views: [{ name: '主视角', camera: '', cuts: ['g1/c1', 'g2/c2'] }, { name: '反打', camera: '站在石台后看向洞口', cuts: ['g1/c2'] }] }
  expect(check('view-groups', ok, data)).toEqual([])
  expect(check('view-groups', { views: [{ name: '主视角', camera: '', cuts: ['g1/c1', 'g1/c2'] }] }, data)).toEqual(['这些镜头没有归到任何机位：g2/c2'])
  expect(check('view-groups', { views: [...ok.views, { name: '侧面', camera: '侧面', cuts: ['g1/c2'] }] }, data)).toEqual(['这些镜头归到了不止一个机位：g1/c2'])
  expect(check('view-groups', { views: [ok.views[0]!, { name: '反打', camera: ' ', cuts: ['g1/c2'] }] }, data)).toEqual(['这些机位没写相机站位和朝向：反打'])
})

test('a trim whose out point is not after its in point or past the end is sent back', () => {
  expect(check('trim', { in: 0.92, out: 7.5, reason: '开头是重放，结尾空转' }, { seconds: 8 })).toEqual([])
  expect(check('trim', { in: 3, out: 2, reason: '' }, { seconds: 8 })).toHaveLength(1)
  expect(check('trim', { in: 0, out: 9, reason: '' }, { seconds: 8 })).toHaveLength(1)
})

test('the assistant may only act on artifacts it was shown', () => {
  const data = { targets: ['A12', 'A7'] }
  expect(check('assistant', { kind: 'revise', target: 'A7', instruction: '外衫加刺绣', confirm: '对吗？' }, data)).toEqual([])
  expect(check('assistant', { kind: 'approve', target: 'A99' }, data)).toHaveLength(1)
  expect(check('assistant', { kind: 'ask', question: '你说的是哪一张？' }, data)).toEqual([])
})
