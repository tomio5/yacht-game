/**
 * audio.ts — Web Audio API による簡易サウンド（すべて合成。音源ファイル不要・依存なし）
 *
 * - SE: ダイス投入/着地/キープ/記入/ボタン/勝利 などの効果音（合成）
 * - BGM: 穏やかなアルペジオのループ（合成）。デフォルトOFF
 * - autoplay 制限のため、初回のユーザー操作で resumeAudio() を呼ぶこと。
 * - 将来 本物の音源に差し替える場合もこの API（SE.* / setBGMEnabled）を維持すればよい。
 */

import { setMasterVolume as setBgmMasterVolume } from '../audio/bgm'

let ctx: AudioContext | null = null
let masterSE: GainNode | null = null
let masterBGM: GainNode | null = null
let seEnabled = true
let bgmEnabled = false
let bgmTimer: number | null = null
let bgmStep = 0
let masterVol = 0.8   // 0〜1（ユーザー音量）

const SE_BASE  = 0.5  // SE のベース音量
const BGM_BASE = 0.16 // BGM のベース音量

function applyVolume(): void {
  if (masterSE)  masterSE.gain.value  = SE_BASE  * masterVol
  if (masterBGM) masterBGM.gain.value = BGM_BASE * masterVol
}

function ensure(): AudioContext {
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new Ctor()
    masterSE = ctx.createGain()
    masterSE.connect(ctx.destination)
    masterBGM = ctx.createGain()
    masterBGM.connect(ctx.destination)
    applyVolume()
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/** 0〜1 のユーザー音量。SE/合成BGM＋ファイルBGM(bgm.ts) に反映 */
export function setMasterVolume(v: number): void {
  masterVol = Math.max(0, Math.min(1, v))
  applyVolume()
  setBgmMasterVolume(masterVol)   // ファイルBGM(healing15 等)もスライダーに連動
}
export function getMasterVolume(): number { return masterVol }

/** 初回ユーザー操作で呼ぶ（autoplay 解除＋ダイス衝突音／ファイルSE のプリロード） */
export function resumeAudio(): void {
  try { ensure() } catch { /* AudioContext 非対応環境は無視 */ }
  preloadDiceSounds()
  preloadFileSE()
}

export function isSEEnabled():  boolean { return seEnabled }
export function isBGMEnabled(): boolean { return bgmEnabled }

export function setSEEnabled(v: boolean): void { seEnabled = v }

export function setBGMEnabled(v: boolean): void {
  bgmEnabled = v
  if (v) startBGM()
  else   stopBGM()
}

// ── 単発トーン ──────────────────────────────────────────
function tone(
  freq: number, dur: number,
  type: OscillatorType = 'sine', gain = 0.5, slideTo?: number,
): void {
  if (!seEnabled) return
  let c: AudioContext
  try { c = ensure() } catch { return }
  if (!masterSE) return
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, c.currentTime)
  if (slideTo !== undefined) o.frequency.linearRampToValueAtTime(slideTo, c.currentTime + dur)
  g.gain.setValueAtTime(0.0001, c.currentTime)
  g.gain.linearRampToValueAtTime(gain, c.currentTime + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur)
  o.connect(g); g.connect(masterSE)
  o.start()
  o.stop(c.currentTime + dur + 0.02)
}

// ── ノイズ（ダイス転がり/投入） ───────────────────────────
function noise(dur: number, gain = 0.4, freq = 1200): void {
  if (!seEnabled) return
  let c: AudioContext
  try { c = ensure() } catch { return }
  if (!masterSE) return
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const src = c.createBufferSource()
  src.buffer = buf
  const filt = c.createBiquadFilter()
  filt.type = 'bandpass'
  filt.frequency.value = freq
  const g = c.createGain()
  g.gain.setValueAtTime(gain, c.currentTime)
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur)
  src.connect(filt); filt.connect(g); g.connect(masterSE)
  src.start()
  src.stop(c.currentTime + dur)
}

// ── 効果音 ──────────────────────────────────────────────
export const SE = {
  /** カップを振る/投入（ザラッとした転がり音） */
  roll:   () => noise(0.55, 0.5, 1100),
  /** 着地（コトッ） */
  land:   () => tone(190, 0.12, 'sine', 0.5, 95),
  /** キープ（上向きクリック） */
  keep:   () => tone(680, 0.07, 'triangle', 0.4),
  /** キープ解除（下向きクリック） */
  unkeep: () => tone(430, 0.07, 'triangle', 0.35),
  /** スコア記入（ポジティブな2音） */
  record: () => { tone(523, 0.12, 'sine', 0.4); window.setTimeout(() => tone(784, 0.16, 'sine', 0.4), 90) },
  /** ボタン押下 */
  button: () => tone(520, 0.05, 'square', 0.22),
  /** 勝利ファンファーレ */
  win:    () => [523, 659, 784, 1047].forEach((f, i) => window.setTimeout(() => tone(f, 0.28, 'sine', 0.4), i * 130)),
}

// ── BGM（穏やかなアルペジオのループ。合成） ────────────────
// Cメジャー系のゆったりした循環。1ステップ=1音。
const BGM_NOTES = [
  261.63, 329.63, 392.0, 523.25, 392.0, 329.63,   // C E G C G E
  293.66, 349.23, 440.0, 587.33, 440.0, 349.23,   // D F A D A F
  220.0,  261.63, 329.63, 440.0, 329.63, 261.63,   // A C E A E C
  392.0,  493.88, 587.33, 392.0, 293.66, 261.63,   // G B D ... 着地
]

function startBGM(): void {
  try { ensure() } catch { return }
  stopBGM()
  bgmStep = 0
  bgmTimer = window.setInterval(() => {
    if (!bgmEnabled || !masterBGM || !ctx) return
    const f = BGM_NOTES[bgmStep % BGM_NOTES.length]
    bgmStep++
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'triangle'
    o.frequency.value = f
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.04)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.42)
    o.connect(g); g.connect(masterBGM)
    o.start()
    o.stop(ctx.currentTime + 0.45)
  }, 300)
}

function stopBGM(): void {
  if (bgmTimer !== null) {
    window.clearInterval(bgmTimer)
    bgmTimer = null
  }
}

// ── ダイス衝突音（本物の音源。フィールド＋カップ内で共用） ────────
// 着地音(land) / ダイス同士(clack)。各候補は label 付き。デバッグで個別ON/OFF・試聴できる。
export type DiceHitKind = 'land' | 'clack'
interface SoundEntry { url: string; label: string; buf: AudioBuffer | null; on: boolean }

// 新規追加の wav（clack_2〜11）は着地・ダイス同士の両方で試せるよう両方に入れる
const WAV_EXTRA = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(n => ({ url: `/sounds/dice_clack_${n}.wav`, label: `w${n}` }))

function buildEntries(basePrefix: string, onLabels: string[]): SoundEntry[] {
  const base = [1, 2, 3, 4, 5].map(n => ({ url: `/sounds/${basePrefix}_${n}.mp3`, label: String(n) }))
  return [...base, ...WAV_EXTRA].map(e => ({ ...e, buf: null, on: onLabels.includes(e.label) }))
}

// 採用: 着地=w6,w7 / ダイス同士=w9,w10（デバッグパネルで変更可）
const sounds: Record<DiceHitKind, SoundEntry[]> = {
  land:  buildEntries('dice_land',  ['w6', 'w7']),
  clack: buildEntries('dice_clack', ['w9', 'w10']),
}
let dicePreloaded = false

async function loadBuf(c: AudioContext, url: string): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url)
    const arr = await res.arrayBuffer()
    return await c.decodeAudioData(arr)
  } catch { return null }
}

/** ダイス衝突音を全プリロード（初回再生のラグ防止）。多重呼び出し安全 */
export function preloadDiceSounds(): void {
  if (dicePreloaded) return
  dicePreloaded = true
  let c: AudioContext
  try { c = ensure() } catch { return }
  for (const kind of ['land', 'clack'] as DiceHitKind[]) {
    sounds[kind].forEach(e => { void loadBuf(c, e.url).then(b => { e.buf = b }) })
  }
}

// デバッグ: 使用する番号の ON/OFF・ラベル取得
export function setDiceSoundEnabled(kind: DiceHitKind, index: number, on: boolean): void {
  const arr = sounds[kind]
  if (index >= 0 && index < arr.length) arr[index].on = on
}
export function getDiceSoundEnabled(kind: DiceHitKind): boolean[] {
  return sounds[kind].map(e => e.on)
}
export function getDiceSoundLabels(kind: DiceHitKind): string[] {
  return sounds[kind].map(e => e.label)
}

// 1音を実際に鳴らす共通処理（masterSE 経由＝音量スライダー反映）
function playBuffer(buf: AudioBuffer, intensity: number): void {
  let c: AudioContext
  try { c = ensure() } catch { return }
  if (!masterSE) return
  const src = c.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.10        // ピッチ ±5%
  const g = c.createGain()
  g.gain.value = Math.max(0.05, Math.min(1, intensity)) * (0.85 + Math.random() * 0.30)  // ±15%
  src.connect(g)
  g.connect(masterSE)
  src.start()
}

/** 衝突音を再生。ON かつ読込済みの候補からランダムに1つ。 */
export function playDiceHit(kind: DiceHitKind, intensity = 0.6): void {
  if (!seEnabled) return
  const arr = sounds[kind]
  const candidates = arr.filter(e => e.buf && e.on)
  if (candidates.length === 0) return
  const e = candidates[Math.floor(Math.random() * candidates.length)]
  if (e.buf) playBuffer(e.buf, intensity)
}

/** デバッグ試聴: 指定番号を鳴らす（SEトグルに関係なく鳴らす） */
export function playDiceSoundByIndex(kind: DiceHitKind, index: number): void {
  const e = sounds[kind][index]
  if (e?.buf) playBuffer(e.buf, 0.8)
}

// ── 単発ファイルSE（雷/ジャンプ/信頼度演出）。SE系統(masterSE)で再生＝SE音量に追従 ──
// ※衝突音とは別の音源だが、同じ作法（クールダウン無し・単発）。BGM とは別系統。
export const THUNDER_A1_SE_VOL = 1.0   // 雷A1 着弾音（実機調整可）
export const THUNDER_V2_SE_VOL = 1.0   // 雷v2 着弾音（実機調整可）
export const FLIP_SE_VOL       = 1.0   // フリップ跳ね上げ音（将来：フリップ高さ=期待値で高さに比例させる）
export const CONFIDENCE_SE_VOL = 1.0   // 30点以上 信頼度演出音（実機調整可）

export const FIRE_SE_VOL    = 1.0   // 炎 cover 各段階の音量（実機調整可）
export const ZANGEKI_SE_VOL = 1.0   // 斬撃エフェクト音量（実機調整可）
const FILE_SE_URLS = [
  '/sounds/thunder2.mp3', '/sounds/thunder4.mp3', '/sounds/jump.wav',
  '/sounds/gako.wav', '/sounds/gakokyuin.wav',
  '/sounds/fire1.mp3', '/sounds/fire2.mp3', '/sounds/fire3.mp3',
  '/sounds/zangeki.wav',
]
const fileSEBuf: Record<string, AudioBuffer | null | undefined> = {}

function preloadFileSE(): void {
  let c: AudioContext
  try { c = ensure() } catch { return }
  for (const url of FILE_SE_URLS) {
    if (fileSEBuf[url] !== undefined) continue
    fileSEBuf[url] = null
    void loadBuf(c, url).then(b => { fileSEBuf[url] = b })
  }
}

/** ファイルSEを1発再生（masterSE 経由）。未ロードなら遅延ロードして鳴らす。 */
export function playFileSE(url: string, vol = 1): void {
  if (!seEnabled) return
  const buf = fileSEBuf[url]
  if (buf) { playBuffer(buf, vol); return }
  let c: AudioContext
  try { c = ensure() } catch { return }
  void loadBuf(c, url).then(b => { fileSEBuf[url] = b; if (b && seEnabled) playBuffer(b, vol) })
}

// 名前付きヘルパ（演出側から呼ぶ）
export const playThunderA1SE = () => playFileSE('/sounds/thunder2.mp3', THUNDER_A1_SE_VOL)
export const playThunderV2SE = () => playFileSE('/sounds/thunder4.mp3', THUNDER_V2_SE_VOL)
export const playFlipSE      = () => playFileSE('/sounds/jump.wav',     FLIP_SE_VOL)
/** 炎 cover の段階SE（1=発生 / 2=拡大 / 3=消滅） */
export const playFireSE = (phase: 1 | 2 | 3) =>
  playFileSE(`/sounds/fire${phase}.mp3`, FIRE_SE_VOL)
export const playZangekiSE = () => playFileSE('/sounds/zangeki.wav', ZANGEKI_SE_VOL)
/** 30点以上 確定時の信頼度演出音。鳴らすか・どちらの音か（gako/gakokyuin）は呼び出し側で決定する
 *  （ネット対戦では host が決めて両側で同じ音を鳴らすため。乱数をここに置くと左右でズレる）。 */
export const playConfidenceSE = (which: 'gako' | 'gakokyuin') =>
  playFileSE(`/sounds/${which}.wav`, CONFIDENCE_SE_VOL)

/** デバッグ試聴用: 任意のファイルSEを鳴らす（SEトグルに関係なく） */
export function playFileSEForce(url: string): void {
  const buf = fileSEBuf[url]
  if (buf) { playBuffer(buf, 0.9); return }
  let c: AudioContext
  try { c = ensure() } catch { return }
  void loadBuf(c, url).then(b => { fileSEBuf[url] = b; if (b) playBuffer(b, 0.9) })
}
