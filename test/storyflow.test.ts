import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Stories, type Writer } from '../src/m1/storyflow.js'
import type { Section } from '../src/runner.js'

const ROOT = join(import.meta.dir, '..')
const SCREENPLAY = '场1 内 · 锁魂洞 · 子夜\n洞里四根锁链垂到石台。\n△ 林砚睁眼。\n林砚：我还活着。'
const SETUP = '世界一角：青冥宗\n规则：同心印\n人物：\n林砚：外门杂役\n真相：五百年前\n地点：\n锁魂洞：禁地\n独有时刻：膝印'
const DIRECTION = { title: '废柴觉醒', logline: '', strategy: '', opposition: '', cost: '', payoff: '', opening: '' }

/** A writer whose extraction gives the screenplay `lengths[n]` seconds on its n-th call; it records every rewrite note. */
function writer(lengths: number[], notes: string[]): Writer {
  let extractions = 0
  return async (task, _tag, sections: Section[]) => {
    if (task === 'story-directions') return { directions: [DIRECTION, DIRECTION, DIRECTION] }
    if (task === 'story-setup') return SETUP
    if (task === 'script-review') return '无'
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

test('a screenplay that runs long is rewritten to the measured seconds and extracted again', async () => {
  const notes: string[] = []
  const st = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), writer([67, 55], notes))
  const { id } = st.start('废柴觉醒')
  await settle(st, id)
  st.choose(id, 0)
  await settle(st, id)
  const story = st.get(id)
  expect(story.error).toBeUndefined()
  expect(story.script!.scenes[0]!.beats[0]!.seconds).toBe(55)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('这一版约 67 秒，要落在 45–60 秒：删掉或合并')
})

test('when rewriting does not bring it into range the screenplay is kept for the creator, with the reason', async () => {
  const notes: string[] = []
  const st = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), writer([67], notes))
  const { id } = st.start('废柴觉醒')
  await settle(st, id)
  st.choose(id, 0)
  await settle(st, id)
  const story = st.get(id)
  expect(story.script).toBeUndefined()
  expect(story.text).toBe(SCREENPLAY)
  expect(story.error).toContain('约 67 秒，自动删改 2 次还不在 45–60 秒')
  expect(notes).toHaveLength(2)
})

test('directions redone with a note carry the previous three and the note', async () => {
  const seen: Section[][] = []
  const base = writer([55], [])
  const st = new Stories(ROOT, mkdtempSync(join(tmpdir(), 'yx-story-')), async (task, tag, sections, data, dir) => {
    if (task === 'story-directions') seen.push(sections)
    return base(task, tag, sections, data, dir)
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
  const first = new Stories(ROOT, dir, writer([55], []))
  const { id } = first.start('废柴觉醒')
  await settle(first, id)
  first.choose(id, 0)
  await settle(first, id)
  // As the process leaves it when it dies after the rewrite: the screenplay written, no beats, the step still marked.
  const path = join(dir, id, 'story.json')
  const cut = { ...JSON.parse(readFileSync(path, 'utf8')), script: undefined, step: 'script-revised' }
  writeFileSync(path, JSON.stringify(cut))
  const calls: string[] = []
  const base = writer([55], [])
  const again = new Stories(ROOT, dir, async (task, tag, sections, data, logDir) => { calls.push(task); return base(task, tag, sections, data, logDir) })
  expect(again.resumeInterrupted()).toEqual([id])
  await settle(again, id)
  const story = again.get(id)
  expect(story.script!.scenes[0]!.beats[0]!.seconds).toBe(55)
  expect(calls).toEqual(['script-extract'])
  expect(again.resumeInterrupted()).toEqual([])
})
