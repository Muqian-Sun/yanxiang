/**
 * M1: keep the engine ticking over one project until stopped. Text nodes run by themselves;
 * pictures wait for `ctl grant`. Usage: bun src/m1/run.ts <项目目录>
 */
import { open } from './env.js'

const dir = process.argv[2]
if (!dir) throw new Error('用法：bun src/m1/run.ts <项目目录>')
/** Design 04: every 2 seconds; a guess. */
const TICK_MS = 2000

const time = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
const { store, engine } = open(dir, e => console.log(`${time()} ${{ started: '▶', review: '★', done: '✓', failed: '✗', stale: '↻' }[e.type]} ${e.node} ${e.scope}${e.detail ? `：${e.detail}` : ''}`))
engine.recover()
let shown = ''
for (;;) {
  const pending = engine.tick()
  const summary = pending.map(p => `${p.scope}（${p.images} 张）`).join('、')
  if (summary !== shown) {
    if (summary) console.log(`${time()} 待开始出图：${summary}`)
    shown = summary
  }
  const open = store.openReviews().length
  if (open) process.title = `yanxiang：${open} 项待审`
  await new Promise(resolve => setTimeout(resolve, TICK_MS))
}
