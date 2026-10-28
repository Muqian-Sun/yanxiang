/**
 * M1: look at and decide on a project from the command line, until the review pages exist.
 * Usage: bun src/m1/ctl.ts <项目目录> <命令> [参数]
 *   status                      每个作用域各节点的最新状态、待开始出图、授权余额
 *   reviews                     打开的审核和其中的产物（文字全文、图片路径）
 *   approve <审核>              通过
 *   pick <审核> <产物>          挑定一张
 *   revise <产物> <意见> [审核] 带意见重写这个产物
 *   redo <审核>                 同样的输入重出（需要授权）
 *   grant <作用域> <张数> [video] 授权出图（加 video 是授权出片的段数）
 *   retry <节点运行>            重试失败的节点
 *   rerun <节点> <作用域>…      按现在的提示词重写这些作用域（不花钱的节点）
 *   resubmit <任务>             「可能没提交成功」的视频任务重提
 *   gpu                         GPU 是否在线
 *   adopt <图片产物> <作用域>   把已经出过的一张图沿用到这个作用域，打开它的审核
 */
import { describePending, open } from './env.js'

const [dir, command, ...args] = process.argv.slice(2)
if (!dir || !command) throw new Error('用法：bun src/m1/ctl.ts <项目目录> <命令> [参数]，命令见文件开头')
const { store, engine, gpu } = open(dir)
const n = (i: number) => {
  const value = Number(args[i])
  if (!Number.isInteger(value)) throw new Error(`第 ${i + 1} 个参数要是整数`)
  return value
}

if (command === 'status') {
  const runs = store.db.prepare('SELECT node, scope, status, error FROM node_run WHERE id IN (SELECT MAX(id) FROM node_run GROUP BY node, scope) ORDER BY scope, node').all() as { node: string; scope: string; status: string; error: string | null }[]
  for (const r of runs) console.log(`${r.scope.padEnd(20)} ${r.node.padEnd(7)} ${r.status}${r.error ? `：${r.error}` : ''}`)
  const pending = engine.tick(true)
  console.log(describePending(pending).join('\n') || '没有待开始的出图、出片')
  console.log(`已报价合计：${(store.db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM job WHERE status = 'succeeded'").get() as { c: number }).c.toFixed(4)} 美元`)
} else if (command === 'reviews') {
  for (const r of store.openReviews()) {
    console.log(`\n=== 审核 ${r.id}　★${r.point}　${r.scope}`)
    for (const id of r.artifact_ids) {
      const a = store.artifact(id)
      console.log(`--- 产物 ${id}（${a.kind} 第 ${a.version} 版）`)
      console.log(a.media_id ? store.mediaPath(a.media_id) : (a.payload as { text?: string }).text ?? JSON.stringify(a.payload))
    }
  }
} else if (command === 'approve') engine.approve(n(0))
else if (command === 'pick') engine.pick(n(0), n(1))
else if (command === 'revise') {
  if (!args[1]) throw new Error('revise 要写修改意见')
  engine.revise(n(0), args[1], args[2] === undefined ? undefined : n(2))
} else if (command === 'redo') engine.redo(n(0))
else if (command === 'grant') {
  if (!args[0]) throw new Error('grant 要写作用域')
  store.grant(args[0], args[2] === 'video' ? 'video' : 'image', n(1))
} else if (command === 'retry') engine.retry(n(0))
else if (command === 'rerun') {
  if (args.length < 2) throw new Error('rerun 要写节点和至少一个作用域')
  for (const scope of args.slice(1)) engine.rerun(args[0]!, scope)
} else if (command === 'resubmit') engine.resubmit(n(0))
else if (command === 'gpu') {
  try {
    const s = await gpu.client.stats()
    console.log(`GPU 在线：${s.gpu}，空闲显存 ${(s.vramFree / 2 ** 30).toFixed(1)} GiB`)
  } catch (error) {
    console.log(`GPU 离线：${error instanceof Error ? error.message : String(error)}`)
  }
}
else if (command === 'adopt') {
  if (!args[1]) throw new Error('adopt 要写作用域')
  console.log(`审核 ${engine.adopt(n(0), args[1])}`)
} else throw new Error(`不认识的命令 ${command}`)
if (!['status', 'reviews', 'gpu'].includes(command)) console.log('✓ 完成')
