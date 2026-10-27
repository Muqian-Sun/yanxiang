import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { yir } from '../src/yir.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Yir as far as submit goes; counts how often a reference is registered and put. */
function fakeYir() {
  const count = { files: 0, puts: 0 }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.endsWith('/v1/models?include=parameters')) return json({ models: [{ id: 'm', operations: [{ operation: 'generate_image', parameters: [{ name: 'n', values: [1] }], input_constraints: { image: { max_references: 16 } } }] }] })
    if (url.endsWith('/v1/files') && init?.method === 'POST') {
      count.files++
      await new Promise(resolve => setTimeout(resolve, 20))
      return json({ files: [{ id: 'f1', status: 'pending_upload', upload: { parts: [{ part_number: 1, size: 3, url: 'https://storage/put' }] } }] })
    }
    if (url === 'https://storage/put') {
      count.puts++
      return new Response('', { status: 200 })
    }
    if (url.endsWith('/complete')) return json({})
    if (url.endsWith('/v1/files/f1')) return json({ status: 'ready' })
    if (url.endsWith('/v1/images/quotes')) return json({ supply: { available: true }, expected_amount: '0.008' })
    if (url.endsWith('/v1/images/generations')) return json({ id: `job-${Math.random()}` })
    throw new Error(`unexpected ${url}`)
  }) as typeof fetch
  return count
}

test('two submits with the same reference at once upload it once', async () => {
  const count = fakeYir()
  process.env.YX_TEST_KEY = 'k'
  const client = yir({ baseUrl: 'https://yir.test', model: 'm', keyEnv: 'YX_TEST_KEY', maxCostUsd: '0.10' })
  const ref = join(mkdtempSync(join(tmpdir(), 'yx-yir-')), 'portrait.png')
  writeFileSync(ref, 'png')
  await Promise.all([client.submit('a', '三视图', { n: 1 }, [ref]), client.submit('b', '脸部特写', { n: 1 }, [ref])])
  expect(count).toEqual({ files: 1, puts: 1 })
})

test('a parameter the contract does not declare is refused before anything is paid', async () => {
  fakeYir()
  process.env.YX_TEST_KEY = 'k'
  const client = yir({ baseUrl: 'https://yir.test', model: 'm', keyEnv: 'YX_TEST_KEY', maxCostUsd: '0.10' })
  await expect(client.submit('a', '图', { n: 1, aspect_ratio: '16:9' })).rejects.toThrow('aspect_ratio')
})

test('a request that hangs fails with a reason instead of stalling the job', async () => {
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch
  process.env.YX_TEST_KEY = 'k'
  const client = yir({ baseUrl: 'https://yir.test', model: 'm', keyEnv: 'YX_TEST_KEY', maxCostUsd: '0.10' }, { api: 30 })
  await expect(client.submit('a', '图', { n: 1 })).rejects.toThrow('没有响应')
}, 2000)
