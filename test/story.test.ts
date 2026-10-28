import { expect, test } from 'bun:test'
import { CARDS, screenplay, setupSection, voicedPerBeat } from '../src/tasks.js'

const check = (name: string, out: unknown, data?: unknown) => CARDS[name]!.checks!(out as never, data as never)

const WRITTEN = [
  '场1 内 · 锁魂洞 · 子夜，洞外山风不停',
  '锁魂洞是青冥宗镇压罪修的禁地，洞口上方刻着四个字：镇魔封邪。四根玄铁锁链从穹顶垂到石台。',
  '△ 谢无咎跪在石台上，四根锁链扣住双腕双肩。',
  '柳含烟：（不抬头）钥匙不在我身上。',
  '谢无咎（冷笑）：那就在你心里。',
  '[变化] 锁链从中间断开',
  '场2 外 · 锁魂洞外 · 拂晓，云海在崖下',
  '洞外是一片悬在崖边的石坪，云海在脚下三丈处翻涌。',
  '△ 谢无咎走出洞口。',
].join('\n')

test('the written screenplay is read into scenes, settings and dialogue, with acting notes left out of the lines', () => {
  const { scenes, problems } = screenplay(WRITTEN)
  expect(problems).toEqual([])
  expect(scenes.map(s => s.location)).toEqual(['锁魂洞', '锁魂洞外'])
  expect(scenes[0]!.setting).toStartWith('锁魂洞是青冥宗镇压罪修的禁地，洞口上方刻着四个字：镇魔封邪')
  expect(scenes[0]!.lines).toEqual([{ speaker: '柳含烟', text: '钥匙不在我身上。' }, { speaker: '谢无咎', text: '那就在你心里。' }])
})

test('a setting paragraph that holds a colon is still the setting, not a line of dialogue', () => {
  const longPrefix = screenplay('场1 内 · 锁魂洞 · 子夜\n洞口上方刻着四个字：镇魔封邪\n△ 谢无咎抬头。')
  expect(longPrefix.problems).toEqual([])
  expect(longPrefix.scenes[0]!.setting).toBe('洞口上方刻着四个字：镇魔封邪')
  const longLine = screenplay('场1 内 · 锁魂洞 · 子夜\n石门上刻着：镇魔封邪。门后是青冥宗镇压罪修的禁地，四根玄铁锁链从穹顶垂到中央石台，石台上有两处跪出来的膝印，冷白天光从穹顶一道裂缝里落下来。\n△ 谢无咎抬头。')
  expect(longLine.problems).toEqual([])
  expect(longLine.scenes[0]!.lines).toEqual([])
  const dialogueFirst = screenplay('场1 内 · 锁魂洞 · 子夜\n柳含烟：钥匙不在我身上。')
  expect(dialogueFirst.scenes[0]!.lines).toEqual([{ speaker: '柳含烟', text: '钥匙不在我身上。' }])
  expect(dialogueFirst.problems).toHaveLength(1)
})

test('a screenplay with a scene that has no setting, a bad heading or an unreadable line is sent back', () => {
  expect(check('script', WRITTEN)).toEqual([])
  expect(check('script', WRITTEN.replace('洞外是一片悬在崖边的石坪，云海在脚下三丈处翻涌。\n', ''))).toEqual(['这些场的场头下面没有写环境那一段：场2 外 · 锁魂洞外 · 拂晓，云海在崖下'])
  expect(check('script', WRITTEN.replace('场2 外 · 锁魂洞外 · 拂晓，云海在崖下', '场2 锁魂洞外'))).toHaveLength(1)
  expect(check('script', WRITTEN.replace('△ 谢无咎走出洞口。', '谢无咎走出洞口，回头看了一眼。'))).toHaveLength(1)
  expect(check('script', '谢无咎醒了。')).toHaveLength(2)
})

const extracted = (text: string, location = '锁魂洞外', age = '看起来二十出头') => ({
  scenes: [
    { id: 's1', location: '锁魂洞', beats: [{ id: 'b1', action: '谢无咎跪在石台上', lines: [{ speaker: '柳含烟', text: '钥匙不在我身上。' }, { speaker: '谢无咎', text }], seconds: 50, changes: ['锁链从中间断开'] }] },
    { id: 's2', location, beats: [{ id: 'b2', action: '谢无咎走出洞口', lines: [], seconds: 50, changes: [] }] },
  ],
  roster: {
    characters: ['柳含烟', '谢无咎'].map(name => ({ name, gender: name === '柳含烟' ? '女' : '男', age_look: age, rank: '', tier: '', needs: '', temperament: '', appearance_lines: [] })),
    locations: [{ name: '锁魂洞', beats: ['b1'] }, { name: '锁魂洞外', beats: ['b2'] }],
    props: [],
  },
})

test('an extraction that changes a word of the dialogue or loses a scene is sent back', () => {
  const { scenes } = screenplay(WRITTEN)
  const data = { min: 96, max: 144, lines: scenes.flatMap(s => s.lines), locations: scenes.map(s => s.location) }
  expect(check('script-extract', extracted('那就在你心里。'), data)).toEqual([])
  expect(check('script-extract', extracted('那就在你的心里。'), data)).toHaveLength(2)
  expect(check('script-extract', extracted('那就在你心里。', '崖边'), data)).toHaveLength(1)
  expect(check('script-extract', extracted('那就在你心里。', '锁魂洞外', ' '), data)).toEqual(['这些人物没写性别或外观年龄：柳含烟、谢无咎；剧本没写明的，按身份和称呼推一个，例如「看起来二十出头」'])
})

const SETUP = '世界一角：青冥宗\n规则：同心印\n人物：\n谢无咎：剑修\n柳含烟：宗主\n真相：五百年前\n地点：\n锁魂洞：青冥宗禁地\n独有时刻：膝印'

test('an episode setup must have every item, and an item is read up to the next one', () => {
  expect(check('story-setup', SETUP)).toEqual([])
  expect(check('story-setup', SETUP.replace('真相：五百年前\n', ''))).toEqual(['缺少这几项：真相。每一项另起一行，以「项名：」开头'])
  expect(setupSection(SETUP, '人物')).toBe('人物：\n谢无咎：剑修\n柳含烟：宗主')
  expect(setupSection(SETUP, '独有时刻')).toBe('独有时刻：膝印')
})

test('an off-screen line is read as voice-over, and the extraction must keep that mark', () => {
  const written = screenplay('场1 内 · 锁魂洞 · 子夜\n洞里四根锁链垂到石台。\n谢无咎（画外音）：五百年，我只等这一次。\n△ 谢无咎睁眼。')
  expect(written.problems).toEqual([])
  expect(written.scenes[0]!.lines).toEqual([{ speaker: '谢无咎', text: '五百年，我只等这一次。', vo: true }])
  const data = { min: 1, max: 100, lines: written.scenes[0]!.lines, locations: ['锁魂洞'] }
  const out = (vo?: boolean) => ({
    scenes: [{ id: 's1', location: '锁魂洞', beats: [{ id: 'b1', action: '谢无咎睁眼', lines: [{ speaker: '谢无咎', text: '五百年，我只等这一次。', ...(vo ? { vo } : {}) }], seconds: 5, changes: [] }] }],
    roster: { characters: [{ name: '谢无咎', gender: '男', age_look: '看起来三十岁', rank: '', tier: '', needs: '', temperament: '', appearance_lines: [] }], locations: [{ name: '锁魂洞', beats: ['b1'] }], props: [] },
  })
  expect(check('script-extract', out(true), data)).toEqual([])
  expect(check('script-extract', out(), data)).toHaveLength(2)
})

test('a review is 「无」 or lines of scene, quote, problem and fix', () => {
  expect(check('script-review', '无')).toEqual([])
  expect(check('script-review', '场1｜婚书还在，你伤不了我。｜讲设定｜换成她把婚书往他眼前一递')).toEqual([])
  expect(check('script-review', '台词有点直白，建议改改')).toHaveLength(1)
  expect(check('script-review', '场2｜“雷浪撞上他胸口。”／场3｜“林砚扯下他腰间的长老令。”｜令牌前后对不上｜让令牌一直挂在腰间')).toEqual([])
  expect(check('script-review', '场2｜只有原句｜讲设定')).toHaveLength(1)
  expect(check('script-review', Array.from({ length: 11 }, (_, i) => `场1｜原句${i}｜讲设定｜删掉`).join('\n'))).toEqual(['写了 11 条，最多 10 条：只留最伤的'])
  expect(check('script-review', Array.from({ length: 10 }, (_, i) => `场1｜原句${i}｜讲设定｜删掉`).join('\n'))).toEqual([])
})

test('a setup or screenplay that borrows a name from the prompt examples is sent back', () => {
  expect(check('story-setup', SETUP.replace('谢无咎', '韩立'))).toEqual(['这些是提示词示例里《凡人修仙传》的人名：韩立。换成本故事自己的名字'])
  expect(check('script', WRITTEN.replace('柳含烟', '墨大夫'))).toHaveLength(1)
})

test('a segment too short to speak its lines is sent back', () => {
  const beats = [{ id: 'b1', lines: [{ text: '五百年了，你还认得这张脸？' }] }, { id: 'b2', lines: [{ text: '认得。' }, { text: '那就跪下。' }] }]
  const voiced = voicedPerBeat(beats)
  expect(voiced).toEqual({ b1: 11, b2: 6 })
  const data = { beats: ['b1', 'b2'], voiced, min: 1, max: 100, locations: ['锁魂洞'] }
  const plan = (seconds: number) => ({ segments: [{ id: 'g1', beats: ['b1', 'b2'], seconds, location: '锁魂洞', continues: false, summary: '对峙' }], overflow: [] })
  expect(check('segment-plan', plan(6), data)).toEqual([])
  expect(check('segment-plan', plan(5), data)).toEqual(['g1 里的台词有 17 个字，至少要 6 秒才说得完，现在只有 5 秒；拉长这一段，或者把拍分到相邻的段'])
})

test('a location design without its identity and scale lines is sent back', () => {
  expect(check('location-design', '身份：青冥宗禁地\n视觉中心：镇魔柱\n陈设：石台一座\n尺度：门洞约三人高\n色彩：青黑石配朱砂符文\n锚点：镇魔柱、石台')).toEqual([])
  expect(check('location-design', '陈设：石台一座')).toEqual(['缺少「身份：」这一行', '缺少「视觉中心：」这一行', '缺少「尺度：」这一行', '缺少「色彩：」这一行', '缺少「锚点：」这一行'])
  expect(check('prop-design', '形制：中式长剑\n文字：无')).toEqual(['缺少「锚点：」这一行'])
})
