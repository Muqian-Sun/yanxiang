/**
 * M0: run the text half of the pipeline once from a one-line idea, then repeat a
 * sample of the calls twice on identical inputs, and write a review document.
 * No images, no video. Usage: bun src/m0/chain.ts "<一句话>" [runs/<dir>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadModels } from '../llm.js'
import { fmtDirection, type Direction } from '../m1/storyflow.js'
import { loadPlugins } from '../plugins.js'
import { runTask, TaskFailed, type RunResult, type Section } from '../runner.js'
import { CARDS, costumeChanges, momentsOf, screenplay, setupSection, voicedPerBeat, type CharacterData, type PlanData, type PlanT, type ScriptT, type TimelineT } from '../tasks.js'

const ROOT = resolve(import.meta.dir, '../..')
const idea = process.argv[2]
if (!idea) throw new Error('用法：bun src/m0/chain.ts "<一句话>"')
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
const OUT = resolve(process.argv[3] ?? join(ROOT, 'runs', `m0-${stamp}`))
mkdirSync(OUT, { recursive: true })

const { plugins, errors } = loadPlugins(join(ROOT, 'config/plugins'))
if (errors.length) throw new Error(`插件加载失败：\n${errors.join('\n')}`)
const pair = { style: plugins.get('style:3d-guoman')!, genre: plugins.get('genre:xianxia')! }
const models = loadModels(join(ROOT, 'config/models.json'))
const MIN = 96
const MAX = 144

type Call = { task: string; tag: string; sections: Section[]; data?: unknown; result?: RunResult; error?: string }
const calls: Call[] = []

async function call<T>(task: string, tag: string, sections: Section[], data?: unknown): Promise<T | null> {
  const entry: Call = { task, tag, sections, data }
  calls.push(entry)
  try {
    entry.result = await runTask({ root: ROOT, card: CARDS[task]!, sections, data, plugins: pair, models, logDir: join(OUT, 'logs'), tag, onEvent: console.log })
    console.log(`✓ ${tag}（${entry.result.attempts.length} 次，${entry.result.attempts.reduce((s, a) => s + a.ms, 0)} ms）`)
    return entry.result.output as T
  } catch (error) {
    entry.error = error instanceof TaskFailed || error instanceof Error ? error.message : String(error)
    console.log(`✗ ${tag}：${entry.error}`)
    return null
  }
}

async function pool<T>(limit: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++
      results[index] = await jobs[index]!()
    }
  }))
  return results
}

const lines = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean)
const pick = (text: string, key: string) => lines(text).filter(l => l.startsWith(`${key}：`)).join('\n')

// 1. 故事方向；REUSE_DIRECTIONS=<上一轮的 logs/directions.json> 时沿用上一轮的方向，便于对比同一个故事
const reuse = process.env.REUSE_DIRECTIONS
const directions = reuse
  ? (JSON.parse(readFileSync(reuse, 'utf8')).output as { directions: Direction[] })
  : await call<{ directions: Direction[] }>('story-directions', 'directions', [
      { title: '一句话想法', body: idea },
      { title: '单集时长', body: `约 2 分钟（${MIN}–${MAX} 秒）` },
    ])
if (!directions) process.exit(1)
const chosen = directions.directions[0]!

// 2. 本集设定 → 剧本正文 → 拆成拍和出场清单；正文里每场的环境段由程序挂回拆出来的场上
const setup = await call<string>('story-setup', 'setup', [
  { title: '选定的方向', body: fmtDirection(chosen) },
  { title: '单集时长', body: `${MIN}–${MAX} 秒` },
])
if (!setup) process.exit(1)
const scriptSections = [
  { title: '选定的方向', body: fmtDirection(chosen) },
  { title: '本集设定', body: setup },
  { title: '单集时长', body: `${MIN}–${MAX} 秒` },
]
const draft = await call<string>('script', 'script', scriptSections)
if (!draft) process.exit(1)
const review = await call<string>('script-review', 'script-review', [{ title: '本集设定', body: setup }, { title: '剧本正文', body: draft }])
if (review === null) process.exit(1)
const screenplayText = review.trim() === '无' ? draft : await call<string>('script', 'script-revised', [
  ...scriptSections,
  { title: '上一版', body: draft },
  { title: '审读意见', body: `${review}\n\n照这些意见改上一版：被指出的地方按改法改，其余保留。` },
])
if (!screenplayText) process.exit(1)
const written = screenplay(screenplayText)
const script = await call<ScriptT>('script-extract', 'script-extract', [
  { title: '剧本正文', body: screenplayText },
  { title: '本集设定里的人物', body: setupSection(setup, '人物') },
  { title: '单集时长', body: `${MIN}–${MAX} 秒` },
], { min: MIN, max: MAX, lines: written.scenes.flatMap(s => s.lines), locations: written.scenes.map(s => s.location) })
if (!script) process.exit(1)
script.scenes.forEach((scene, i) => (scene.setting = written.scenes[i]!.setting))
const beats = script.scenes.flatMap(scene => scene.beats.map(beat => ({ ...beat, location: scene.location })))
const beatById = new Map(beats.map(beat => [beat.id, beat]))
const fmtBeat = (beat: (typeof beats)[number]) =>
  [`${beat.id}（${beat.location}，约 ${beat.seconds} 秒）${beat.action}`, ...beat.lines.map(l => `  ${l.speaker}${l.vo ? '（画外音）' : ''}：${l.text}`), ...(beat.changes.length ? [`  状态变化：${beat.changes.join('；')}`] : [])].join('\n')
const stateBefore = (id: string) => {
  const index = beats.findIndex(beat => beat.id === id)
  return beats.slice(0, Math.max(index, 0)).flatMap(beat => beat.changes)
}

// 3. 外观设计：人物按顺序（后面的人要和前面的人区分开），地点按顺序（相连的地点照前面的写），道具并行
const designs = new Map<string, string>()
for (const [i, person] of script.roster.characters.entries()) {
  const others = [...designs.entries()].filter(([key]) => key.startsWith('char:')).map(([key, text]) => `${key.slice(5)}：${[pick(text, '主色').replace('主色：', '主色 '), pick(text, '区分').replace('区分：', ''), pick(text, '身高').replace('身高：', '身高 ')].filter(Boolean).join('；')}`)
  const theirs = script.roster.props.filter(prop => !prop.holder.includes(person.name))
  const text = await call<string>('character-design', `character-design-${i + 1}`, [
    { title: '人物卡', body: `${person.name}：${person.gender}，看起来${person.age_look.replace(/^看起来/, '')}，${person.rank}，${person.tier}；本集要${person.needs.replace(/^本集要/, '')}；${person.temperament}` },
    { title: '剧本里写到他外貌的原句', body: person.appearance_lines.join('\n') },
    { title: '和他有关的道具', body: script.roster.props.filter(prop => prop.holder.includes(person.name)).map(prop => prop.name).join('、') },
    { title: '本集其他人的道具', body: theirs.map(prop => prop.name).join('、') },
    { title: '同集其他人物', body: others.join('\n') },
  ], { others: theirs.map(prop => ({ name: prop.name, holder: prop.holder })) } satisfies CharacterData)
  if (text) designs.set(`char:${person.name}`, text)
}
const propsAt = (location: string) => script.roster.props.filter(prop => prop.beats.some(id => beatById.get(id)?.location === location))
const designLocations = async () => {
  for (const [i, place] of script.roster.locations.entries()) {
    const earlier = [...designs.entries()].filter(([key]) => key.startsWith('loc:')).map(([key, text]) => `${key.slice(4)}\n${text}`)
    const text = await call<string>('location-design', `location-design-${i + 1}`, [
      { title: '地点', body: place.name },
      { title: '本集设定里的世界和地点', body: [setupSection(setup, '世界一角'), setupSection(setup, '地点')].join('\n\n') },
      { title: '剧本里这个地点的环境', body: script.scenes.filter(scene => scene.location === place.name).map(scene => scene.setting ?? '').join('\n') },
      { title: '在这里发生的剧情', body: place.beats.map(id => beatById.get(id)).filter(Boolean).map(b => fmtBeat(b!)).join('\n') },
      { title: '场内的关键道具', body: propsAt(place.name).map(prop => `${prop.name}：${prop.holder}`).join('\n') },
      { title: '已设计的地点', body: earlier.join('\n\n') },
    ])
    if (text) designs.set(`loc:${place.name}`, text)
  }
}
await Promise.all([designLocations(), pool(4, [
  ...script.roster.props.map((prop, i) => async () => {
    const text = await call<string>('prop-design', `prop-design-${i + 1}`, [
      { title: '道具', body: prop.name },
      { title: '持有人', body: prop.holder },
      { title: '用到它的剧情', body: prop.beats.map(id => beatById.get(id)).filter(Boolean).map(b => fmtBeat(b!)).join('\n') },
    ])
    if (text) designs.set(`prop:${prop.name}`, text)
  }),
])])

// 4. 描述：定妆、场景主图、道具设定图
await pool(4, [...designs.entries()].map(([key, text]) => async () => {
  const [kind, name] = [key.split(':')[0]!, key.slice(key.indexOf(':') + 1)]
  const brief = lines(text).filter(l => !l.startsWith('区分：')).join('\n')
  if (kind === 'char') return void (await call<string>('portrait-desc', `portrait-desc-${name}`, [{ title: '外观要点', body: brief }]))
  if (kind === 'loc') return void (await call<string>('location-desc', `location-desc-${name}`, [{ title: '外观要点', body: brief }, { title: '场内的关键道具（照参考图画）', body: propsAt(name).map(prop => prop.name).join('、') }]))
  return void (await call<string>('prop-desc', `prop-desc-${name}`, [{ title: '外观要点', body: brief }]))
}))

// 5. 分段
const names = [...script.roster.characters.map(c => c.name), ...script.roster.locations.map(l => l.name), ...script.roster.props.map(p => p.name)]
const changes = costumeChanges(script.roster)
const plan = await call<PlanT>('segment-plan', 'segment-plan', [
  { title: '剧本', body: beats.map(fmtBeat).join('\n') },
  { title: '已定的人物、地点、道具', body: names.join('、') },
  { title: '换装', body: changes.map(c => `${c.name}从 ${c.from} 起换上${c.costume}`).join('\n') },
  { title: '单集时长', body: `${MIN}–${MAX} 秒` },
], { beats: beats.map(b => b.id), voiced: voicedPerBeat(beats), min: MIN, max: MAX, locations: script.roster.locations.map(l => l.name), changes } satisfies PlanData)
if (!plan) process.exit(1)

// 6. 段时间轴：承接段要看上一段的最后一个镜头，所以一串承接段按顺序写，不同串之间并行
const timelines = new Map<string, TimelineT>()
const lastCut = (tl: TimelineT) => {
  const cut = tl.cuts.at(-1)!
  return `运镜：${cut.camera}\n镜头：${cut.shot}\n最后几秒：${momentsOf(tl).at(-1)?.text ?? ''}`
}
const runs: number[][] = []
plan.segments.forEach((segment, i) => (segment.continues && runs.length ? runs.at(-1)!.push(i) : runs.push([i])))
await pool(4, runs.map(run => async () => {
  for (const i of run) {
    const segment = plan.segments[i]!
    const segBeats = segment.beats.map(id => beatById.get(id)).filter(Boolean) as typeof beats
    const present = names.filter(name => segBeats.some(b => b.action.includes(name) || b.lines.some(l => l.speaker === name || l.text.includes(name))) || name === segment.location)
    const previous = segment.continues ? timelines.get(plan.segments[i - 1]?.id ?? '') : undefined
    if (segment.continues && !previous) {
      console.log(`✗ timeline-${segment.id}：上一段时间轴没有生成，承接段跳过`)
      return
    }
    const result = await call<TimelineT>('timeline', `timeline-${segment.id}`, [
      { title: '这一段', body: `${segment.id}，${segment.seconds} 秒，地点：${segment.location}${segment.continues ? '，承接上一段' : ''}\n概要：${segment.summary}` },
      { title: '这一段的剧本', body: segBeats.map(fmtBeat).join('\n') },
      { title: '前一段', body: plan.segments[i - 1]?.summary ?? '' },
      { title: '上一段最后一个镜头', body: previous ? lastCut(previous) : '' },
      { title: '后一段', body: plan.segments[i + 1]?.summary ?? '' },
      { title: '出场的人物、地点、道具', body: present.join('、') },
      { title: '这一段开始时的状态', body: stateBefore(segment.beats[0]!).join('\n') },
    ], { seconds: segment.seconds, lines: segBeats.flatMap(b => b.lines) })
    if (result) timelines.set(segment.id, result)
  }
}))

// 7. 前三段的关键帧描述和换机位描述；承接段的第一个镜头由上一段重放的尾巴接上，不出关键帧
const views = new Map<string, { location: string; view: string }>()
const keyframeJobs: (() => Promise<unknown>)[] = []
for (const segment of plan.segments.slice(0, 3)) {
  const tl = timelines.get(segment.id)
  if (!tl) continue
  const startState = stateBefore(segment.beats[0]!)
  for (const cut of tl.cuts) {
    if (cut.present.view !== '主视角') views.set(`${segment.location}｜${cut.present.view}`, { location: segment.location, view: cut.present.view })
    if (segment.continues && cut.index === 1) continue
    const refs = [
      ...cut.present.characters.map(name => `${name}的定妆照`),
      `${segment.location}的${cut.present.view}`,
      ...cut.present.props.map(name => `${name}的设定图`),
      '风格参考图',
    ].map((label, k) => `图 ${k + 1}：${label}`)
    const colors = cut.present.characters.map(name => `${name}：${pick(designs.get(`char:${name}`) ?? '', '主色').replace('主色：', '')}`)
    const furnishing = pick(designs.get(`loc:${segment.location}`) ?? '', '陈设')
    const second = momentsOf(tl).find(m => m.from <= cut.start && cut.start < m.to)
    keyframeJobs.push(() => call<string>('keyframe-desc', `keyframe-${segment.id}-c${cut.index}`, [
      { title: '这一秒', body: `第 ${cut.start} 秒，第 ${cut.index} 个镜头的开头。\n画面：${second && second.to - second.from > 1 ? `（这个镜头第 ${second.from}–${second.to} 秒的全部内容，关键帧只取开头这一刻）` : ''}${second?.text ?? ''}\n镜头：${cut.shot}\n运镜：${cut.camera}` },
      { title: '参考图', body: refs.join('\n') },
      { title: '人物主色', body: colors.join('\n') },
      { title: '场内陈设', body: furnishing },
      { title: '此刻的状态', body: [...startState, ...momentsOf(tl).filter(m => m.to <= cut.start).flatMap(m => m.changes)].join('\n') },
    ]))
  }
}
for (const [i, { location, view }] of [...views.values()].entries()) {
  keyframeJobs.push(() => call<string>('location-view-desc', `location-view-${i + 1}`, [
    { title: '地点的外观要点', body: designs.get(`loc:${location}`) ?? '' },
    { title: '需要的视角', body: view },
  ]))
}
await pool(4, keyframeJobs)

// 8. 同一输入再跑两次：每类任务取几个样本
const sample = (task: string, n: number) => calls.filter(c => c.task === task && c.result).slice(0, n)
const repeatSet = [
  ...sample('story-directions', 1), ...sample('story-setup', 1), ...sample('script', 1), ...sample('script-review', 1), ...sample('script-extract', 1), ...sample('character-design', 2), ...sample('location-design', 1), ...sample('prop-design', 1),
  ...sample('portrait-desc', 2), ...sample('location-desc', 1), ...sample('prop-desc', 1), ...sample('segment-plan', 1), ...sample('timeline', 2),
  ...sample('keyframe-desc', 3), ...sample('location-view-desc', 1),
]
const repeats = new Map<string, (RunResult | string)[]>()
await pool(4, repeatSet.flatMap(base => [2, 3].map(n => async () => {
  try {
    const result = await runTask({ root: ROOT, card: CARDS[base.task]!, sections: base.sections, data: base.data, plugins: pair, models, logDir: join(OUT, 'logs'), tag: `${base.tag}-r${n}`, onEvent: console.log })
    repeats.set(base.tag, [...(repeats.get(base.tag) ?? []), result])
    console.log(`✓ ${base.tag}-r${n}`)
  } catch (error) {
    repeats.set(base.tag, [...(repeats.get(base.tag) ?? []), error instanceof Error ? error.message : String(error)])
    console.log(`✗ ${base.tag}-r${n}`)
  }
})))

// 9. 审阅稿
const show = (result: RunResult) => (typeof result.output === 'string' ? result.output : '```json\n' + JSON.stringify(result.output, null, 2) + '\n```')
const doc: string[] = [`# M0 审阅稿`, '', `一句话：${idea}`, '', `模型：${models.text?.model}；每次调用的完整输入输出在 \`logs/\`。`, '']
const failed = calls.filter(c => c.error)
doc.push('## 失败的调用', '', failed.length ? failed.map(c => `- ${c.tag}：${c.error}`).join('\n') : '无', '')
const rewrites = calls.filter(c => (c.result?.attempts.length ?? 0) > 1)
doc.push('## 被检查打回重写过的调用', '', rewrites.length ? rewrites.map(c => `- ${c.tag}：${c.result!.attempts.slice(0, -1).map(a => a.problems.join('；')).join(' → ')}`).join('\n') : '无', '')
doc.push('## 一、同一输入跑三次', '', '每组先列这次调用的输入（用户消息），再列三次输出。看两件事：写得够不够详细；没给定的地方三次之间差别大不大。', '')
for (const base of repeatSet) {
  doc.push(`### ${base.tag}`, '', '<details><summary>输入</summary>', '', '```text', base.result!.user, '```', '', '</details>', '')
  const all = [base.result!, ...(repeats.get(base.tag) ?? [])]
  all.forEach((r, k) => doc.push(`**第 ${k + 1} 次**`, '', typeof r === 'string' ? `失败：${r}` : show(r), ''))
}
doc.push('## 二、整条链路的产出（第一次）', '')
for (const c of calls.filter(c => c.result)) doc.push(`### ${c.tag}`, '', show(c.result!), '')
writeFileSync(join(OUT, '审阅.md'), doc.join('\n'))
const tokens = calls.reduce((s, c) => s + (c.result?.attempts.reduce((t, a) => t + a.tokensIn + a.tokensOut, 0) ?? 0), 0)
console.log(`\n完成：${calls.length} 次链路调用、${[...repeats.values()].flat().length} 次重复，约 ${tokens} token（不含重复）。审阅稿：${join(OUT, '审阅.md')}`)
