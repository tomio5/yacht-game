/**
 * cpuAI.ts — CPU の意思決定ロジック
 *
 * - cpuKeepDice(values): どのダイスをキープするか判断
 * - cpuChooseCategory(values, sheet): どのカテゴリに記入するか判断
 */

import type { DieValue, Category, ScoreSheet } from './types'
import { calcCategoryScore } from './scoring'

interface Die { id: number; value: DieValue; kept: boolean }

// ── ユーティリティ ─────────────────────────────────────
function countValues(values: DieValue[]): Map<DieValue, number> {
  const m = new Map<DieValue, number>()
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1)
  return m
}

function longestRun(sorted: number[]): { len: number; vals: Set<number> } {
  if (sorted.length === 0) return { len: 0, vals: new Set() }
  let best = { len: 1, start: 0 }, cur = { len: 1, start: 0 }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) {
      cur.len++
      if (cur.len > best.len) best = { ...cur }
    } else {
      cur = { len: 1, start: i }
    }
  }
  const vals = new Set(sorted.slice(best.start, best.start + best.len))
  return { len: best.len, vals }
}

// ── キープ判断 ─────────────────────────────────────────
/**
 * 現在の出目から「どのインデックスをキープするか」を boolean[] で返す
 */
export function cpuKeepDice(values: DieValue[]): boolean[] {
  const counts = countValues(values)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const [topVal, topCount] = sorted[0]

  // ヨット（5個同じ）→ 全部キープ
  if (topCount === 5) return values.map(() => true)

  // 4個同じ → 4個キープ
  if (topCount >= 4) return values.map(v => v === topVal)

  // フルハウス（3+2）→ 全部キープ
  if (sorted.length >= 2 && sorted[0][1] === 3 && sorted[1][1] === 2)
    return values.map(() => true)

  // 4連続以上 → ストレート狙いでその目をキープ
  const unique = [...new Set(values)].sort((a, b) => a - b)
  const run = longestRun(unique)
  if (run.len >= 4) return values.map(v => run.vals.has(v))

  // 3個同じ → 3個キープ
  if (topCount === 3) return values.map(v => v === topVal)

  // 2ペア → 両方の値をキープ
  const pairs = sorted.filter(([, c]) => c >= 2).map(([v]) => v)
  if (pairs.length >= 2) return values.map(v => pairs.includes(v))

  // 1ペア → ペアをキープ（高い方優先）
  if (topCount === 2) {
    const bestPairVal = sorted.filter(([,c]) => c >= 2).sort((a,b) => b[0]-a[0])[0]?.[0]
    if (bestPairVal !== undefined) return values.map(v => v === bestPairVal)
  }

  // バラ → 最大値の目だけキープ
  const maxVal = Math.max(...values)
  // 最初に見つかった1個だけキープ
  let kept = false
  return values.map(v => {
    if (!kept && v === maxVal) { kept = true; return true }
    return false
  })
}

// ── カテゴリ選択 ─────────────────────────────────────
/**
 * 残りカテゴリの中から最もスコアが高いカテゴリを選ぶ。
 * 全部0点なら価値の低いカテゴリに0点を入れる。
 */
export function cpuChooseCategory(values: DieValue[], sheet: ScoreSheet): Category {
  const fakeDice: Die[] = values.map((value, id) => ({ id, value, kept: false }))

  // スコアが高い順に優先
  const PRIORITY: Category[] = [
    'yacht', 'largeStraight', 'fourOfAKind', 'fullHouse',
    'smallStraight', 'choice',
    'sixes', 'fives', 'fours', 'threes', 'twos', 'ones',
  ]

  const available = PRIORITY.filter(cat => sheet[cat] === null)
  if (available.length === 0) throw new Error('No categories left')

  let bestCat = available[0]
  let bestScore = -1
  for (const cat of available) {
    const score = calcCategoryScore(cat, fakeDice)
    if (score > bestScore) { bestScore = score; bestCat = cat }
  }

  // 全部0点 → 損失が少ないカテゴリ（ones → twos → ... の順で無駄使い）
  if (bestScore === 0) {
    const waste: Category[] = [
      'ones', 'twos', 'smallStraight', 'fullHouse',
      'threes', 'fours', 'fourOfAKind', 'largeStraight',
      'fives', 'sixes', 'choice', 'yacht',
    ]
    for (const cat of waste) {
      if (sheet[cat] === null) return cat
    }
  }

  return bestCat
}
