/**
 * showDice.ts
 * 見せ札（showValues）と カップ演出対象ダイス を計算する。
 *
 * 大前提：
 *   finalValues が先に確定し、それを元に演出を「後付け」する。
 *   スコア判定は常に finalValues で行い、showValues/演出は見せ方だけ。
 *
 * 見せ札の原則（揃い系）：
 *   success のときだけ、final の「その役を成立させている1個」を decoy 値に差し替えて
 *   1個違いのリーチを見せる。cover の最中にその1個を元の値へ戻す（swap）＝final に戻すだけ。
 *   ・final を別の出目に変えない（公正乱数の確定目を尊重）。swap は常に1個。
 *   ・決定役は scoring.getBestScoringRole に集約（getDisplayRank と必ず同じ役を見る）。
 */

import type { DieValue, EffectMode } from './types'
import { getBestScoringRole, getDisplayRank, rankIndex } from './scoring'
import type { DisplayRank, ScoringRole, RunDie } from './scoring'

export interface ShowDiceResult {
  showValues:  DieValue[]   // 最初にフィールドに見せる目
  cupIndices:  number[]     // カップが覆うダイスのインデックス（アニメ用）
  swapIndices: number[]     // finalValue へ差し替えるインデックス（成功時 = cupIndices、ハズレ = []）
}

const ALL_VALUES: DieValue[] = [1, 2, 3, 4, 5, 6]

/** v と異なる目を1つ返す（なるべく近い値を選んで自然に見せる。ヨット見せ札の従来踏襲用） */
function differentValue(v: DieValue): DieValue {
  return v === 6 ? (5 as DieValue) : ((v + 1) as DieValue)
}

/**
 * miss（＆未対応役 success）のカップ覆い対象。従来ロジックを温存：
 *   ヨット → index 4 を覆う / フォーダイス → 異なる1個を覆う / それ以外 → 覆わない（[]）。
 * miss は swap を起こさないので、これ自体が見え方を従来どおり保つ。
 */
function missCupIndices(finalValues: DieValue[]): number[] {
  const counts: Record<number, number> = { 1:0, 2:0, 3:0, 4:0, 5:0, 6:0 }
  for (const v of finalValues) counts[v]++

  if (Object.values(counts).some(c => c === 5)) return [4]   // ヨット

  const fourEntry = Object.entries(counts).find(([, c]) => c === 4)
  if (fourEntry) {
    const majority = Number(fourEntry[0]) as DieValue
    const oddIdx   = finalValues.findIndex(v => v !== majority)
    if (oddIdx !== -1) return [oddIdx]
  }
  return []
}

/**
 * targetIdx の目を、役ランクが「目標役より高くならない」decoy 値に差し替える候補を探す。
 *   ・avoid に含む値は使わない（揃いを汚さない／別の揃いを偶然作らない）。
 *   ・見せ札のランク <= 目標役ランク を満たす値だけ採用（リーチを上回らせない）。
 *   ・元の目に近い値を優先（自然に見せる）。
 * 条件を満たす値が無ければ null（＝この役では見せ札を作らない）。
 */
function chooseDecoy(
  finalValues: DieValue[],
  targetIdx:   number,
  targetRank:  DisplayRank,
  avoid:       Set<DieValue>,
): DieValue | null {
  const v  = finalValues[targetIdx]
  const ti = rankIndex(targetRank)
  const cands = ALL_VALUES
    .filter(d => d !== v && !avoid.has(d))
    .sort((a, b) => Math.abs(a - v) - Math.abs(b - v))
  for (const d of cands) {
    const show = finalValues.slice()
    show[targetIdx] = d
    if (rankIndex(getDisplayRank(show)) <= ti) return d
  }
  return null
}

// 端伸ばし/穴埋めの重み（穴＝run 内部 7 ／端＝両端 3）。この比率は固定。
const STRAIGHT_HOLE_WEIGHT = 0.7

/**
 * ストレート（S/B）の見せ札：run die を1個選んで「別の run 値」に decoy し、1マス欠けたリーチを見せる。
 *   ・選び方は重み付き：穴(内部)7 ／ 端(最小/最大値)3。片方が空なら他方。
 *   ・実際に「その目が消える」よう、final で count===1 の run die だけを decoy 候補にする
 *     （S.スト で free die が run 値を重複しているケースでも、欠けが見えるように）。
 *   ・free die は触れない（runDice に含まれないので自然に不変）。
 *   ・decoy 値は chooseDecoy のガード（≤目標ランク／偶然より強い役を作らない）を満たすもの。無ければ null。
 */
function getStraightDecoy(
  finalValues: DieValue[],
  runDice:     RunDie[],
  rank:        DisplayRank,
): { index: number; decoy: DieValue } | null {
  const counts: Record<number, number> = { 1:0, 2:0, 3:0, 4:0, 5:0, 6:0 }
  for (const v of finalValues) counts[v]++

  const runVals = runDice.map(d => d.value)
  const minV = Math.min(...runVals)
  const maxV = Math.max(...runVals)

  // その目が確実に欠ける（count===1）run die のみ decoy 対象にする
  const decoyable = runDice.filter(d => counts[d.value] === 1)
  const holes = decoyable.filter(d => d.value !== minV && d.value !== maxV)  // 内部
  const ends  = decoyable.filter(d => d.value === minV || d.value === maxV)  // 両端

  let pool = Math.random() < STRAIGHT_HOLE_WEIGHT ? holes : ends
  if (pool.length === 0) pool = pool === holes ? ends : holes   // 片方が空なら他方
  if (pool.length === 0) return null

  const chosen = pool[Math.floor(Math.random() * pool.length)]
  // decoy 候補は「自分以外の run 値」に限定（＝そのマスが欠けて重複が生まれるリーチ）
  const otherRun = runVals.filter(v => v !== chosen.value)
  const avoid = new Set<DieValue>(ALL_VALUES.filter(d => !otherRun.includes(d)))
  const decoy = chooseDecoy(finalValues, chosen.index, rank, avoid)
  return decoy === null ? null : { index: chosen.index, decoy }
}

/**
 * success のとき差し替える「1個」を決める。{ index, decoy } か、未対応役なら null。
 *   ・ヨット：従来どおり index 4 を differentValue で崩す（4個揃いのリーチ）。
 *   ・フォーダイス：揃いの目 n の1個を崩す（3個揃いのリーチ。ペア化を避けクリーンな triple に）。
 *   ・フルハウス：ペアの目 b の1個を崩す（3+1+1 のリーチ。トリプル側 a は崩さない）。
 *   ・上段：対象の目 n の1個を崩す（n が k-1 個のリーチ）。
 *   ・ストレート（S/B）：run の1個を崩す（端伸ばし/穴埋め。getStraightDecoy）。
 *   ・none：null。
 */
function getSuccessDecoy(
  finalValues: DieValue[],
  role:        ScoringRole,
): { index: number; decoy: DieValue } | null {
  switch (role.type) {
    case 'yacht': {
      const index = 4
      return { index, decoy: differentValue(finalValues[index]) }
    }
    case 'fourDice': {
      const index = finalValues.findIndex(v => v === role.n)
      const odd   = finalValues.find(v => v !== role.n)        // 5個目（崩した先がここと一致するとフルハウス化）
      const avoid = new Set<DieValue>([role.n])
      if (odd !== undefined) avoid.add(odd)
      const decoy = chooseDecoy(finalValues, index, role.rank, avoid)
      return decoy === null ? null : { index, decoy }
    }
    case 'fullHouse': {
      const index = finalValues.findIndex(v => v === role.b)   // ペア側を1個崩す
      const avoid = new Set<DieValue>([role.a, role.b])        // a に崩すと4揃い化／b は無変化
      const decoy = chooseDecoy(finalValues, index, role.rank, avoid)
      return decoy === null ? null : { index, decoy }
    }
    case 'upper': {
      const index = finalValues.findIndex(v => v === role.n)
      // 既存の他の目と一致させない（別のペアを偶然作らない）。n 自身も除外。
      const avoid = new Set<DieValue>(finalValues.filter((_, i) => i !== index))
      avoid.add(role.n)
      const decoy = chooseDecoy(finalValues, index, role.rank, avoid)
      return decoy === null ? null : { index, decoy }
    }
    case 'bigStraight':
    case 'smallStraight':
      // smallStraight の free die は runDice に含まれないので終始不変
      return getStraightDecoy(finalValues, role.runDice, role.rank)
    default:
      return null   // none
  }
}

/**
 * 見せ札と演出対象インデックスを計算する。
 *
 * @param finalValues  最終確定目（5個）
 * @param mode         演出モード
 */
export function computeShowDice(
  finalValues: DieValue[],
  mode: EffectMode
): ShowDiceResult {
  // 演出なし / auto（auto の具体 mode は投入準備時に解決済み。ここに来る auto は素直）
  if (mode === 'none' || mode === 'auto') {
    return { showValues: [...finalValues], cupIndices: [], swapIndices: [] }
  }

  // ハズレ：見せ札 = final そのまま、カップは覆うが差し替えなし（従来どおり）
  if (mode === 'miss') {
    return { showValues: [...finalValues], cupIndices: missCupIndices(finalValues), swapIndices: [] }
  }

  // 成功：決定役に応じて1個だけ decoy に差し替えてリーチを見せ、cover 中に final へ戻す
  const role  = getBestScoringRole(finalValues)
  const decoy = getSuccessDecoy(finalValues, role)
  if (!decoy) {
    // 未対応役（ストレート等）→ 化けない。カップは覆うが差し替えなし（= miss と同じ見た目）
    return { showValues: [...finalValues], cupIndices: missCupIndices(finalValues), swapIndices: [] }
  }
  const showValues = [...finalValues]
  showValues[decoy.index] = decoy.decoy
  return { showValues, cupIndices: [decoy.index], swapIndices: [decoy.index] }
}
