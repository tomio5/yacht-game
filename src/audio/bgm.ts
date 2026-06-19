/**
 * bgm.ts — BGM 専用マネージャ（SE 系統＝衝突音とは別系統・独立音量）
 *
 * - playDefault(): healing15 をループ再生（再生中なら no-op）。
 * - playGrace():   流れている BGM をぶつ切り停止 → 1秒無音 → Amazing Grace をループ。
 *                  既に Grace が流れていても「停止→無音→再開」する（光の柱の上書き演出用）。
 * - stopAll():     停止（リセットアクション専用）。
 * - resumeBgm():   autoplay 制約のため、初回ユーザー操作で呼ぶ（resume＋保留中の再生開始）。
 *
 * 同時に1曲のみ。フェードは入れない（ぶつ切り＋無音、で固定）。
 */

const DEFAULT_URL = '/sounds/maou_bgm_healing15.wav'
// TODO: amazing_grace の音源は未配置（光の柱の指示書で配置・発火）。未配置時は無音のまま state だけ進む。
const GRACE_URL   = '/sounds/Amazing Grace.wav'

const BGM_BASE      = 0.020  // BGM ベース音量（実機調整可。これに masterVol を掛ける）
const GRACE_MULT    = 25.0  // Amazing Grace 再生時の音量倍率
const GRACE_SILENCE = 1.0   // Grace 切替時の無音区間（秒・実機調整可）

let ctx: AudioContext | null = null
let gain: GainNode | null = null
let masterVol = 0.8         // 音量スライダー連動（audio.ts の setMasterVolume から更新）
let current: AudioBufferSourceNode | null = null
let currentUrl: string | null = null
let pendingDefault = false
const cache = new Map<string, AudioBuffer | null>()

function ensure(): AudioContext | null {
  if (!ctx) {
    try {
      const Ctor = window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctx = new Ctor()
      gain = ctx.createGain()
      gain.gain.value = BGM_BASE * masterVol
      gain.connect(ctx.destination)
    } catch { return null }
  }
  return ctx
}

async function load(url: string): Promise<AudioBuffer | null> {
  if (cache.has(url)) return cache.get(url)!
  const c = ensure(); if (!c) return null
  try {
    const res = await fetch(url)
    const arr = await res.arrayBuffer()
    const buf = await c.decodeAudioData(arr)
    cache.set(url, buf)
    return buf
  } catch {
    cache.set(url, null)   // 失敗を記録（毎回 fetch しない）
    return null
  }
}

function stopCurrent(): void {
  if (current) { try { current.stop() } catch { /* already stopped */ } current = null }
  currentUrl = null
}

async function startLoop(url: string, delay: number): Promise<void> {
  const c = ensure(); if (!c || !gain) return
  const buf = await load(url)
  stopCurrent()
  if (!buf) return   // 音源未配置などは無音（state だけ進む）
  const src = c.createBufferSource()
  src.buffer = buf
  src.loop = true
  src.connect(gain)
  src.start(c.currentTime + Math.max(0, delay))
  current = src
  currentUrl = url
}

/** healing15 をループ。再生中なら no-op。ctx 未 running 時は resume してから開始。 */
export function playDefault(): void {
  const c = ensure(); if (!c) return
  if (gain) gain.gain.value = BGM_BASE * masterVol   // Grace 後に通常音量へ戻す
  if (currentUrl === DEFAULT_URL && current) return   // 再生中 → no-op
  if (c.state !== 'running') {
    pendingDefault = true
    void c.resume().then(() => { if (pendingDefault) { pendingDefault = false; void startLoop(DEFAULT_URL, 0) } })
    return
  }
  void startLoop(DEFAULT_URL, 0)
}

/** ぶつ切り → 1秒無音 → Amazing Grace ループ（既に Grace でも停止→無音→再開）。 */
export function playGrace(): void {
  const c = ensure(); if (!c) return
  if (gain) gain.gain.value = BGM_BASE * GRACE_MULT * masterVol   // Grace は5倍音量
  stopCurrent()                       // ぶつ切り
  void startLoop(GRACE_URL, GRACE_SILENCE)
}

/** BGM 停止（リセットアクション専用）。 */
export function stopAll(): void {
  stopCurrent()
  pendingDefault = false
}

/** 音量スライダー連動（0〜1）。audio.ts の setMasterVolume から呼ばれる。 */
export function setMasterVolume(v: number): void {
  masterVol = Math.max(0, Math.min(1, v))
  if (gain) gain.gain.value = BGM_BASE * masterVol
}

/** 初回ユーザー操作で呼ぶ。resume 後、保留中の default を開始。 */
export function resumeBgm(): void {
  const c = ensure(); if (!c) return
  void c.resume().then(() => {
    if (pendingDefault) { pendingDefault = false; playDefault() }
  })
}
