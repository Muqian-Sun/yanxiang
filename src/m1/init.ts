/**
 * M1: create a sample project from a script the creator has approved. The script, roster and
 * episode setup are the creator's, so they go in locked (created_by user).
 * Usage: bun src/m1/init.ts <script.json> <项目目录> [本集设定.txt]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createProject } from './storyflow.js'

const [scriptPath, dir, setupPath] = process.argv.slice(2)
if (!scriptPath || !dir) throw new Error('用法：bun src/m1/init.ts <script.json> <项目目录> [本集设定.txt]')
createProject(resolve(dir), JSON.parse(readFileSync(scriptPath, 'utf8')), setupPath ? readFileSync(setupPath, 'utf8').trim() : undefined)
console.log(`✓ 项目建在 ${resolve(dir)}`)
