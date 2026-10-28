import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prefixOf, Unknown, video, type H3Profile, type VideoRequest } from '../src/jobs/videos.js'
import { auditionLine, clampTrim, deliveryChecks, REPLAY_FRAMES, VIDEO_NODES } from '../src/pipeline/video.js'
import { Engine, type NodeDef, type TextRunner, type VisionRunner } from '../src/pipeline/engine.js'
import { ENTITY_NODES, type EntityEnv } from '../src/pipeline/entities.js'
import { STORYBOARD_NODES } from '../src/pipeline/storyboard.js'
import { loadPlugins } from '../src/plugins.js'
import { Store } from '../src/store/store.js'
import type { PlanT, TimelineT } from '../src/tasks.js'
import { ComfyError, comfy } from '../src/video/comfy.js'
import { MediaError, probe, run, tail, voiceSample } from '../src/video/media.js'
import { chooseVoices, choosePictures, compile, type Bound } from '../src/video/prompt.js'
import { align, ass, lcs, shown } from '../src/video/subtitles.js'
import type { ImageClient } from '../src/yir.js'
import { fakeComfy, render } from './fake-comfy.js'

const ROOT = join(import.meta.dir, '..')
const style = loadPlugins(join(ROOT, 'config/plugins')).plugins.get('style:3d-guoman')!
const PROFILE = { ...JSON.parse(readFileSync(join(ROOT, 'config/h3.json'), 'utf8')), pollSeconds: 0 } as H3Profile
const MODELS = [...Object.values(PROFILE.models), PROFILE.fight.lora]
const frames = (path: string) => Number(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path], { encoding: 'utf8' }).stdout.trim())

// ---------- the prompt ----------

const cutOf = (index: number, start: number, end: number, characters: string[], props: string[] = []): TimelineT['cuts'][number] =>
  ({ index, start, end, camera: '固定', shot: index === 1 ? '全景，谢无咎跪在石台前' : '近景，柳含烟在画面左侧', present: { characters, backs: [], props, view: '主视角' } })
const TL: TimelineT = {
  seconds: 8,
  cuts: [cutOf(1, 0, 4, ['谢无咎'], ['石台']), cutOf(2, 4, 8, ['谢无咎', '柳含烟'], ['婚书'])],
  timeline: Array.from({ length: 8 }, (_, s) => ({ second: s, text: s === 5 ? '柳含烟把婚书推到谢无咎面前' : `第${s}秒谢无咎不动`, changes: [] })),
  lines: [{ speaker: '柳含烟', text: '签字', start: 5, end: 6 }, { speaker: '谢无咎', text: '不签。', start: 7, end: 8 }],
  ambience: '洞风低鸣。',
  fight: false,
}
const BOUND: Bound[] = [
  { kind: 'keyframe', cut: 2, at: 4, media: 1 },
  { kind: 'portrait', name: '谢无咎', anchors: '散发、白袍', media: 2 },
  { kind: 'portrait', name: '柳含烟', anchors: '', media: 3 },
  { kind: 'prop', name: '婚书', anchors: '朱红封皮', media: 4 },
  { kind: 'view', label: '封剑洞的主图', cuts: [1, 2], media: 5 },
]

test('the compiled prompt has H3\'s six sections, binds every mention, and quiets everyone who is not speaking', () => {
  const p = compile({ style: '画风句。', summary: '柳含烟逼谢无咎签婚书。', timeline: TL, bound: BOUND, voices: [{ name: '柳含烟', media: 6 }, { name: '谢无咎', media: 7 }], voiceOver: ['谢无咎：不签。'], states: ['锁链束住双腕'], continues: true })
  expect(p.split('\n\n').map(s => s.split(':')[0])).toEqual(['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'])
  expect(p).toContain('<Picture 1> 是 [Shot 2] 开场那一刻的画面。')
  expect(p).toContain('<Picture 2> 是谢无咎，锚点：散发、白袍。')
  expect(p).toContain('<Audio 1> 是柳含烟（S1）的音色参考。')
  expect(p).toContain('<Audio 2> 是谢无咎（S2）的音色参考。')
  expect(p).toContain('[keyframe completion + reference generation + audio reference] 柳含烟（<Picture 3>）逼谢无咎（<Picture 2>）签婚书（<Picture 4>）。这一段从上一段停下的那一刻接着演。')
  expect(p).toContain('只负责谢无咎的脸、发型、身形和这套造型；不负责构图、动作和表情')
  expect(p).toContain('<Picture 5>（[Shot 1]、[Shot 2]）：weak_reference - 只负责空间和陈设方位。')
  expect(p).toContain('此刻和参考图不一样的状态以正文为准：锁链束住双腕。')
  expect(p).toContain('[Shot 1] 这一切接着上一段最后的画面，机位、景别和人物左右位置不变。镜头：全景，谢无咎（<Picture 2>）跪在石台前。运镜：固定。')
  expect(p).toContain('[Shot 2] At 00:04.000，切到第 2 个镜头。 这一切从 <Picture 1> 开始。')
  // The dialogue is verbatim with a closing mark; the listener on screen keeps their mouth shut.
  expect(p).toContain('第 5 秒：柳含烟（<Picture 3>）把婚书（<Picture 4>）推到谢无咎（<Picture 2>）面前 柳含烟（<Picture 3>）（S1）说：<d>[Chinese] 签字。</d>（第 5 秒到第 6 秒）只说一次，说完闭嘴。谢无咎（<Picture 2>）不说话，嘴唇闭合。')
  expect(p).toContain('谢无咎（S2）画外音说：<d>[Chinese] 不签。</d>（第 7 秒到第 8 秒）画面里谢无咎（<Picture 2>）嘴唇闭合，没有人张嘴。')
  expect(p).toContain('overall_soundscape:\n洞风低鸣。除了台词，没有别的人声。')
  expect(p.endsWith('non_diegetic_music:\n无')).toBe(true)
  expect(compile({ style: '', summary: '', timeline: { ...TL, fight: true }, bound: BOUND, voices: [], voiceOver: [], states: [], continues: false, trigger: 'wushu_action,' }).startsWith('wushu_action,\n\nsubject_definitions:')).toBe(true)
})

test('a flat lay binds only the clothes of a group; a later costume is named with its person', () => {
  const bound: Bound[] = [
    { kind: 'portrait', name: '谢无咎', anchors: '凤冠', media: 2, costume: '嫁衣' },
    { kind: 'portrait', name: '柳含烟', anchors: '', media: 3, outfit: 2 },
  ]
  const p = compile({ style: '', summary: '', timeline: TL, bound, voices: [], voiceOver: [], states: [], continues: false })
  expect(p).toContain('<Picture 1> 是谢无咎（嫁衣），锚点：凤冠。')
  expect(p).toContain('只负责谢无咎的脸、发型、身形和这套造型')
  expect(p).toContain('<Picture 2> 是柳含烟穿的这一套服装，画面里 2 个柳含烟都穿它，脸和身形各不相同。')
  expect(p).toContain('<Picture 2>（出现在 [Shot 2]）：partially_preserved - 只负责柳含烟的衣服、鞋和佩物；不负责脸、发型和身形，2 个人各长各的，也不继承平铺的摆法。')
})

test('past nine pictures the keyframes stay, then the main people, props, the place, the others; past three voices the busiest stay', () => {
  const kf = Array.from({ length: 5 }, (_, i): Bound => ({ kind: 'keyframe', cut: i + 1, at: i * 2, media: i }))
  const wanted: Bound[] = [...kf, { kind: 'portrait', name: '甲', anchors: '', media: 10 }, { kind: 'portrait', name: '乙', anchors: '', media: 11 }, { kind: 'prop', name: '剑', anchors: '', media: 12 }, { kind: 'view', label: '主图', cuts: [1], media: 13 }, { kind: 'view', label: '反打', cuts: [2], media: 14 }]
  const { bound, dropped } = choosePictures(wanted, ['甲'])
  expect(bound).toHaveLength(9)
  expect(dropped.map(b => (b.kind === 'portrait' ? b.name : b.kind))).toEqual(['乙'])
  expect(bound.slice(0, 5)).toEqual(kf)
  const voices = chooseVoices(['甲', '乙', '丙', '丁'].map((name, i) => ({ name, media: i })), [{ speaker: '丁' }, { speaker: '丁' }, { speaker: '甲' }, { speaker: '乙' }, { speaker: '丙' }, { speaker: '丙' }])
  expect(voices.dropped.map(v => v.name)).toHaveLength(1)
  expect(voices.voices.map(v => v.name)).toContain('丁')
  expect(voices.voices.map(v => v.name)).toContain('丙')
})

test('the audition says one of the character\'s own lines that fits in six seconds, cut at a pause when none does', () => {
  expect(auditionLine(['签字。', '你若不签，我便替你签。'])).toEqual({ line: '你若不签，我便替你签。', seconds: 5 })
  const long = auditionLine(['五百年前你亲手封了这座洞，今日你却要我替你守着它，凭什么？'])
  expect(long.line).toBe('五百年前你亲手封了这座洞，')
  expect(long.seconds).toBe(5)
})

test('trim points are tightened: a continuing segment drops its replay, no line is cut, the tail loses at most 1.5 s', () => {
  expect(clampTrim({ in: 0.2, out: 9.5 }, { duration: 10, continues: false })).toEqual({ in: 0.2, out: 9.5, adjusted: false })
  expect(clampTrim({ in: 0.1, out: 9.5 }, { duration: 10, continues: true })).toEqual({ in: 0.92, out: 9.5, adjusted: true })
  expect(clampTrim({ in: 2.5, out: 6 }, { duration: 10, continues: false, firstLine: 1.5, lastLineEnd: 9.5 })).toEqual({ in: 1, out: 9.7, adjusted: true })
  expect(clampTrim({ in: 0, out: 12 }, { duration: 10, continues: false })).toEqual({ in: 0, out: 10, adjusted: true })
})

test('subtitles keep the script\'s words and take their times from the speech; a line not heard keeps its planned time', () => {
  expect(shown('签字。')).toBe('签字')
  expect(shown('你敢？')).toBe('你敢？')
  expect(lcs([...'abc'], [...'xaybc'])).toEqual([1, 3, 4])
  const cues = align(
    [{ text: '你若不签，我便替你签。', start: 1, end: 3 }, { text: '休想！', start: 5, end: 6 }],
    [{ text: '你弱', start: 1.4, end: 1.8 }, { text: '不签我便替你签', start: 1.8, end: 3.2 }, { text: '嗯', start: 5.5, end: 5.6 }],
  )
  expect(cues[0]).toEqual({ text: '你若不签，我便替你签', start: 1.4, end: 3.2, measured: true })
  expect(cues[1]).toEqual({ text: '休想！', start: 5, end: 6, measured: false })
  expect(ass(cues, 1920, 1080, 'Hiragino Sans GB')).toContain('Dialogue: 0,0:00:01.40,0:00:03.20,Default,,0,0,0,,你若不签，我便替你签')
})

test('every delivery check is reported', () => {
  const checks = deliveryChecks({ width: 1920, height: 1080, fps: 24, vcodec: 'h264', acodec: 'aac', duration: 50, loudness: -17.2, black: [], silence: [[3, 7]], size: [1920, 1080], seconds: [45, 60], unmeasured: [] })
  expect(checks.filter(c => !c.ok).map(c => c.check)).toEqual(['静音', '响度'])
})

// ---------- media ----------

test('the guide clip is exactly the 22 frames before the out point, with sound; a stretch with no voice is refused as a sample', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yx-media-'))
  const clip = join(dir, 'clip.mp4')
  render(320, 180, 5, clip)
  await tail(clip, 4, REPLAY_FRAMES, join(dir, 'tail.mp4'))
  expect(frames(join(dir, 'tail.mp4'))).toBe(22)
  expect((await probe(join(dir, 'tail.mp4'))).hasAudio).toBe(true)
  await expect(tail(clip, 4, 21, join(dir, 'bad.mp4'))).rejects.toThrow('17k+5')
  await voiceSample(clip, 1, 2, join(dir, 'voice.wav'))
  expect(existsSync(join(dir, 'voice.wav'))).toBe(true)
  const quiet = join(dir, 'quiet.mp4')
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=3', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', quiet])
  await expect(voiceSample(quiet, 0, 2.5, join(dir, 'q.wav'))).rejects.toThrow(MediaError)
})

// ---------- jobs ----------

function jobStore() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'yx-vjob-')))
  store.createProject({ name: '样片', entry: 'script', style: '3d-guoman', genre: 'xianxia', seconds_min: 45, seconds_max: 60, delivery: '1080p' })
  const run = store.addNodeRun('draft', 'e1/g1')
  const picture = store.putMedia(new TextEncoder().encode('kf'), 'image/png')
  const request: VideoRequest = { prompt: 'p', seconds: 4, seed: 1, refine: false, loras: [], references: [{ role: 'keyframe', media: picture, at: 0 }], node_run_id: run.id, candidate: 1 }
  return { store, request }
}

test('a video job checks the server first, uploads, submits once, and a second call reuses the clip', async () => {
  const fake = fakeComfy(MODELS)
  const { store, request } = jobStore()
  const client = comfy(fake.url)
  const first = await video(store, client, PROFILE, request, async () => {})
  expect(fake.prompts).toHaveLength(1)
  expect(fake.uploads).toEqual([{ folder: prefixOf(store.job(first.job)), name: '01.png', bytes: 2 }])
  const save = Object.values(fake.prompts[0]!.graph).find(n => n.class_type === 'SaveVideo')!
  expect(save.inputs.filename_prefix).toBe(`yanxiang/job-${first.job}`)
  expect((await probe(store.mediaPath(first.media))).width).toBe(1024)
  expect((await video(store, client, PROFILE, request, async () => {})).media).toBe(first.media)
  expect(fake.prompts).toHaveLength(1)
  fake.stop()
})

test('a missing model file fails the job before anything is uploaded', async () => {
  const fake = fakeComfy(MODELS.filter(m => m !== PROFILE.models.turboLora))
  const { store, request } = jobStore()
  await expect(video(store, comfy(fake.url), PROFILE, request, async () => {})).rejects.toThrow(`没有模型文件 ${PROFILE.models.turboLora}`)
  expect(fake.uploads).toHaveLength(0)
  expect(store.jobs(['failed'])[0]!.error_code).toBe('missing')
  fake.stop()
})

test('only a loopback address is accepted', () => {
  expect(() => comfy('http://10.0.0.5:8188')).toThrow('回环')
})

test('after a crash mid-submit the job is found by its prefix; when it is nowhere it waits for the creator and is never resubmitted by itself', async () => {
  const fake = fakeComfy(MODELS)
  const { store, request } = jobStore()
  const client = comfy(fake.url)
  // Submitted, then the process died before recording the prompt id.
  const done = await video(store, client, PROFILE, request, async () => {})
  store.db.prepare("UPDATE job SET status = 'submitting', provider_job_id = NULL, output_media_id = NULL WHERE id = ?").run(done.job)
  expect((await video(store, client, PROFILE, request, async () => {})).media).toBe(done.media)
  expect(fake.prompts).toHaveLength(1)

  fake.lost = true
  store.db.prepare("UPDATE job SET status = 'submitting', provider_job_id = NULL WHERE id = ?").run(done.job)
  await expect(video(store, client, PROFILE, request, async () => {})).rejects.toBeInstanceOf(Unknown)
  expect(store.job(done.job).status).toBe('unknown')
  await expect(video(store, client, PROFILE, request, async () => {})).rejects.toBeInstanceOf(Unknown)
  expect(fake.prompts).toHaveLength(1)
  fake.stop()
})

test('a submitted job the server no longer knows becomes unknown', async () => {
  const fake = fakeComfy(MODELS)
  fake.pendingPolls = 5
  const { store, request } = jobStore()
  let sleeps = 0
  const run = video(store, comfy(fake.url), PROFILE, request, async () => {
    if (++sleeps === 2) fake.lost = true
  })
  await expect(run).rejects.toBeInstanceOf(Unknown)
  expect(store.jobs(['unknown'])).toHaveLength(1)
  fake.stop()
})

// ---------- the chain ----------

const beat = (id: string, action: string, seconds: number, lines: { speaker: string; text: string }[] = [], changes: string[] = []) => ({ id, action, lines, seconds, changes })
const SCRIPT = { scenes: [{ id: 'sc1', location: '封剑洞', beats: [beat('b1', '谢无咎跪在石台上。', 5, [], ['锁链束住双腕']), beat('b2', '柳含烟抽出婚书。', 5, [{ speaker: '柳含烟', text: '签字。' }]), beat('b3', '两人僵持。', 4)] }] }
const person = (name: string, gender: string) => ({ name, gender, age_look: '看起来二十多岁', rank: '剑修', tier: '主角', needs: '', temperament: '', appearance_lines: [] })
const ROSTER = {
  characters: [person('谢无咎', '男'), person('柳含烟', '女')],
  locations: [{ name: '封剑洞', beats: ['b1', 'b2', 'b3'] }],
  props: [{ name: '石台', holder: '洞中央', beats: ['b1'] }, { name: '婚书', holder: '柳含烟', beats: ['b2'] }],
}
const PLAN: PlanT = { segments: [{ id: 'g1', beats: ['b1', 'b2'], seconds: 10, location: '封剑洞', continues: false, summary: '逼签' }, { id: 'g2', beats: ['b3'], seconds: 4, location: '封剑洞', continues: true, summary: '僵持' }], overflow: [] }
const cut = (index: number, start: number, end: number, view: string, characters: string[], props: string[]): TimelineT['cuts'][number] => ({ index, start, end, camera: '固定', shot: '中景', present: { characters, backs: [], props, view } })
const TL1: TimelineT = { seconds: 10, cuts: [cut(1, 0, 5, '主视角', ['谢无咎'], ['石台']), { ...cut(2, 5, 10, '主视角', ['谢无咎', '柳含烟'], ['婚书']), present: { characters: ['谢无咎', '柳含烟'], backs: ['谢无咎'], props: ['婚书'], view: '主视角' } }], timeline: Array.from({ length: 10 }, (_, s) => ({ second: s, text: `第${s}秒`, changes: [] })), lines: [{ speaker: '柳含烟', text: '签字。', start: 6, end: 8 }], ambience: '洞风', fight: false }
const TL2: TimelineT = { seconds: 4, cuts: [cut(1, 0, 2, '沿用', ['谢无咎', '柳含烟'], []), cut(2, 2, 4, '主视角', ['柳含烟'], ['婚书'])], timeline: Array.from({ length: 4 }, (_, s) => ({ second: s, text: `续${s}`, changes: [] })), lines: [], ambience: '洞风', fight: true }

function chainProject() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'yx-chain-')))
  store.createProject({ name: '样片', entry: 'script', style: '3d-guoman', genre: 'xianxia', seconds_min: 45, seconds_max: 60, delivery: '1080p' })
  store.addArtifact({ kind: 'style_ref', scope: 'p', payload: {}, status: 'locked', created_by: 'program' })
  const script = store.addArtifact({ kind: 'script', scope: 'e1', payload: SCRIPT, status: 'locked', created_by: 'user' })
  store.addArtifact({ kind: 'roster', scope: 'e1', payload: ROSTER, inputs: [script.id], status: 'locked', created_by: 'user' })
  for (const kind of ['char', 'loc', 'prop'] as const) {
    for (const row of kind === 'char' ? ROSTER.characters : kind === 'loc' ? ROSTER.locations : ROSTER.props) {
      const scope = `e1/${kind}/${row.name}`
      store.addArtifact({ kind: 'entity_brief', scope, payload: { text: `锚点：${row.name}的锚点\n主色：白` }, status: 'locked', created_by: 'user' })
      store.addArtifact({ kind: 'entity_desc', scope, payload: { text: row.name }, status: 'locked', created_by: 'user' })
      const img = store.addArtifact({ kind: 'entity_image', scope, payload: {}, media_id: store.putMedia(new TextEncoder().encode(scope), 'image/png'), status: 'locked', created_by: 'user' })
      store.addArtifact({ kind: 'entity_lock', scope, payload: { image_id: img.id }, inputs: [img.id], status: 'locked', created_by: 'user' })
    }
  }
  return store
}

const reply = (output: unknown) => ({ output, raw: '', attempts: [], system: '', user: '', promptVersion: 'v', model: 'fake' })
const text: TextRunner = async ({ card, sections }) => {
  if (card.name === 'segment-plan') return reply(PLAN)
  if (card.name === 'timeline') return reply(sections[0]!.body.startsWith('g1') ? TL1 : TL2)
  if (card.name === 'view-groups') return reply({ views: [{ name: '主视角', camera: '', cuts: ['g1/c1', 'g1/c2', 'g2/c2'] }] })
  return reply('关键帧描写')
}
const fakeImages = { async submit() { return { providerJob: `i${Math.random()}`, quotedUsd: 0 } }, async poll() { return 'succeeded' }, async wait() {}, async download(id: string) { return { bytes: new TextEncoder().encode(id), mime: 'image/png' } } } as unknown as ImageClient

test('from locked keyframes to the delivered episode: auditions, drafts with the replayed tail, trims, both cuts and the refine pass', async () => {
  const fake = fakeComfy(MODELS)
  const store = chainProject()
  const trims: unknown[] = []
  const vision: VisionRunner = async ({ card, data, images, sections }) => {
    if (card.name === 'blocking') return reply({ spots: [{ name: '石台前', kind: '站位', where: '主图画面中央' }], people: Object.entries((data as { first: Record<string, string> }).first).map(([name, from]) => ({ name, from, spot: '石台前', pose: '站着', how: '开场就在' })) })
    trims.push({ images: images.length, body: sections[0]!.body })
    const seconds = (data as { seconds: number }).seconds
    return reply({ in: 0.1, out: Math.round((seconds - 0.3) * 100) / 100, reason: '开头发呆，结尾空转' })
  }
  // Speech heard where it was planned: 6 s into the first segment, minus its 0.1 s in point.
  const listen = async (source: string) => ((await probe(source)).duration < 6 ? [{ text: '签字', start: 1, end: 1.8 }] : [{ text: '签字', start: 6, end: 6.6 }])
  const gpu = { client: comfy(fake.url), profile: PROFILE, online: false }
  const e = new Engine({ store, root: ROOT, text, vision, images: fakeImages, style, gpu, listen, sleep: async () => {} } as EntityEnv, [...ENTITY_NODES, ...STORYBOARD_NODES, ...VIDEO_NODES])
  const decide = (point: number) => {
    for (const r of store.openReviews().filter(x => x.point === point)) (point === 5 || point === 7 ? e.pick(r.id, r.artifact_ids[0]!) : e.approve(r.id))
  }
  const rounds = async (n: number, points: number[]) => {
    for (let i = 0; i < n; i++) {
      e.tick()
      await e.settle()
      points.forEach(decide)
    }
  }
  store.grant('e1', 'image', 20)
  await rounds(8, [5, 6])
  // Cut 2 shows 谢无咎 from behind: its keyframe is drawn from his turnaround, not his portrait.
  expect((store.locked('keyframe', 'e1/g1/c2')!.payload as { prompt: string }).prompt).toContain('是谢无咎的三视图')
  expect((store.locked('keyframe', 'e1/g1/c1')!.payload as { prompt: string }).prompt).toContain('是谢无咎的定妆照')
  expect(['e1/g1/c1', 'e1/g1/c2', 'e1/g2/c2'].every(s => store.locked('keyframe', s))).toBe(true)

  // A granted video waits while the GPU is off, without using its grant.
  store.grant('e1', 'video', 20)
  expect(e.tick(true).filter(p => p.gpu).map(p => `${p.node} ${p.scope}`)).toEqual(['audition e1/char/柳含烟'])
  e.tick()
  await e.settle()
  expect(store.permitsLeft('e1', 'video')).toBe(20)
  expect(fake.prompts).toHaveLength(0)

  gpu.online = true
  await rounds(14, [5, 7, 8])
  const final = store.locked('cut_final', 'e1') ?? store.latest('cut_final', 'e1')
  expect(final).toBeTruthy()

  // Only the speaker auditions; her voice is the cut speech, at least 2 s.
  expect(store.latest('audition', 'e1/char/谢无咎')).toBeUndefined()
  const voice = store.locked('voice', 'e1/char/柳含烟')!
  expect(voice.payload).toEqual({ from: 0.9, to: 2.9 })

  // Five generations: one audition, two drafts, two refines; each paid once.
  expect(fake.prompts).toHaveLength(5)
  expect(store.permitsLeft('e1', 'video')).toBe(15)
  const graphs = fake.prompts.map(p => p.graph)
  const prompt = (g: (typeof graphs)[number]) => Object.values(g).find(n => n.class_type === 'MiniMaxH3ReferenceToVideo')!.inputs.prompt as string
  const pins = (g: (typeof graphs)[number]) => Object.values(g).filter(n => n.class_type === 'MiniMaxH3AddGuide').map(n => n.inputs.frame_idx)
  const g1 = store.locked('clip_draft', 'e1/g1')!.payload as { prompt: string; seed: number }
  const g2 = store.locked('clip_draft', 'e1/g2')!.payload as { prompt: string; seed: number; guide: number }
  expect(g1.prompt).toContain('<d>[Chinese] 签字。</d>')
  expect(g1.prompt).toContain('<Audio 1> 是柳含烟（S1）的音色参考。')
  expect(g1.prompt).toMatch(/<Picture \d> 是谢无咎的三视图（正面、侧面、背面）/)
  expect(g1.prompt).not.toContain('谢无咎的定妆照')
  expect(pins(graphs[1]!)).toEqual([0, 120])
  // The continuing segment: no keyframe for its first cut, the previous draft's tail pinned at frame 0, the fight LoRA and its trigger.
  expect(g2.prompt.startsWith('wushu_action,')).toBe(true)
  expect(pins(graphs[2]!)).toEqual([0, 48])
  expect(Object.values(graphs[2]!).some(n => n.class_type === 'LoadVideo')).toBe(true)
  expect(Object.values(graphs[2]!).some(n => n.inputs.lora_name === PROFILE.fight.lora)).toBe(true)
  expect(frames(store.mediaPath(g2.guide))).toBe(REPLAY_FRAMES)
  // The trims: the replay of the continuing segment is dropped.
  expect((store.locked('trim', 'e1/g2')!.payload as { in: number; adjusted: boolean })).toMatchObject({ in: 0.92, adjusted: true })
  expect(trims).toHaveLength(2)
  expect((trims[0] as { images: number }).images).toBe(16)
  // Refines: same seed, same prompt, upscaled; the continuing one guided by the refined tail.
  const f1 = store.locked('clip_final', 'e1/g1')!.payload as { seed: number; prompt: string }
  const f2 = store.locked('clip_final', 'e1/g2')!.payload as { guide: number }
  expect(f1.seed).toBe(g1.seed)
  expect(f1.prompt).toBe(g1.prompt)
  expect(prompt(graphs[3]!)).toBe(g1.prompt)
  expect((await probe(store.mediaPath(store.locked('clip_final', 'e1/g1')!.media_id!))).width).toBe(1920)
  expect((await probe(store.mediaPath(f2.guide))).width).toBe(1920)

  // The draft cut at 576p with its subtitle timed by the speech; the delivery at 1080p with its label and checks.
  const draftCut = store.locked('cut_draft', 'e1')!
  expect((draftCut.payload as { cues: unknown[] }).cues).toEqual([{ text: '签字', start: 6, end: 6.6, measured: true }])
  expect((await probe(store.mediaPath(draftCut.media_id!))).height).toBe(576)
  const delivered = (await probe(store.mediaPath(final!.media_id!)))
  expect([delivered.width, delivered.height, delivered.vcodec, delivered.acodec]).toEqual([1920, 1080, 'h264', 'aac'])
  expect(delivered.tags.comment).toContain('"Label":"1"')
  const checks = (final!.payload as { checks: { check: string; ok: boolean }[] }).checks
  expect(checks.filter(c => !c.ok).map(c => c.check)).toContain('总时长')
  expect(checks.find(c => c.check === '响度')!.ok).toBe(true)
  expect(existsSync(join(store.dir, '交付', '第1集', '成片.mp4'))).toBe(true)
  fake.stop()
}, 120_000)

test('every video node is free unless it generates: auditions, drafts and refines need a grant, the rest do not', () => {
  const paid = (VIDEO_NODES as NodeDef[]).filter(n => n.paid).map(n => n.name)
  expect(paid).toEqual(['audition', 'draft', 'refine'])
})

test('a segment\'s video binds the flat lay for a name standing for several people, not the portrait', () => {
  const store = chainProject()
  const roster = { ...ROSTER, characters: [{ ...ROSTER.characters[0]!, count: 2 }, ROSTER.characters[1]!] }
  store.db.prepare('UPDATE artifact SET payload = ? WHERE id = ?').run(JSON.stringify(roster), store.locked('roster', 'e1')!.id)
  const picture = (kind: string, scope: string) => store.addArtifact({ kind, scope, payload: {}, media_id: store.putMedia(new TextEncoder().encode(scope), 'image/png'), status: 'locked', created_by: 'user' })
  const flat = picture('entity_image', 'e1/char/谢无咎/服装平铺')
  const flatLock = store.addArtifact({ kind: 'entity_lock', scope: 'e1/char/谢无咎/服装平铺', payload: { image_id: flat.id }, inputs: [flat.id], status: 'locked', created_by: 'user' })
  store.addArtifact({ kind: 'segment_plan', scope: 'e1', payload: PLAN, status: 'locked', created_by: 'model' })
  store.addArtifact({ kind: 'timeline', scope: 'e1/g1', payload: TL1, status: 'locked', created_by: 'model' })
  store.addArtifact({ kind: 'view_plan', scope: 'e1/loc/封剑洞', payload: { views: [{ name: '主视角', camera: '', cuts: ['g1/c1', 'g1/c2'] }] }, status: 'locked', created_by: 'model' })
  picture('keyframe', 'e1/g1/c1')
  picture('keyframe', 'e1/g1/c2')
  store.addArtifact({ kind: 'voice', scope: 'e1/char/柳含烟', payload: { from: 0, to: 2 }, media_id: store.putMedia(new TextEncoder().encode('voice'), 'audio/wav'), status: 'locked', created_by: 'program' })
  const ready = (VIDEO_NODES as NodeDef[]).find(n => n.name === 'draft')!.ready(store, 'e1/g1')
  expect(ready.ok).toBe(true)
  const inputs = (ready as { inputs: number[] }).inputs
  expect(inputs).toContain(flatLock.id)
  expect(inputs).not.toContain(store.locked('entity_lock', 'e1/char/谢无咎')!.id)
})

test('when the GPU drops mid-job the job is kept, and a retry resumes it without submitting again', async () => {
  const fake = fakeComfy(MODELS)
  fake.pendingPolls = 3
  const { store, request } = jobStore()
  const real = comfy(fake.url)
  let drop = true
  const flaky = { ...real, async history(id: string) {
    if (drop && fake.prompts.length) { drop = false; throw new ComfyError('连不上 ComfyUI', 'offline') }
    return real.history(id)
  } }
  await expect(video(store, flaky, PROFILE, request, async () => {})).rejects.toThrow('连不上')
  expect(store.jobs(['submitted'])).toHaveLength(1)
  const done = await video(store, flaky, PROFILE, request, async () => {})
  expect(store.job(done.job).status).toBe('succeeded')
  expect(fake.prompts).toHaveLength(1)
  fake.stop()
})

test('an external command does not block the process: timers and the page keep running while ffmpeg works', async () => {
  let ticked = false
  setTimeout(() => (ticked = true), 50)
  await run(['sleep', '0.5'])
  expect(ticked).toBe(true)
})
