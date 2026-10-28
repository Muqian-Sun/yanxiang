import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReviewClosed, Store } from '../src/store/store.js'

function fresh(): Store {
  const store = new Store(mkdtempSync(join(tmpdir(), 'yx-store-')))
  store.createProject({ name: '样片', entry: 'script', style: '3d-guoman', genre: 'xianxia', seconds_min: 45, seconds_max: 60, delivery: '1080p' })
  return store
}

const add = (s: Store, kind: string, scope: string, inputs: number[] = [], status: 'draft' | 'locked' = 'locked') =>
  s.addArtifact({ kind, scope, payload: { kind, scope }, inputs, status, created_by: 'program' }).id

test('a second artifact in the same scope is the next version, and the first is untouched', () => {
  const s = fresh()
  const v1 = add(s, 'entity_brief', 'e1/char/谢无咎', [], 'draft')
  const v2 = add(s, 'entity_brief', 'e1/char/谢无咎', [], 'draft')
  expect([s.artifact(v1).version, s.artifact(v2).version]).toEqual([1, 2])
  expect(s.artifact(v1).payload).toEqual({ kind: 'entity_brief', scope: 'e1/char/谢无咎' })
})

test('inputs become edges and an order-independent digest', () => {
  const s = fresh()
  const a = add(s, 'script', 'e1')
  const b = add(s, 'roster', 'e1')
  const x = add(s, 'entity_brief', 'e1/char/甲', [b, a])
  const y = add(s, 'entity_brief', 'e1/char/乙', [a, b])
  expect(s.inputsOf(x)).toEqual([a, b])
  expect(s.artifact(x).input_digest).toBe(s.artifact(y).input_digest)
})

test('locking a new version supersedes the old one and stales only what was built on it', () => {
  const s = fresh()
  const brief1 = add(s, 'entity_brief', 'e1/char/谢无咎')
  const desc = add(s, 'entity_desc', 'e1/char/谢无咎', [brief1])
  const image = add(s, 'entity_image', 'e1/char/谢无咎', [desc], 'draft')
  const keyframe = add(s, 'keyframe', 'e1/s1/c1', [image])
  const other = add(s, 'entity_desc', 'e1/char/柳含烟')
  const brief2 = add(s, 'entity_brief', 'e1/char/谢无咎', [], 'draft')
  const review = s.openReview(5, 'e1/char/谢无咎', [image])
  expect(s.lock(brief2).sort()).toEqual([desc, image, keyframe].sort())
  expect(s.artifact(brief1).status).toBe('superseded')
  expect(s.artifact(brief2).status).toBe('locked')
  expect(s.artifact(other).status).toBe('locked')
  expect(s.review(review).status).toBe('closed')
})

test('a diamond downstream is visited once', () => {
  const s = fresh()
  const root = add(s, 'script', 'e1')
  const left = add(s, 'timeline', 'e1/s1', [root])
  const right = add(s, 'timeline', 'e1/s2', [root])
  const join_ = add(s, 'cut_draft', 'e1', [left, right])
  expect(s.invalidate(root).sort()).toEqual([left, right, join_].sort())
})

test('an artifact built from a stale input is stale on arrival', () => {
  const s = fresh()
  const brief1 = add(s, 'entity_brief', 'e1/char/甲')
  const desc = add(s, 'entity_desc', 'e1/char/甲', [brief1])
  s.lock(add(s, 'entity_brief', 'e1/char/甲', [], 'draft'))
  expect(s.artifact(desc).status).toBe('stale')
  expect(s.artifact(add(s, 'entity_image', 'e1/char/甲', [desc], 'draft')).status).toBe('stale')
})

test('only one of two windows can decide a review', () => {
  const s = fresh()
  const review = s.openReview(3, 'e1', [add(s, 'script', 'e1', [], 'draft')])
  s.decide(review, { action: 'approve' })
  expect(() => s.decide(review, { action: 'approve' })).toThrow(ReviewClosed)
})

test('a decision that fails leaves the review open', () => {
  const s = fresh()
  const review = s.openReview(3, 'e1', [])
  expect(() => s.decide(review, { action: 'approve' }, () => { throw new Error('boom') })).toThrow('boom')
  expect(s.review(review).status).toBe('open')
})

test('the same bytes are stored once', () => {
  const s = fresh()
  const bytes = new TextEncoder().encode('png bytes')
  const a = s.putMedia(bytes, 'image/png')
  expect(s.putMedia(bytes, 'image/png')).toBe(a)
  expect(readFileSync(s.mediaPath(a), 'utf8')).toBe('png bytes')
})

test('a permit covers its scope and below, and runs out', () => {
  const s = fresh()
  s.grant('e1/char', 'image', 2)
  expect(s.usePermit('e1/loc/封剑洞', 'image')).toBe(false)
  expect(s.usePermit('e1/char/谢无咎', 'image')).toBe(true)
  expect(s.usePermit('e1/char/柳含烟', 'image')).toBe(true)
  expect(s.usePermit('e1/char/诛魔左卫', 'image')).toBe(false)
  expect(s.usePermit('e1/char/谢无咎', 'video')).toBe(false)
})

test('reopening a project keeps its data and does not migrate twice', () => {
  const s = fresh()
  const id = add(s, 'script', 'e1')
  s.close()
  const again = new Store(s.dir)
  expect(again.artifact(id).kind).toBe('script')
})

test('a write waits for another process holding the database instead of failing', async () => {
  const s = fresh()
  const flag = join(s.dir, 'holding')
  const child = Bun.spawn(['bun', '-e', `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(${JSON.stringify(join(s.dir, 'project.db'))})
    db.exec('BEGIN IMMEDIATE')
    require('node:fs').writeFileSync(${JSON.stringify(flag)}, '1')
    Bun.sleepSync(800)
    db.exec('COMMIT')
  `])
  while (!(await Bun.file(flag).exists())) await Bun.sleep(20)
  expect(() => s.grant('e1', 'image', 1)).not.toThrow()
  await child.exited
  expect(s.permitsLeft('e1', 'image')).toBe(1)
})
