/**
 * effectTable.ts
 * staging 演出の「重み付き抽選テーブル」。getDisplayRank の役ランクで駆動する。
 *
 * 設計：
 *   役ランク（none〜max）→ エントリ配列。各エントリは
 *   { effectId（'none' or 登録済み演出ID）, variant, weight }。
 *   weight を正規化して 1 つ抽選する。
 *
 *   variant は既存 EffectMode の success / miss にそのまま対応：
 *     success = display→final を書き換える
 *     miss    = 書き換えない
 *   （cupHide の再生機構＝computeShowDice/showDice には触れない。ここは
 *    「どの演出を、どの variant で呼ぶか」を決めるだけ。）
 *
 *   将来 'thunder' 等を足すときは：
 *     stagingPlayers にレジストリ登録 ＋ EffectId に追加 ＋ 各 rank 行にエントリ追加。
 *
 * 固定ルール（数値を調整するときも必ず守る）：
 *   none 行の success 重みは必ず 0（揃い無し＝化けさせない＝素直のみ）。
 *
 * 現状はテーブルから cupHide を外しており、flip と none のみ。cupHide は「4キープ
 * 再振り限定」の独立抽選（drawIndependentCupHide）で発火する。xlsx 本番確率は後で差し替え。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 物理演出ポリシー（派手演出は物理を積極的に使う／ただし以下を契約とする）
 * ────────────────────────────────────────────────────────────────────────────
 * 1. 目は演出の最後に強制セット
 *    物理で出た目は採用しない。演出の終了時、対象ダイスに対して finalValue を
 *    強制的にセットする（既存の着地誘導の機構を流用する）。これにより、設計
 *    思想①「finalValue は先に確定、演出は見せ方」を物理演出でも維持する。
 *
 * 2. 物理ステップ中に body の add/remove をしない
 *    既存方針どおり。常設5個のダイスを使い回す。物理操作は beforeStep/afterStep
 *    で行う。違反は Rapier の recursive use フリーズを誘発する。
 *
 * 3. 動く kinematic と dynamic ダイスを衝突させない
 *    過去の爆発事故の機構（動くカップ×中ダイス）を繰り返さない。
 *    ・dynamic ダイスに impulse/torque をかけて吹き飛ばすのは可（壁・床との衝突は可）。
 *    ・演出物体（カップ、その他可動オブジェクト）と dynamic ダイスを物理的に
 *      当てない。どうしても重なる演出は、演出物体の collider を無効化する／
 *      ダイス側を kinematic にするなどで「物理衝突しない」を保証する。
 *
 * 4. 演出後の静止保証
 *    派手な物理演出のあとは、keep_select に渡す前に必ず「読める姿勢で静止」させる。
 *    ・既存の onSleep による settle 検出を一次の合図にする。
 *    ・それに加えて演出ごとに timeout を設定し、所定時間で静止しなければ
 *      force-restore する：dynamic→kinematic に切り替え、姿勢と位置を所定の
 *      集約位置／所定の姿勢に補間で戻し、上面が finalValue になるよう強制
 *      セットする。
 *    ・timeout は演出ごとの想定尺＋安全マージンで決める（雷など派手なものほど長めに）。
 *
 * 5. フェイズと演出の境界
 *    物理演出を再生中は操作不可フェイズに入れる（gathering / staging / 新フェイズ等）。
 *    演出が終わるまで keep_select / 入力フェイズに戻さない。
 *
 * 6. 既存安全パス（cupHide・flip）の不変
 *    cupHide（pre_gather_cover）と flip（staging）は物理シミュを使わない既存設計
 *    のまま。このポリシーは新規の物理演出と、今後の物理感強化に適用する。
 * ════════════════════════════════════════════════════════════════════════════
 */

import type { DisplayRank } from './types'

// 登録済み演出ID（stagingPlayers のキーと対応。'none' は演出なし）
export type EffectId = 'cupHide' | 'flip' | 'thunder' | 'thunder_v2' | 'fire' | 'slashB' | 'doubleFlip' | 'windmill'

// variant（書き換える / 書き換えない）。既存 EffectMode の success / miss に対応
export type EffectVariant = 'success' | 'miss'

// テーブルの 1 エントリ
export interface EffectTableEntry {
  effectId: EffectId | 'none'
  variant?: EffectVariant   // 'none' のときは不要
  weight:   number          // 整数。正規化して抽選
}

// 抽選結果
export interface EffectDraw {
  effectId: EffectId | 'none'
  variant?: EffectVariant
}

// 役ランク → エントリ配列（暫定値・合計100/行）
// flip は軽い・低信頼度で「なし以外」に広く薄く出す（弱にも出る＝ガセあり、信頼度<100%）。
// ※cupHide はテーブルから外し、「4キープ再振り限定」の独立抽選で発火する（drawIndependentCupHide）。
//   テーブルに cupHide を入れない代わりに、その分は none に戻している（none＝素直）。
export const EFFECT_TABLE: Record<DisplayRank, EffectTableEntry[]> = {
  none: [
    { effectId: 'none',                        weight: 100 },
    // ★none 行は「なし以外＝素直のみ」。success / flip / thunder は入れない。
    // slashB も none 行では出さない（化けのない役なし状態には不釣り合い）。
  ],
  weak: [
    { effectId: 'none',                        weight: 96 },
    { effectId: 'flip',    variant: 'success', weight:  2 },
    { effectId: 'slashB',  variant: 'success', weight:  2 },
  ],
  mid: [
    { effectId: 'none',       variant: undefined,  weight: 75 },
    { effectId: 'flip',       variant: 'success',  weight: 10 },
    { effectId: 'thunder',    variant: 'success',  weight:  6 },
    { effectId: 'fire',       variant: 'success',  weight:  3 },
    { effectId: 'fire',       variant: 'miss',     weight:  1 },
    { effectId: 'slashB',     variant: 'success',  weight:  2 },
    { effectId: 'doubleFlip', variant: 'success',  weight:  2 },
    { effectId: 'windmill',   variant: 'success',  weight:  1 },
  ],
  strong: [
    { effectId: 'none',       variant: undefined,  weight: 57 },
    { effectId: 'flip',       variant: 'success',  weight: 12 },
    { effectId: 'thunder',    variant: 'success',  weight: 11 },
    { effectId: 'fire',       variant: 'success',  weight:  6 },
    { effectId: 'fire',       variant: 'miss',     weight:  2 },
    { effectId: 'thunder_v2', variant: 'success',  weight:  4 },
    { effectId: 'slashB',     variant: 'success',  weight:  3 },
    { effectId: 'doubleFlip', variant: 'success',  weight:  3 },
    { effectId: 'windmill',   variant: 'success',  weight:  2 },
  ],
  max: [
    { effectId: 'none',       variant: undefined,  weight: 35 },
    { effectId: 'flip',       variant: 'success',  weight:  9 },
    { effectId: 'thunder',    variant: 'success',  weight: 14 },
    { effectId: 'fire',       variant: 'success',  weight:  8 },
    { effectId: 'fire',       variant: 'miss',     weight:  2 },
    { effectId: 'thunder_v2', variant: 'success',  weight: 22 },
    { effectId: 'slashB',     variant: 'success',  weight:  3 },
    { effectId: 'doubleFlip', variant: 'success',  weight:  4 },
    { effectId: 'windmill',   variant: 'success',  weight:  3 },
  ],
}

// ── cupHide 独立抽選 ──
// 「4キープ再振り（field=1, kept=4）」のときだけ呼ぶ。役ランクには依存しない
// （cupHide は「最終1個リーチ」という状況自体が見せ場なので rank で出し分けない設計）。
// 暫定値・後で xlsx の本番値に差し替える前提。合計100。
const CUPHIDE_PROB = { success: 20, miss: 8, none: 72 } as const
export function drawIndependentCupHide(rng: () => number = Math.random): EffectDraw {
  const total = CUPHIDE_PROB.success + CUPHIDE_PROB.miss + CUPHIDE_PROB.none
  let r = rng() * total
  if ((r -= CUPHIDE_PROB.success) < 0) return { effectId: 'cupHide', variant: 'success' }
  if ((r -= CUPHIDE_PROB.miss)    < 0) return { effectId: 'cupHide', variant: 'miss' }
  return { effectId: 'none' }
}

// ── B系統（投入演出）独立抽選 ──
// 投入時に役が確定していないため、ランクに依存しない固定確率で選ぶ。
// 全投入の少数に出現する「当たり感」として機能させる。
export type ThrowEffectId = 'none' | 'slowA' | 'slowB' | 'fake'
const THROW_PROB: { id: ThrowEffectId; weight: number }[] = [
  { id: 'none',  weight: 85 },
  { id: 'slowA', weight:  8 },
  { id: 'slowB', weight:  5 },
  { id: 'fake',  weight:  2 },
]
export function drawThrowEffect(rng: () => number = Math.random): ThrowEffectId {
  const total = THROW_PROB.reduce((s, e) => s + e.weight, 0)
  let r = rng() * total
  for (const e of THROW_PROB) {
    r -= e.weight
    if (r < 0) return e.id
  }
  return 'none'
}

/**
 * 役ランクの行から weight 正規化で 1 エントリを抽選する。
 * @param rank getDisplayRank の結果
 * @param rng  乱数源（テスト差し替え用。既定 Math.random）
 */
export function selectEffectFromTable(
  rank: DisplayRank,
  rng: () => number = Math.random,
  slashBBoost = 1.0,           // 化けるダイスあり時に slashB 重みを補正（呼び出し側から渡す）
): EffectDraw {
  const entries = slashBBoost !== 1.0
    ? EFFECT_TABLE[rank].map(e => e.effectId === 'slashB' ? { ...e, weight: e.weight * slashBBoost } : e)
    : EFFECT_TABLE[rank]
  const total = entries.reduce((s, e) => s + e.weight, 0)
  if (total <= 0) return { effectId: 'none' }

  let r = rng() * total
  for (const e of entries) {
    r -= e.weight
    if (r < 0) return { effectId: e.effectId, variant: e.variant }
  }
  // 丸め誤差の保険：最後のエントリを返す
  const last = entries[entries.length - 1]
  return { effectId: last.effectId, variant: last.variant }
}
