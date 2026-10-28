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

const design = '性别与年龄：男，看起来二十岁\n脸型：窄长脸\n随身佩物：腰牌挂在右侧腰带下\n锚点：窄长脸、顶髻\n身高：头顶低于门框上沿一掌\n主色：浅青灰\n区分：无冠顶髻'

test('a character design without the colour and distinction lines is sent back', () => {
  expect(check('character-design', '脸型：鹅蛋脸\n发型：半挽半披', { others: [] })).toHaveLength(5)
  expect(check('character-design', '性别与年龄：女，看起来二十四岁\n脸型：鹅蛋脸\n锚点：鹅蛋脸、半挽发髻\n身高：头顶与门框上沿齐平\n主色：雪白，辅色石青\n区分：唯一穿白的人', { others: [] })).toEqual([])
})

test('a character design that gives him a thing named like someone else\'s prop is sent back', () => {
  const others = [{ name: '腰牌', holder: '赵衡，最终炸裂' }, { name: '名册', holder: '赵衡→守卫' }]
  expect(check('character-design', design, { others })).toEqual(['这些是本集别人的道具：腰牌（赵衡，最终炸裂）。他身上的东西不用这些名字，换个叫法或者不写'])
  expect(check('character-design', design.replace('腰牌', '弟子木牌'), { others })).toEqual([])
})

const timeline = (lines: { speaker: string; text: string; start: number; end: number }[], present = { characters: [] as string[], props: [] as string[] }, cuts?: { index: number; start: number; end: number; backs?: string[] }[]) => ({
  seconds: cuts ? cuts.at(-1)!.end : 4,
  cuts: (cuts ?? [{ index: 1, start: 0, end: 4 }]).map(c => ({ index: c.index, start: c.start, end: c.end, camera: '固定', shot: '中景', present: { ...present, backs: c.backs ?? [], view: '主视角' } })),
  timeline: Array.from({ length: cuts ? cuts.at(-1)!.end : 4 }, (_, second) => ({ second, text: '动作', changes: [] })),
  lines,
  ambience: '风声',
})

test('a timeline that changes a word of the dialogue is sent back', () => {
  const data = { seconds: 4, lines: [{ speaker: '沈照雪', text: '祖师在上。' }], characters: ['沈照雪'], props: [], locations: ['石殿'] }
  expect(check('timeline', timeline([{ speaker: '沈照雪', text: '祖师在上。', start: 1, end: 3 }]), data)).toEqual([])
  expect(check('timeline', timeline([{ speaker: '沈照雪', text: '祖师在上！', start: 1, end: 3 }]), data)).toHaveLength(2)
})

test('a timeline that annotates a name in present is sent back, since the keyframe looks the name up', () => {
  const data = { seconds: 4, lines: [], characters: ['谢无咎', '柳含烟'], props: ['婚书'], locations: ['封剑洞'] }
  expect(check('timeline', timeline([], { characters: ['谢无咎', '柳含烟'], props: ['婚书'] }), data)).toEqual([])
  const problems = check('timeline', timeline([], { characters: ['谢无咎（右侧前景肩部）', '柳含烟'], props: ['婚书（展开）'] }), data)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('谢无咎（右侧前景肩部）、婚书（展开）')
})

test('a plan that leaves a beat out is sent back', () => {
  const data = { beats: ['b1', 'b2'], voiced: {}, min: 96, max: 144, locations: ['石殿'] }
  const plan = (beats: string[]) => ({ segments: [{ id: 'g1', beats, seconds: 8, location: '石殿', continues: false, summary: '开场' }], overflow: [] })
  expect(check('segment-plan', plan(['b1', 'b2']), data)).toEqual([])
  expect(check('segment-plan', plan(['b1']), data)).toEqual(['这些拍没有落进任何一段：b2'])
})

test('a plan that names a location outside the roster is sent back', () => {
  const data = { beats: ['b1'], voiced: {}, min: 96, max: 144, locations: ['封剑洞外'] }
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

test('a shot shorter than four seconds is sent back, and a back view must name someone in the shot', () => {
  const data = { seconds: 9, lines: [], characters: ['谢无咎', '柳含烟'], props: [], locations: ['封剑洞'] }
  const present = { characters: ['谢无咎', '柳含烟'], props: [] }
  expect(check('timeline', timeline([], present, [{ index: 1, start: 0, end: 4 }, { index: 2, start: 4, end: 9, backs: ['谢无咎'] }]), data)).toEqual([])
  const short = check('timeline', timeline([], present, [{ index: 1, start: 0, end: 3 }, { index: 2, start: 3, end: 9 }]), data)
  expect(short).toHaveLength(1)
  expect(short[0]).toContain('第 1 个镜头 0–3 秒')
  expect(check('timeline', timeline([], { characters: ['柳含烟'], props: [] }, [{ index: 1, start: 0, end: 9, backs: ['谢无咎'] }]), data)).toEqual(['backs 里的人也要写在同一个镜头的 characters 里：第 1 个镜头的 谢无咎'])
})

test('a segment that crosses locations must say where each shot is, and only among its own locations', () => {
  const data = { seconds: 9, lines: [], characters: ['谢无咎'], props: [], locations: ['封剑洞', '封剑洞外'] }
  const present = { characters: ['谢无咎'], props: [] }
  const at = (a?: string, b?: string) => { const t = timeline([], present, [{ index: 1, start: 0, end: 4 }, { index: 2, start: 4, end: 9 }]); return { ...t, cuts: t.cuts.map((c, i) => ({ ...c, location: i === 0 ? a : b })) } }
  expect(check('timeline', at('封剑洞', '封剑洞外'), data)).toEqual([])
  expect(check('timeline', at('封剑洞', undefined), data)).toEqual(['这一段经过 封剑洞、封剑洞外，每个镜头的 location 要照抄其中一个：第 2 个镜头没写'])
  expect(check('timeline', at('封剑洞', '山门'), data)[0]).toContain('第 2 个镜头写了「山门」')
  expect(check('timeline', at(), { ...data, locations: ['封剑洞'] })).toEqual([])
  const parsed = CARDS.timeline!.schema!.parse({ ...at(), cuts: at().cuts.map(c => ({ ...c, location: '' })), fight: false }) as { cuts: { location?: string }[] }
  expect(parsed.cuts[0]!.location).toBeUndefined()
})
