/**
 * The story half for a new sample (★2 directions, ★3 script), in the order and with the inputs the
 * script experiments ran with (src/m0/chain.ts steps 1–2, runs/ab-story, ab-script, ab-script4),
 * at the sample's length. Each story lives in its own folder; the command line and the page share it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModels } from '../llm.js'
import { loadPlugins } from '../plugins.js'
import { runTask, type Section } from '../runner.js'
import { Store } from '../store/store.js'
import { CARDS, screenplay, Script, scriptProblems, setupSection, type ScriptT } from '../tasks.js'
import { SAMPLE } from './spec.js'

export type Direction = { title: string; logline: string; situation: string; opposition: string; episode: string; cliffhanger: string; promise: string }
/** How each field of a direction is named to the writers and on the page; the last three are from stories written before 2026-10-28, when an episode was a whole story. */
export const DIRECTION_FIELDS = [
  ['logline', '梗概'], ['situation', '主角处境'], ['opposition', '对抗'], ['episode', '第 1 集'], ['cliffhanger', '卡点'], ['promise', '全剧看点'],
  ['strategy', '主角的策略'], ['cost', '代价'], ['payoff', '本集兑现'],
] as const
export type Story = {
  id: string
  idea: string
  directions?: Direction[]
  chosen?: number
  setup?: string
  draft?: string
  review?: string
  text?: string
  script?: ScriptT
  /** The creator's notes on the script, applied in order. */
  notes?: string[]
  project?: string
  /** What is being written now, or why the last step failed. */
  step?: string
  error?: string
  /** While a step writes: what it has written so far and for how many seconds (not saved). */
  live?: { text: string; seconds: number }
}

const length = `${SAMPLE.min}–${SAMPLE.max} 秒`
export const fmtDirection = (d: Direction) => {
  const fields = d as unknown as Record<string, string | undefined>
  return [`标题：${d.title}`, ...DIRECTION_FIELDS.filter(([key]) => fields[key]).map(([key, label]) => `${label}：${fields[key]}`)].join('\n')
}

/** One model call of the story half; tests pass a fake. */
export type Writer = (task: string, tag: string, sections: Section[], data: unknown, logDir: string, onText: (text: string) => void) => Promise<unknown>

/** Rewrites asked for when the extracted beats run outside the sample's length; a guess. */
const FIT_ROUNDS = 2

export class Stories {
  private readonly busy = new Set<string>()
  private readonly live = new Map<string, { text: string; since: number }>()
  private readonly pair
  private readonly models

  constructor(readonly root: string, readonly dir: string, private readonly writer?: Writer) {
    mkdirSync(dir, { recursive: true })
    const { plugins, errors } = loadPlugins(join(root, 'config/plugins'))
    if (errors.length) throw new Error(`插件加载失败：\n${errors.join('\n')}`)
    this.pair = { style: plugins.get('style:3d-guoman')!, genre: plugins.get('genre:xianxia')! }
    this.models = loadModels(join(root, 'config/models.json'))
  }

  list(): Story[] {
    return readdirSync(this.dir).filter(id => existsSync(join(this.dir, id, 'story.json'))).sort().reverse().map(id => ({ ...this.get(id), live: undefined }))
  }

  /**
   * Stories whose last step was cut off (the process stopped while it was writing) carry on from
   * where they stopped: a written screenplay is extracted, a chosen direction is written again from
   * its setup, an idea gets its directions. Called once at start-up; returns the ids picked up.
   */
  resumeInterrupted(): string[] {
    const resumed: string[] = []
    for (const id of readdirSync(this.dir).filter(x => existsSync(join(this.dir, x, 'story.json')))) {
      const story = JSON.parse(readFileSync(join(this.dir, id, 'story.json'), 'utf8')) as Story
      if (!story.step || story.project || this.busy.has(id)) continue
      // A screenplay rewritten for the creator's note is extracted as it is, for the creator to review.
      if (story.text && !story.script) this.run(story, s => this.extract(s, !s.notes?.length))
      else if (story.chosen !== undefined && !story.script) this.choose(id, story.chosen)
      else if (!story.directions) this.run(story, async s => {
        s.directions = (await this.call<{ directions: Direction[] }>(s, 'story-directions', 'directions', [{ title: '一句话想法', body: s.idea }, { title: '单集时长', body: length }])).directions
      })
      else {
        story.step = undefined
        this.save(story)
        continue
      }
      resumed.push(id)
    }
    return resumed
  }

  get(id: string): Story {
    const live = this.live.get(id)
    return {
      ...(JSON.parse(readFileSync(join(this.dir, id, 'story.json'), 'utf8')) as Story),
      ...(this.busy.has(id) ? {} : { step: undefined }),
      live: live && { text: live.text, seconds: Math.round((Date.now() - live.since) / 1000) },
    }
  }

  isBusy(id: string) {
    return this.busy.has(id)
  }

  private save(story: Story) {
    writeFileSync(join(this.dir, story.id, 'story.json'), JSON.stringify(story, null, 2))
  }

  private async call<T>(story: Story, task: string, tag: string, sections: Section[], data?: unknown): Promise<T> {
    story.step = tag
    this.save(story)
    const logDir = join(this.dir, story.id, 'logs')
    // Every call keeps its own log: a later rewrite must not overwrite the version the creator asked for.
    const logTag = existsSync(join(logDir, `${tag}.json`)) ? `${tag}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}` : tag
    const live = { text: '', since: Date.now() }
    this.live.set(story.id, live)
    const onText = (text: string) => (live.text = text)
    try {
      if (this.writer) return (await this.writer(task, logTag, sections, data, logDir, onText)) as T
      return (await runTask<T>({ root: this.root, card: CARDS[task]!, sections, data, plugins: this.pair, models: this.models, logDir, tag: logTag, onText })).output
    } finally {
      this.live.delete(story.id)
    }
  }

  /** Runs one step in the background; the page polls the story. A story runs one step at a time. */
  private run(story: Story, work: (s: Story) => Promise<void>): Story {
    if (this.busy.has(story.id)) throw new Error('这个故事正在写，等它写完')
    this.busy.add(story.id)
    story.error = undefined
    this.save(story)
    void work(story)
      .catch(error => { story.error = error instanceof Error ? error.message : String(error) })
      .finally(() => {
        this.busy.delete(story.id)
        story.step = undefined
        this.save(story)
      })
    return story
  }

  /** ★2: three directions from one line. */
  start(idea: string): Story {
    if (!idea.trim()) throw new Error('先写一句想法')
    const id = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
    mkdirSync(join(this.dir, id), { recursive: true })
    const story: Story = { id, idea: idea.trim() }
    return this.run(story, async s => {
      s.directions = (await this.call<{ directions: Direction[] }>(s, 'story-directions', 'directions', [{ title: '一句话想法', body: s.idea }, { title: '单集时长', body: length }])).directions
    })
  }

  /** ★2 again: three new directions for the same idea. */
  redirect(id: string, note = ''): Story {
    const story = this.get(id)
    if (story.project) throw new Error('这个故事已经建成项目了')
    return this.run(story, async s => {
      // With a note, the previous three and what the creator said about them go along, the way a revise does elsewhere.
      const before = note.trim() && s.directions ? [{ title: '上一批方向', body: s.directions.map((d, i) => `方向 ${i + 1}\n${fmtDirection(d)}`).join('\n\n') }, { title: '创作者的意见', body: note.trim() }] : []
      Object.assign(s, { chosen: undefined, setup: undefined, draft: undefined, review: undefined, text: undefined, script: undefined, notes: undefined })
      s.directions = (await this.call<{ directions: Direction[] }>(s, 'story-directions', 'directions', [{ title: '一句话想法', body: s.idea }, { title: '单集时长', body: length }, ...before])).directions
    })
  }

  /** The chosen direction becomes the setup, the screenplay (reviewed and rewritten once) and its beats. */
  /** `carry`: writing the same direction again, the creator's notes on the earlier version go to the new draft. */
  choose(id: string, index: number, carry = false): Story {
    const story = this.get(id)
    const chosen = story.directions?.[index]
    if (!chosen) throw new Error(`没有第 ${index + 1} 个方向`)
    if (story.project) throw new Error('这个故事已经建成项目了')
    const carried = carry && story.chosen === index ? story.notes ?? [] : []
    return this.run(story, async s => {
      Object.assign(s, { chosen: index, setup: undefined, draft: undefined, review: undefined, text: undefined, script: undefined, notes: carried })
      s.setup = await this.call<string>(s, 'story-setup', 'setup', [{ title: '选定的方向', body: fmtDirection(chosen) }, { title: '单集时长', body: length }])
      s.draft = await this.call<string>(s, 'script', 'script', [...this.scriptSections(s), ...(carried.length ? [{ title: '创作者看过上一版后的意见', body: carried.join('\n\n') }] : [])])
      s.review = await this.call<string>(s, 'script-review', 'script-review', [{ title: '本集设定', body: s.setup }, { title: '剧本正文', body: s.draft }])
      s.text = s.review.trim() === '无' ? s.draft : await this.rewrite(s, s.draft, s.review)
      await this.extract(s, true)
    })
  }

  /** ★3: the creator's note on the screenplay, applied the way the reviewer's notes are. */
  revise(id: string, note: string): Story {
    const story = this.get(id)
    if (!story.text) throw new Error('剧本还没写出来')
    if (story.project) throw new Error('这个故事已经建成项目了，改剧本要另起一个故事')
    if (!note.trim()) throw new Error('写一下哪里要改')
    return this.run(story, async s => {
      s.text = await this.rewrite(s, s.text!, `创作者的意见：${note.trim()}`)
      s.notes = [...(s.notes ?? []), note.trim()]
      this.save(s)
      await this.extract(s, false)
    })
  }

  private scriptSections(s: Story): Section[] {
    return [{ title: '选定的方向', body: fmtDirection(s.directions![s.chosen!]!) }, { title: '本集设定', body: s.setup! }, { title: '单集时长', body: length }]
  }

  private rewrite(s: Story, previous: string, notes: string) {
    return this.call<string>(s, 'script', 'script-revised', [
      ...this.scriptSections(s),
      { title: '上一版', body: previous },
      { title: '审读意见', body: `${notes}\n\n照这些意见改上一版：被指出的地方按改法改，其余保留。` },
    ])
  }

  /**
   * Beats and roster from the screenplay. The extraction estimates the length honestly and cannot
   * shorten the story, so before the creator has seen it (`fit`), a screenplay outside the sample's
   * length is rewritten to the measured number of seconds and extracted again. After the creator's
   * note it is extracted once and shown as it is (creator, 2026-10-28: revise by my note, then let me
   * review); the page marks the length and the project cannot be created until it fits.
   */
  private async extract(s: Story, fit: boolean) {
    for (let round = 0; ; round++) {
      await this.extractOnce(s)
      const total = s.script!.scenes.flatMap(x => x.beats).reduce((sum, b) => sum + b.seconds, 0)
      if (!fit || (total >= SAMPLE.min && total <= SAMPLE.max)) return
      s.script = undefined
      if (round >= FIT_ROUNDS) throw new Error(`剧本拆出来约 ${total} 秒，自动删改 ${FIT_ROUNDS} 次还不在 ${length}；在下面写意见让它改`)
      const target = Math.round((SAMPLE.min + SAMPLE.max) / 2)
      const how = total > SAMPLE.max
        ? '删掉或合并不推动局面的动作、台词和停顿，保住处境的交代、那件事的来由和结尾的卡点'
        : '补上该有的反应、停顿和过程，不加新的情节和人物'
      s.text = await this.rewrite(s, s.text!, `按拆拍估算，这一版约 ${total} 秒，要落在 ${length}：${how}，改到 ${target} 秒左右。`)
      this.save(s)
    }
  }

  private async extractOnce(s: Story) {
    const written = screenplay(s.text!)
    const script = await this.call<ScriptT>(s, 'script-extract', 'script-extract', [
      { title: '剧本正文', body: s.text! },
      { title: '本集设定里的人物', body: setupSection(s.setup!, '人物') },
      { title: '单集时长', body: length },
    ], { ...SAMPLE, lines: written.scenes.flatMap(x => x.lines), locations: written.scenes.map(x => x.location) })
    // The extraction keeps the scenes in order (its check), so each screenplay setting goes back by position.
    script.scenes.forEach((scene, i) => (scene.setting = written.scenes[i]!.setting))
    s.script = script
  }

  /** ★3 approved: a new project from this script and its setup, everything locked as the creator's. */
  createProject(id: string, projects: string): string {
    const story = this.get(id)
    if (!story.script || !story.setup) throw new Error('剧本还没写完')
    if (story.project) return story.project
    const title = story.directions![story.chosen!]!.title.replace(/[\\/:*?"<>|\s]/g, '')
    const dir = join(projects, `${title}-${story.id.slice(4, 12)}`)
    createProject(dir, story.script, story.setup)
    story.project = dir
    this.save(story)
    return dir
  }
}

export function createProject(dir: string, scriptData: unknown, setup?: string) {
  if (existsSync(join(dir, 'project.db'))) throw new Error(`${dir} 里已经有项目了`)
  const parsed = Script.safeParse(scriptData)
  if (!parsed.success) throw new Error(`剧本格式不对：${parsed.error.message}`)
  const problems = scriptProblems(parsed.data, SAMPLE)
  if (problems.length) throw new Error(`剧本没通过检查：${problems.join('；')}`)
  const store = new Store(dir)
  try {
    store.tx(() => {
      store.createProject({ name: dir.split('/').pop()!, entry: 'script', style: '3d-guoman', genre: 'xianxia', seconds_min: SAMPLE.min, seconds_max: SAMPLE.max, delivery: '1080p' })
      store.addArtifact({ kind: 'style_ref', scope: 'p', payload: { plugin: '3d-guoman', file: 'style-ref.png' }, status: 'locked', created_by: 'program' })
      const s = setup ? store.addArtifact({ kind: 'setup', scope: 'e1', payload: { text: setup }, status: 'locked', created_by: 'user' }) : undefined
      const script = store.addArtifact({ kind: 'script', scope: 'e1', payload: { scenes: parsed.data.scenes }, inputs: s ? [s.id] : [], status: 'locked', created_by: 'user' })
      store.addArtifact({ kind: 'roster', scope: 'e1', payload: parsed.data.roster, inputs: [script.id], status: 'locked', created_by: 'user' })
    })
  } finally {
    store.close()
  }
}
