/**
 * M0: edit one picture with GPT Image, the picture itself as the only reference.
 * Usage: bun src/m0/edit.ts <原图> <输出文件，不带扩展名> "<只改哪里、改成什么>"
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { imagePrompt } from '../compose.js'
import { loadModels } from '../llm.js'
import { loadPlugins } from '../plugins.js'
import { yir } from '../yir.js'

const ROOT = resolve(import.meta.dir, '../..')
const [source, output, instruction] = process.argv.slice(2)
if (!source || !output || !instruction) throw new Error('用法：bun src/m0/edit.ts <原图> <输出文件，不带扩展名> "<只改哪里、改成什么>"')
/** 16:9 like the video frames, 1K medium. */
const PARAMS = { resolution: '1K', quality: 'medium', n: 1, aspect_ratio: '16:9' }

const style = loadPlugins(join(ROOT, 'config/plugins')).plugins.get('style:3d-guoman')
if (!style) throw new Error('画风插件 3d-guoman 没有加载')
const settings = loadModels(join(ROOT, 'config/models.json')).image
if (!settings) throw new Error('config/models.json 里没有 image')
const prompt = imagePrompt(ROOT, style, 'keyframe', instruction, ['要修改的原图'])
const result = await yir(settings).generate(`edit-${Date.now()}`, prompt, PARAMS, [resolve(source)])
const file = `${resolve(output)}.${result.ext}`
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, result.bytes)
writeFileSync(`${resolve(output)}.json`, JSON.stringify({ source, prompt, params: PARAMS, quotedUsd: result.quotedUsd, providerJob: result.providerJob }, null, 2))
console.log(`✓ ${file}（报价 ${result.quotedUsd} 美元）`)
