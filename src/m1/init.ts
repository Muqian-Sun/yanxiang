/**
 * M1: create the sample project from a hand-written script. The script and roster are the
 * creator's, so they go in locked (created_by user). Usage: bun src/m1/init.ts <script.json> <项目目录>
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Store } from '../store/store.js'
import { CARDS, Script } from '../tasks.js'

const [scriptPath, dir] = process.argv.slice(2)
if (!scriptPath || !dir) throw new Error('用法：bun src/m1/init.ts <script.json> <项目目录>')
if (existsSync(join(resolve(dir), 'project.db'))) throw new Error(`${dir} 里已经有项目了`)
/** M1 spec: a 45–60 second sample (design 10). */
const MIN = 45
const MAX = 60

const parsed = Script.safeParse(JSON.parse(readFileSync(scriptPath, 'utf8')))
if (!parsed.success) throw new Error(`剧本格式不对：${parsed.error.message}`)
const problems = CARDS.script!.checks!(parsed.data as never, { min: MIN, max: MAX } as never)
if (problems.length) throw new Error(`剧本没通过检查：${problems.join('；')}`)

const store = new Store(resolve(dir))
store.tx(() => {
  store.createProject({ name: '样片', entry: 'script', style: '3d-guoman', genre: 'xianxia', seconds_min: MIN, seconds_max: MAX, delivery: '1080p' })
  store.addArtifact({ kind: 'style_ref', scope: 'p', payload: { plugin: '3d-guoman', file: 'style-ref.png' }, status: 'locked', created_by: 'program' })
  const script = store.addArtifact({ kind: 'script', scope: 'e1', payload: { scenes: parsed.data.scenes }, status: 'locked', created_by: 'user' })
  const roster = store.addArtifact({ kind: 'roster', scope: 'e1', payload: parsed.data.roster, inputs: [script.id], status: 'locked', created_by: 'user' })
  console.log(`✓ 项目建在 ${resolve(dir)}：剧本 #${script.id}、出场清单 #${roster.id}，都已锁定`)
})
store.close()
