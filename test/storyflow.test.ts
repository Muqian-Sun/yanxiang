import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fmtDirection, Stories, type Direction, type Writer } from '../src/m1/storyflow.js'
import type { Section } from '../src/runner.js'

const ROOT = join(import.meta.dir, '..')
const SCREENPLAY = '场1 内 · 锁魂洞 · 子夜\n洞里四根锁链垂到石台。\n△ 林砚睁眼。\n林砚：我还活着。'
const SETUP = '世界一角：青冥宗\n规则：同心印\n人物：\n林砚：外门杂役\n真相：五百年前\n地点：\n锁魂洞：禁地\n独有时刻：膝印'
const DIRECTION = { title: '废柴觉醒', logline: '', situation: '', opposition: '', episode: '', cliffhanger: '', promise: '' }

test('a direction is written out with the fields it has, an episode-one one and one stored before 2026-10-28 alike', () => {
  expect(fmtDirection({ title: '甲', logline: '梗', situation: '处', opposition: '对', episode: '集', cliffhanger: '卡', promise: '看' })).toBe('标题：甲\n梗概：梗\n主角处境：处\n对抗：对\n第 1 集：集\n卡点：卡\n全剧看点：看')
  const old = { title: '乙', logline: '梗', strategy: '策', opposition: '对', cost: '代', payoff: '兑' } as unknown as Direction
  expect(fmtDirection(old)).toBe('标题：乙\n梗概：梗\n对抗：对\n主角的策略：策\n代价：代\n本集兑现：兑')
})

/** A writer whose extraction gives the screenplay `lengths[n]` seconds on its n-th call; it records every rewrite note, and cuts after the first line it may. */
function writer(lengths: number[], notes: string[], cuts: { sections: Section[]; allowed: number[] }[] = []): Writer {
  let extractions = 0
  return async (task, _tag, sections: Section[], data) => {
    if (task === 'story-directions') return { directions: [DIRECTION, DIRECTION, DIRECTION] }
    if (task === 'story-setup') return SETUP
    if (task === 'script-review') return '无'
    if (task === 'episode-cut') {
      const { allowed } = data as { allowed: number[] }
      cuts.push({ sections, allowed })
      return { after: allowed[0], reason: '话刚出口' }
    }
    if (task === 'script') {
      const note = sections.find(s => s.title === '审读意见')
      if (note) notes.push(note.body)
      return SCREENPLAY
    }
    const seconds = lengths[Math.min(extractions++, lengths.length - 1)]!
    return {
      scenes: [{ id: 's1', location: '锁魂洞', beats: [{ id: 'b1', action: '林砚睁眼。', lines: [{ speaker: '林砚', text: '我还活着。' }], seconds, changes: [] }] }],
      roster: { characters: [{ name: '林砚', gender: '男', age_look: '看起来二十岁', rank: '杂役', tier: '男主', needs: '', temperament: '', appearance_lines: [] }], locations: [{ name: '锁魂洞', beats: ['b1'] }], props: [] },
    }
  }
}
const settle = async (st: Stories, id: string) => { while (st.isBusy(id)) await Bun.sleep(5) }

test('a screenplay that runs long is not shortened: it stops where it best can and the rest moves on to the next episode', async () => {
  const notes: string[] = []
  const cuts: { sections: Section[]; allowed: number[] }[] = []
  const st = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), writer([170, 120], notes, cuts))
  const { id } = st.start('废柴觉醒')
  await settle(st, id)
  st.choose(id, 0)
  await settle(st, id)
  const story = st.get(id)
  expect(story.error).toBeUndefined()
  expect(story.script!.scenes[0]!.beats[0]!.seconds).toBe(120)
  expect(notes).toEqual([])
  // The action (3 s of the 4 s estimated) scaled to 170 s is 128 s; the last line, at the full 170 s, is past the length.
  expect(cuts).toHaveLength(1)
  expect(cuts[0]!.allowed).toEqual([3])
  expect(cuts[0]!.sections[0]!.body.split('\n')[2]).toBe('3｜约 128 秒｜△ 林砚睁眼。')
  expect(story.text).toBe('场1 内 · 锁魂洞 · 子夜\n洞里四根锁链垂到石台。\n△ 林砚睁眼。')
  expect(story.next).toBe('场1 内 · 锁魂洞 · 子夜\n洞里四根锁链垂到石台。\n林砚：我还活着。')
})

test('a screenplay that runs short is rewritten longer before the creator sees it, and kept with the reason when it stays short', async () => {
  const notes: string[] = []
  const st = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), writer([80, 120], notes))
  const { id } = st.start('废柴觉醒')
  await settle(st, id)
  st.choose(id, 0)
  await settle(st, id)
  expect(st.get(id).script!.scenes[0]!.beats[0]!.seconds).toBe(120)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('这一版约 80 秒，要落在 96–144 秒：补上该有的反应')

  const short = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), writer([80], []))
  const again = short.start('废柴觉醒')
  await settle(short, again.id)
  short.choose(again.id, 0)
  await settle(short, again.id)
  expect(short.get(again.id).script).toBeUndefined()
  expect(short.get(again.id).error).toContain('约 80 秒，自动调整 2 次还不在 96–144 秒')
})

test('when no line keeps the episode within its length, the screenplay is kept for the creator with the reason', async () => {
  const st = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), writer([170], []))
  const { id } = st.start('废柴觉醒')
  await settle(st, id)
  st.choose(id, 0)
  await settle(st, id)
  const story = st.get(id)
  // The first cut leaves only the action, which the extraction still puts at 170 s.
  expect(story.script).toBeUndefined()
  expect(story.text).toBe('场1 内 · 锁魂洞 · 子夜\n洞里四根锁链垂到石台。\n△ 林砚睁眼。')
  expect(story.error).toContain('约 170 秒，找不到一行能让这一集落在 96–144 秒')
})

test('directions redone with a note carry the previous three and the note', async () => {
  const seen: Section[][] = []
  const base = writer([120], [])
  const st = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), async (task, tag, sections, data, dir, onText) => {
    if (task === 'story-directions') seen.push(sections)
    return base(task, tag, sections, data, dir, onText)
  })
  const { id } = st.start('废柴觉醒')
  await settle(st, id)
  st.redirect(id, '主角要更狠一点')
  await settle(st, id)
  expect(seen[0]!.map(s => s.title)).toEqual(['一句话想法', '单集时长'])
  expect(seen[1]!.map(s => s.title)).toEqual(['一句话想法', '单集时长', '上一批方向', '创作者的意见'])
  expect(seen[1]![2]!.body).toContain('方向 1\n标题：废柴觉醒')
  expect(seen[1]![3]!.body).toBe('主角要更狠一点')
})

test('a story cut off while it was being written carries on from where it stopped when the flow starts again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yx-story-'))
  const first = new Stories(ROOT, dir, writer([120], []))
  const { id } = first.start('废柴觉醒')
  await settle(first, id)
  first.choose(id, 0)
  await settle(first, id)
  // As the process leaves it when it dies after the rewrite: the screenplay written, no beats, the step still marked.
  const path = join(dir, id, 'story.json')
  const cut = { ...JSON.parse(readFileSync(path, 'utf8')), script: undefined, step: 'script-revised' }
  writeFileSync(path, JSON.stringify(cut))
  const calls: string[] = []
  const base = writer([120], [])
  const again = new Stories(ROOT, dir, async (task, tag, sections, data, logDir, onText) => { calls.push(task); return base(task, tag, sections, data, logDir, onText) })
  expect(again.resumeInterrupted()).toEqual([id])
  await settle(again, id)
  const story = again.get(id)
  expect(story.script!.scenes[0]!.beats[0]!.seconds).toBe(120)
  expect(calls).toEqual(['script-extract'])
  expect(again.resumeInterrupted()).toEqual([])
})

test('after the creator\'s note the screenplay is rewritten once by that note; run long, its overflow moves on, run short, it is shown as it is', async () => {
  const notes: string[] = []
  const st = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), writer([120, 170, 120], notes))
  const { id } = st.start('废柴觉醒')
  await settle(st, id)
  st.choose(id, 0)
  await settle(st, id)
  st.revise(id, '退婚之后别突然冒出个盒子')
  await settle(st, id)
  const story = st.get(id)
  expect(story.error).toBeUndefined()
  expect(story.script!.scenes[0]!.beats[0]!.seconds).toBe(120)
  expect(story.next).toBe('场1 内 · 锁魂洞 · 子夜\n洞里四根锁链垂到石台。\n林砚：我还活着。')
  expect(notes).toEqual(['创作者的意见：退婚之后别突然冒出个盒子\n\n照这些意见改上一版：被指出的地方按改法改，其余保留。'])

  // Moved on twice: the newer overflow goes before what was already waiting for the next episode.
  const base = writer([170, 120, 170, 120], [])
  const twice = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), async (task, tag, sections, data, dir, onText) =>
    task === 'script' && sections.some(s => s.body.startsWith('创作者的意见')) ? SCREENPLAY.replace('我还活着', '我回来了') : base(task, tag, sections, data, dir, onText))
  const both = twice.start('废柴觉醒')
  await settle(twice, both.id)
  twice.choose(both.id, 0)
  await settle(twice, both.id)
  twice.revise(both.id, '再紧一点')
  await settle(twice, both.id)
  const rest = (line: string) => `场1 内 · 锁魂洞 · 子夜\n洞里四根锁链垂到石台。\n林砚：${line}`
  expect(twice.get(both.id).next).toBe(`${rest('我回来了。')}\n\n${rest('我还活着。')}`)

  const shortNotes: string[] = []
  const short = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), writer([120, 80], shortNotes))
  const again = short.start('废柴觉醒')
  await settle(short, again.id)
  short.choose(again.id, 0)
  await settle(short, again.id)
  short.revise(again.id, '删掉第二场')
  await settle(short, again.id)
  expect(short.get(again.id).script!.scenes[0]!.beats[0]!.seconds).toBe(80)
  expect(shortNotes).toHaveLength(1)
})

test('writing the same direction again carries the creator\'s notes into the new draft', async () => {
  const seen: Section[][] = []
  const base = writer([120], [])
  const st = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), async (task, tag, sections, data, dir, onText) => {
    if (task === 'script') seen.push(sections)
    return base(task, tag, sections, data, dir, onText)
  })
  const { id } = st.start('废柴觉醒')
  await settle(st, id)
  st.choose(id, 0)
  await settle(st, id)
  st.revise(id, '规矩那句要留')
  await settle(st, id)
  st.choose(id, 0, true)
  await settle(st, id)
  const draft = seen.at(-1)!
  expect(draft.find(s => s.title === '创作者看过上一版后的意见')!.body).toBe('规矩那句要留')
  expect(st.get(id).notes).toEqual(['规矩那句要留'])
  st.choose(id, 0)
  await settle(st, id)
  expect(seen.at(-1)!.some(s => s.title === '创作者看过上一版后的意见')).toBe(false)
})

test('while a step writes, the story shows what it has written so far, and drops it when the step ends', async () => {
  let release!: () => void
  const base = writer([120], [])
  const st = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), async (task, tag, sections, data, dir, onText) => {
    if (task === 'story-setup') {
      onText('世界一角：青')
      await new Promise<void>(r => (release = r))
    }
    return base(task, tag, sections, data, dir, onText)
  })
  const { id } = st.start('废柴觉醒')
  await settle(st, id)
  st.choose(id, 0)
  while (!release) await Bun.sleep(5)
  const writing = st.get(id)
  expect(writing.step).toBe('setup')
  expect(writing.live!.text).toBe('世界一角：青')
  expect(st.list()[0]!.live).toBeUndefined()
  release()
  await settle(st, id)
  expect(st.get(id).live).toBeUndefined()
  expect(JSON.parse(readFileSync(join(st.dir, id, 'story.json'), 'utf8')).live).toBeUndefined()
})
