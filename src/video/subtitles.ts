/**
 * Subtitles (design 08 四): the script's words, timed by speech recognition. Only the
 * recogniser's times are used; its text only lines the script up (an LCS over characters).
 */
import type { Word } from './media.js'

export type Cue = { text: string; start: number; end: number; measured: boolean }

const PUNCT = /[\s，。、；：！？!?,.;:「」『』“”‘’（）()《》…—-]/g
const bare = (s: string) => s.replace(PUNCT, '')

/** Design 08 四 1: verbatim, the closing full stop or comma dropped, a question or exclamation mark kept. */
export const shown = (text: string) => text.trim().replace(/[。，、；：…—\s]+$/u, '')

/** Each recognised character with the time it was spoken, spread evenly over its token. */
function characters(words: Word[]): { ch: string; start: number; end: number }[] {
  return words.flatMap(w => {
    const chars = [...bare(w.text)]
    const step = (w.end - w.start) / Math.max(1, chars.length)
    return chars.map((ch, i) => ({ ch, start: w.start + i * step, end: w.start + (i + 1) * step }))
  })
}

/** Longest common subsequence of a and b: for each index of a, the matched index of b or -1. */
export function lcs(a: string[], b: string[]): number[] {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const match = new Array<number>(n).fill(-1)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) match[i++] = j++
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  return match
}

/**
 * Times every planned line from the recognised speech. A line counts as found when at least
 * half its characters match in order (a guess: homophones and dropped particles lose a few);
 * otherwise it keeps its planned time and `measured` is false, flagged at ★8.
 */
export function align(planned: { text: string; start: number; end: number }[], words: Word[]): Cue[] {
  const heard = characters(words)
  const script = planned.flatMap((line, k) => [...bare(line.text)].map(ch => ({ ch, k })))
  const match = lcs(script.map(s => s.ch), heard.map(h => h.ch))
  return planned.map((line, k) => {
    const hits = script.map((s, i) => (s.k === k ? match[i]! : -2)).filter(j => j !== -2)
    const found = hits.filter(j => j >= 0)
    if (!hits.length || found.length * 2 < hits.length) return { text: shown(line.text), start: line.start, end: line.end, measured: false }
    return { text: shown(line.text), start: heard[found[0]!]!.start, end: heard[found.at(-1)!]!.end, measured: true }
  })
}

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100))
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** An ASS file burning white text with a dark outline, bottom-centre, a tenth of the height up (design 08 四 4). */
export function ass(cues: Cue[], width: number, height: number, font: string): string {
  const size = Math.round(height * 0.055)
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size / 14))},0,2,40,40,${Math.round(height * 0.1)},1`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map(c => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${c.text.replace(/\n/g, '\\N')}`),
    '',
  ].join('\n')
}
