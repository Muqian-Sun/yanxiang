import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FPS } from './workflow.js'

/** Every clip and cut is re-encoded to this (design 08 三). */
const AUDIO_RATE = 48000

export class MediaError extends Error {}

/** Runs a command without blocking the process: the engine keeps ticking and the page keeps answering while ffmpeg works. */
export async function run(cmd: string[]): Promise<{ stdout: string; stderr: string }> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  } catch (error) {
    throw new MediaError(`${cmd[0]} 跑不起来：${error instanceof Error ? error.message : String(error)}`)
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited])
  if (code !== 0) throw new MediaError(`${cmd[0]} 失败：${stderr.slice(-1200)}`)
  return { stdout, stderr }
}

export type Probe = { duration: number; width: number; height: number; fps: number; hasAudio: boolean; vcodec: string; acodec: string | null; tags: Record<string, string> }

export async function probe(path: string): Promise<Probe> {
  const data = JSON.parse((await run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])).stdout)
  const video = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'video')
  const audio = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio')
  if (!video) throw new MediaError(`${path} 没有画面`)
  const [n, d] = String(video.r_frame_rate ?? '0/1').split('/').map(Number)
  return {
    duration: Number(data.format?.duration ?? video.duration ?? 0),
    width: video.width, height: video.height, fps: d ? n! / d : 0,
    hasAudio: Boolean(audio), vcodec: video.codec_name, acodec: audio?.codec_name ?? null,
    tags: data.format?.tags ?? {},
  }
}

const ENCODE = ['-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '256k', '-ar', String(AUDIO_RATE), '-ac', '2']

/**
 * The `frames` frames (with their sound) just before `outSeconds`: the guide clip for the
 * next segment (design 07). H3 crops a guide clip to 17k+5 frames, so `frames` must be on that grid.
 */
export async function tail(source: string, outSeconds: number, frames: number, dest: string) {
  if (frames < 5 || frames % 17 !== 5) throw new MediaError(`引导片段的帧数要在 17k+5 上（5、22、39……），现在是 ${frames}`)
  const end = Math.round(outSeconds * FPS)
  const start = end - frames
  if (start < 0) throw new MediaError(`出点 ${outSeconds} 秒之前不够 ${frames} 帧`)
  if (!(await probe(source)).hasAudio) throw new MediaError(`${source} 没有声音，接不上下一段`)
  await run(['ffmpeg', '-v', 'error', '-y', '-i', source,
    '-vf', `select=gte(n\\,${start})*lt(n\\,${end}),setpts=PTS-STARTPTS`,
    '-af', `atrim=start=${(start / FPS).toFixed(6)}:end=${(end / FPS).toFixed(6)},asetpts=PTS-STARTPTS`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', dest])
}

/** One small PNG per time, for the vision model; returns the paths in order. */
export async function stills(source: string, times: number[], dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true })
  const out: string[] = []
  for (const [i, t] of times.entries()) {
    const file = join(dir, `${String(i).padStart(3, '0')}-${t.toFixed(2)}.png`)
    await run(['ffmpeg', '-v', 'error', '-y', '-ss', t.toFixed(3), '-i', source, '-frames:v', '1', '-vf', 'scale=512:-2', file])
    out.push(file)
  }
  return out
}

/** The clip from `from` to `to`, re-encoded to the common format (design 08 三). */
export async function cut(source: string, from: number, to: number, dest: string) {
  await run(['ffmpeg', '-v', 'error', '-y', '-ss', from.toFixed(3), '-to', to.toFixed(3), '-i', source, ...ENCODE, dest])
}

/** Joins clips of the same format end to end with the concat filter, sound included. */
export async function concat(paths: string[], dest: string) {
  const inputs = paths.flatMap(p => ['-i', p])
  const streams = paths.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('')
  await run(['ffmpeg', '-v', 'error', '-y', ...inputs, '-filter_complex', `${streams}concat=n=${paths.length}:v=1:a=1[v][a]`, '-map', '[v]', '-map', '[a]', ...ENCODE, dest])
}

/** A 2–15 second mono WAV of one stretch of a clip, for H3's reference audio; near silence is refused. */
export async function voiceSample(source: string, from: number, seconds: number, dest: string) {
  if (seconds < 2 || seconds > 15) throw new MediaError(`音色样本要 2–15 秒，现在是 ${seconds.toFixed(2)} 秒`)
  await run(['ffmpeg', '-v', 'error', '-y', '-ss', from.toFixed(3), '-t', seconds.toFixed(3), '-i', source, '-vn', '-map', '0:a:0', '-ac', '1', '-c:a', 'pcm_s16le', dest])
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec((await run(['ffmpeg', '-hide_banner', '-i', dest, '-af', 'volumedetect', '-f', 'null', '-'])).stderr)
  if (!mean) throw new MediaError('量不出音量')
  // A guess, from the old project's voice.py: below this a cut is room tone, not speech.
  if (mean[1] === '-inf' || Number(mean[1]) < -45) throw new MediaError(`截出来的音色几乎没有声音（平均 ${mean[1]} dB）`)
}

export const WHISPER_MODEL = join(homedir(), '.cache/whisper/ggml-large-v3-turbo-q5_0.bin')
export type Word = { text: string; start: number; end: number }

/** Mandarin speech with per-token times, from whisper.cpp; the text is only used to line the script up, never shown. */
export async function transcribe(source: string, dir: string): Promise<Word[]> {
  if (!existsSync(WHISPER_MODEL)) throw new MediaError(`没有 whisper 模型 ${WHISPER_MODEL}`)
  mkdirSync(dir, { recursive: true })
  const wav = join(dir, 'speech.wav')
  await run(['ffmpeg', '-v', 'error', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav])
  const base = join(dir, 'speech')
  // Whisper follows its prompt's script; without one it often answers in traditional characters (old project's asr.py).
  // Chinese has no spaces, so segments are whole sentences; the full JSON's tokens carry one time each.
  await run(['whisper-cli', '-m', WHISPER_MODEL, '-l', 'zh', '--prompt', '以下是普通话的句子，使用简体中文。', '-ojf', '-of', base, '-np', wav])
  const data = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as { transcription?: { tokens?: { text: string; offsets: { from: number; to: number } }[] }[] }
  return (data.transcription ?? []).flatMap(s => s.tokens ?? []).filter(t => !t.text.startsWith('[_')).map(t => ({ text: t.text.trim(), start: t.offsets.from / 1000, end: t.offsets.to / 1000 })).filter(w => w.text)
}

/** Integrated loudness, true peak and range, from ffmpeg's loudnorm first pass. */
export async function loudness(source: string): Promise<{ I: number; TP: number; LRA: number; thresh: number; offset: number }> {
  const { stderr } = await run(['ffmpeg', '-hide_banner', '-i', source, '-af', 'loudnorm=I=-15:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'])
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)
  const m = JSON.parse(json)
  return { I: Number(m.input_i), TP: Number(m.input_tp), LRA: Number(m.input_lra), thresh: Number(m.input_thresh), offset: Number(m.target_offset) }
}

/** Seconds of black and of silence longer than the given lengths (design 08 六). */
export async function gaps(source: string, blackMin: number, silenceMin: number): Promise<{ black: [number, number][]; silence: [number, number][] }> {
  const { stderr } = await run(['ffmpeg', '-hide_banner', '-i', source, '-vf', `blackdetect=d=${blackMin}:pix_th=0.10`, '-af', `silencedetect=noise=-50dB:d=${silenceMin}`, '-f', 'null', '-'])
  const black = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])] as [number, number])
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map(m => Number(m[1]))
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map(m => Number(m[1]))
  const end = (await probe(source)).duration
  return { black, silence: starts.map((s, i) => [s, ends[i] ?? end] as [number, number]) }
}

export const FONT = ['/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/STHeiti Medium.ttc'].find(existsSync)

export function writeText(path: string, text: string) {
  writeFileSync(path, text)
  return path
}
