/**
 * Draw the style plugin's style reference: one scene with no people and no writing, so it
 * carries the look and nothing that could leak into other pictures. Bound to location,
 * location-view and keyframe images. Usage: bun src/m0/style-ref.ts <输出文件，不带扩展名>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { imagePrompt } from '../compose.js'
import { loadModels } from '../llm.js'
import { loadPlugins } from '../plugins.js'
import { yir } from '../yir.js'

const ROOT = resolve(import.meta.dir, '../..')
const output = process.argv[2]
if (!output) throw new Error('用法：bun src/m0/style-ref.ts <输出文件，不带扩展名>')
const SUBJECT = '山谷里一座依山而建的古旧石殿前庭，从前景到远景层层展开。前景是一段青灰色石阶，石阶边缘磨圆，石缝里长着少量苔藓，画面右侧的石阶旁立着一只半人高的青铜香炉，炉身带铜绿。中景是石殿的木构门廊，四根朱红色木柱，柱漆局部剥落，门廊上方的横梁是素面木梁，檐下挂着两幅深青色布幔，下摆被风吹起。殿前空地铺着浅灰色石板，散落几片黄叶。远景是层叠的青灰色山峰和缓慢流动的云雾，一条瀑布从画面左侧的山崖落下。午后偏暖的阳光从画面左上方斜照进来，石阶和木柱受光，门廊里的阴影偏冷蓝色。'
/** 16:9 like the video frames; 1K medium was quoted 0.0071–0.0075 USD a picture (2026-10-27). */
const PARAMS = { resolution: '1K', quality: 'medium', n: 1, aspect_ratio: '16:9' }

const style = loadPlugins(join(ROOT, 'config/plugins')).plugins.get('style:3d-guoman')
if (!style) throw new Error('画风插件 3d-guoman 没有加载')
const settings = loadModels(join(ROOT, 'config/models.json')).image
if (!settings) throw new Error('config/models.json 里没有 image')
const prompt = imagePrompt(ROOT, style, 'location', SUBJECT)
const result = await yir(settings).generate(`style-ref-${Date.now()}`, prompt, PARAMS)
const file = `${resolve(output)}.${result.ext}`
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, result.bytes)
writeFileSync(`${resolve(output)}.json`, JSON.stringify({ prompt, params: PARAMS, quotedUsd: result.quotedUsd, providerJob: result.providerJob }, null, 2))
console.log(`✓ ${file}（报价 ${result.quotedUsd} 美元）`)
