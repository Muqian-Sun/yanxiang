import { join } from 'node:path'
import type { ModelsConfig } from '../llm.js'
import type { Plugin } from '../plugins.js'
import { runTask, TaskFailed, type Attempt } from '../runner.js'
import type { Store } from '../store/store.js'
import type { TextRunner } from './engine.js'

/** Task cards run through runTask; every attempt, passed or sent back, is kept as an llm_call (design 05). */
export function textRunner(store: Store, root: string, plugins: { style: Plugin; genre: Plugin }, models: ModelsConfig): TextRunner {
  return async ({ card, sections, data, tag, nodeRunId }) => {
    const record = (attempts: Attempt[], system: string, user: string, version: string, model: string) =>
      attempts.forEach(a => store.addLlmCall({ node_run_id: nodeRunId, task: card.name, model, prompt_version: version, system_text: system, user_text: user, response_text: a.response, tokens_in: a.tokensIn, tokens_out: a.tokensOut, ms: a.ms, ok: !a.problems.length, error: a.problems.join('；') || undefined }))
    try {
      const result = await runTask({ root, card, sections, data, plugins, models, logDir: join(store.dir, 'logs'), tag })
      record(result.attempts, result.system, result.user, result.promptVersion, result.model)
      return result
    } catch (error) {
      if (error instanceof TaskFailed) record(error.attempts, error.call.system, error.call.user, error.call.promptVersion, error.call.model)
      throw error
    }
  }
}
