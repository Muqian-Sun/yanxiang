/**
 * M1: keep the engine ticking over the open project and serve the review page, where new stories
 * are written and projects created and switched. Text nodes run by themselves; pictures and videos
 * wait for a grant, videos also for the GPU. Starts paused, so opening an old project spends nothing.
 * Usage: bun src/m1/run.ts <项目目录> [端口]
 */
import { join, resolve } from 'node:path'
import { describePending, open, ROOT } from './env.js'
import { Stories } from './storyflow.js'
import { serve, type App } from './web.js'

const dir = process.argv[2]
if (!dir) throw new Error('用法：bun src/m1/run.ts <项目目录> [端口]')
/** Design 04: every 2 seconds; a guess. */
const TICK_MS = 2000
/** How often the GPU is asked whether it is up; a guess, short enough that a granted job starts soon after boot. */
const GPU_MS = 15_000
/** The review page's port; any free one. */
const PORT = Number(process.argv[3] ?? 8420)

const time = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
const say = (e: Parameters<NonNullable<Parameters<typeof open>[1]>>[0]) => console.log(`${time()} ${{ started: '▶', review: '★', done: '✓', failed: '✗', stale: '↻' }[e.type]} ${e.node} ${e.scope}${e.detail ? `：${e.detail}` : ''}`)
let current = { dir: resolve(dir), ...open(resolve(dir), say) }
current.engine.recover()
const app: App = {
  current: () => current,
  paused: true,
  projects: resolve(ROOT, 'data'),
  stories: new Stories(ROOT, join(ROOT, 'runs', 'stories')),
  switchTo(next: string) {
    // Runs already started on the old project finish on their own store; only ticking moves.
    current = { dir: resolve(next), ...open(resolve(next), say, current.gpu) }
    current.engine.recover()
    console.log(`${time()} 切换到项目 ${current.dir}`)
  },
}
const resumed = app.stories.resumeInterrupted()
if (resumed.length) console.log(`${time()} 上次被打断的故事接着写：${resumed.join('、')}`)
console.log(`${time()} 审核页：${serve(app, PORT)}（已暂停，在页面上点「继续」才开始跑）`)

async function watchGpu() {
  for (;;) {
    const gpu = current.gpu
    const was = gpu.online
    try {
      const s = await gpu.client.stats()
      gpu.online = true
      if (!was) console.log(`${time()} GPU 在线：${s.gpu}，空闲显存 ${(s.vramFree / 2 ** 30).toFixed(1)} GiB`)
    } catch {
      gpu.online = false
      if (was) console.log(`${time()} GPU 离线`)
    }
    await new Promise(r => setTimeout(r, GPU_MS))
  }
}
void watchGpu()

let shown = ''
for (;;) {
  if (!app.paused) {
    const summary = describePending(current.engine.tick()).join('\n')
    if (summary !== shown) {
      if (summary) console.log(`${time()} ${summary}`)
      shown = summary
    }
  }
  await new Promise(r => setTimeout(r, TICK_MS))
}
