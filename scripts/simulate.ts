/**
 * simulate.ts — CPU vs CPU シミュレーター
 *
 * 使い方:
 *   npx tsx scripts/simulate.ts [ゲーム数=1000] [出力ファイル=sim_log.json]
 *
 * 例:
 *   npx tsx scripts/simulate.ts 5000 results.json
 */

import { writeFileSync } from 'fs'
import { cpuKeepDice, cpuChooseCategory } from '../src/game/cpuAI'
import { calcCategoryScore, calcTotalScore, calcUpperBonus, calcUpperSum } from '../src/game/scoring'
import { selectEffectFromTable, drawIndependentCupHide } from '../src/game/effectTable'
import { getDisplayRank } from '../src/game/scoring'
import type { Category, DieValue, ScoreSheet } from '../src/game/types'

// ── 演出関連定数（GameScene.tsx と同値） ──────────────────
const CONFIDENCE_MIN_SCORE = 30
const CONFIDENCE_PROB      = 0.5

// ── 乱数ダイス ─────────────────────────────────────────
function rollDie(): DieValue {
  return (Math.floor(Math.random() * 6) + 1) as DieValue
}
function rollDice(n = 5): DieValue[] {
  return Array.from({ length: n }, rollDie)
}

// ── 空スコアシート ────────────────────────────────────
function emptySheet(): ScoreSheet {
  return {
    ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
    choice: null, fourOfAKind: null, fullHouse: null,
    smallStraight: null, largeStraight: null, yacht: null,
  }
}

const CATEGORIES: Category[] = [
  'ones','twos','threes','fours','fives','sixes',
  'choice','fourOfAKind','fullHouse','smallStraight','largeStraight','yacht',
]

// ── 1ターン（1ラウンドの1プレイヤー分）シミュレート ──
interface EffectLog {
  stagingEffect: string    // selectEffectFromTable の結果
  cupHideResult: string    // drawIndependentCupHide の結果（4キープ再振り時のみ、それ以外 'n/a'）
  confidenceSE: boolean    // kyuin/gako が鳴ったか
}

interface TurnResult {
  category: Category
  points: number
  finalValues: DieValue[]
  rollCount: number
  effects: EffectLog
}

function simulateTurn(sheet: ScoreSheet): TurnResult {
  // 1投目：全部振る
  let values = rollDice()
  let rollCount = 1
  let cupHideResult = 'n/a'

  // 2投目・3投目
  for (let roll = 1; roll < 3; roll++) {
    const available = CATEGORIES.filter(c => sheet[c] === null)
    if (available.length === 0) break

    const keepFlags = cpuKeepDice(values)
    const fieldCount = keepFlags.filter(k => !k).length
    if (fieldCount === 0) break

    // 4キープ再振り（field=1）→ cupHide 独立抽選
    if (fieldCount === 1) {
      const draw = drawIndependentCupHide()
      cupHideResult = `${draw.effectId}:${draw.variant ?? '-'}`
    }

    const rerolled = values.map((v, i) => keepFlags[i] ? v : rollDie())
    values = rerolled
    rollCount++
  }

  const cat = cpuChooseCategory(values, sheet)
  const fakeDice = values.map((value, id) => ({ id, value, kept: false }))
  const pts = calcCategoryScore(cat, fakeDice)

  // staging 演出抽選
  const rank = getDisplayRank(values)
  // displayValue が finalValue と異なるダイスがあるかの近似（シム上は常に同じなので boost なし）
  const stagingDraw = selectEffectFromTable(rank)
  const stagingEffect = `${stagingDraw.effectId}:${stagingDraw.variant ?? '-'}`

  // 信頼度SE（投入時。最高役が30点以上で50%）
  const allDice = values.map((value, id) => ({ id, value, kept: false }))
  const maxScore = Math.max(...CATEGORIES.map(c => calcCategoryScore(c, allDice)))
  const confidenceSE = maxScore >= CONFIDENCE_MIN_SCORE && Math.random() < CONFIDENCE_PROB

  return {
    category: cat, points: pts, finalValues: values, rollCount,
    effects: { stagingEffect, cupHideResult, confidenceSE },
  }
}

// ── 1ゲーム（12ラウンド×2プレイヤー）シミュレート ─────────
interface GameResult {
  gameNo: number
  playerA: { rounds: TurnResult[]; sheet: ScoreSheet; upper: number; bonus: number; total: number }
  playerB: { rounds: TurnResult[]; sheet: ScoreSheet; upper: number; bonus: number; total: number }
  winner: 'A' | 'B' | 'draw'
}

function simulateGame(gameNo: number): GameResult {
  const sheetA = emptySheet()
  const sheetB = emptySheet()
  const roundsA: TurnResult[] = []
  const roundsB: TurnResult[] = []

  for (let r = 0; r < 12; r++) {
    const ta = simulateTurn(sheetA)
    sheetA[ta.category] = ta.points
    roundsA.push(ta)

    const tb = simulateTurn(sheetB)
    sheetB[tb.category] = tb.points
    roundsB.push(tb)
  }

  const totalA = calcTotalScore(sheetA)
  const totalB = calcTotalScore(sheetB)

  return {
    gameNo,
    playerA: {
      rounds: roundsA, sheet: sheetA,
      upper: calcUpperSum(sheetA), bonus: calcUpperBonus(sheetA), total: totalA,
    },
    playerB: {
      rounds: roundsB, sheet: sheetB,
      upper: calcUpperSum(sheetB), bonus: calcUpperBonus(sheetB), total: totalB,
    },
    winner: totalA > totalB ? 'A' : totalB > totalA ? 'B' : 'draw',
  }
}

// ── 集計サマリー ────────────────────────────────────────
interface EffectSummary {
  // staging 演出
  stagingDist: Record<string, string>     // 'slashB:success' → 'N回 (X%)'
  avgStagingPerGame: string
  // cupHide（4キープ再振り）
  cupHideDist: Record<string, string>
  cupHideTriggersPerGame: string          // 4キープ再振り自体が起きた回数/試合
  // 信頼度SE
  confidenceSEPerGame: string             // kyuin/gako が鳴った回数/試合
}

interface Summary {
  games: number
  winRateA: string
  winRateB: string
  drawRate: string
  avgTotalA: string
  avgTotalB: string
  avgUpperA: string
  avgUpperB: string
  bonusRateA: string
  bonusRateB: string
  avgRollsPerTurn: string
  categoryStats: Record<Category, { avgPoints: string; zeroRate: string }>
  effects: EffectSummary
}

function summarize(results: GameResult[]): Summary {
  const n = results.length
  const winsA   = results.filter(r => r.winner === 'A').length
  const winsB   = results.filter(r => r.winner === 'B').length
  const draws   = results.filter(r => r.winner === 'draw').length

  const sumTotalA = results.reduce((s, r) => s + r.playerA.total, 0)
  const sumTotalB = results.reduce((s, r) => s + r.playerB.total, 0)
  const sumUpperA = results.reduce((s, r) => s + r.playerA.upper, 0)
  const sumUpperB = results.reduce((s, r) => s + r.playerB.upper, 0)
  const bonusA    = results.filter(r => r.playerA.bonus > 0).length
  const bonusB    = results.filter(r => r.playerB.bonus > 0).length

  const allRounds = results.flatMap(r => [...r.playerA.rounds, ...r.playerB.rounds])
  const avgRolls = allRounds.reduce((s, t) => s + t.rollCount, 0) / allRounds.length

  // カテゴリ別統計
  const categoryStats = {} as Summary['categoryStats']
  for (const cat of CATEGORIES) {
    const turns = allRounds.filter(t => t.category === cat)
    const zeros = turns.filter(t => t.points === 0).length
    const avg   = turns.reduce((s, t) => s + t.points, 0) / (turns.length || 1)
    categoryStats[cat] = {
      avgPoints: avg.toFixed(2),
      zeroRate:  (zeros / (turns.length || 1) * 100).toFixed(1) + '%',
    }
  }

  // 演出統計
  const totalTurns = allRounds.length

  // staging 分布
  const stagingCount: Record<string, number> = {}
  for (const t of allRounds) {
    const k = t.effects.stagingEffect
    stagingCount[k] = (stagingCount[k] ?? 0) + 1
  }
  const noneCount = stagingCount['none:-'] ?? 0
  const stagingDist: Record<string, string> = {}
  for (const [k, v] of Object.entries(stagingCount).sort((a,b) => b[1]-a[1])) {
    stagingDist[k] = `${v}回 (${(v/totalTurns*100).toFixed(1)}%)`
  }
  const stagingTotal = totalTurns - noneCount
  const avgStagingPerGame = (stagingTotal / n * 2).toFixed(2) // A+B で1試合

  // cupHide 分布（n/a 以外）
  const cupHideCount: Record<string, number> = {}
  let cupHideTriggers = 0
  for (const t of allRounds) {
    if (t.effects.cupHideResult !== 'n/a') {
      cupHideTriggers++
      const k = t.effects.cupHideResult
      cupHideCount[k] = (cupHideCount[k] ?? 0) + 1
    }
  }
  const cupHideDist: Record<string, string> = {}
  for (const [k, v] of Object.entries(cupHideCount).sort((a,b) => b[1]-a[1])) {
    cupHideDist[k] = `${v}回 (${(v/cupHideTriggers*100).toFixed(1)}%)`
  }

  // 信頼度SE
  const confidenceTotal = allRounds.filter(t => t.effects.confidenceSE).length

  return {
    games:           n,
    winRateA:        (winsA / n * 100).toFixed(1) + '%',
    winRateB:        (winsB / n * 100).toFixed(1) + '%',
    drawRate:        (draws / n * 100).toFixed(1) + '%',
    avgTotalA:       (sumTotalA / n).toFixed(1),
    avgTotalB:       (sumTotalB / n).toFixed(1),
    avgUpperA:       (sumUpperA / n).toFixed(1),
    avgUpperB:       (sumUpperB / n).toFixed(1),
    bonusRateA:      (bonusA / n * 100).toFixed(1) + '%',
    bonusRateB:      (bonusB / n * 100).toFixed(1) + '%',
    avgRollsPerTurn: avgRolls.toFixed(2),
    categoryStats,
    effects: {
      stagingDist,
      avgStagingPerGame,
      cupHideDist,
      cupHideTriggersPerGame: (cupHideTriggers / n).toFixed(2),
      confidenceSEPerGame:    (confidenceTotal / n).toFixed(2),
    },
  }
}

// ── main ─────────────────────────────────────────────────
const N    = parseInt(process.argv[2] ?? '1000', 10)
const OUT  = process.argv[3] ?? 'sim_log.json'

console.log(`Simulating ${N} games…`)
const t0 = Date.now()

const results: GameResult[] = []
for (let i = 0; i < N; i++) {
  results.push(simulateGame(i + 1))
  if ((i + 1) % 500 === 0) process.stdout.write(`  ${i + 1}/${N}\r`)
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(2)
console.log(`\nDone in ${elapsed}s`)

const summary = summarize(results)
console.log('\n=== Summary ===')
console.log(`Games:      ${summary.games}`)
console.log(`Win A:      ${summary.winRateA}  Win B: ${summary.winRateB}  Draw: ${summary.drawRate}`)
console.log(`Avg total:  A=${summary.avgTotalA}  B=${summary.avgTotalB}`)
console.log(`Avg upper:  A=${summary.avgUpperA}  B=${summary.avgUpperB}`)
console.log(`Bonus rate: A=${summary.bonusRateA}  B=${summary.bonusRateB}`)
console.log(`Avg rolls/turn: ${summary.avgRollsPerTurn}`)
console.log('\nCategory avg points / zero rate:')
for (const cat of CATEGORIES) {
  const s = summary.categoryStats[cat]
  console.log(`  ${cat.padEnd(16)} avg=${s.avgPoints.padStart(5)}  zero=${s.zeroRate}`)
}

const ef = summary.effects
console.log('\n=== 演出統計（1プレイヤー×1試合換算） ===')
console.log(`信頼度SE (kyuin/gako):  ${ef.confidenceSEPerGame}回/試合`)
console.log(`cupHide 4キープ発動:    ${ef.cupHideTriggersPerGame}回/試合`)
console.log(`staging 演出発生:       ${ef.avgStagingPerGame}回/試合 (none以外)`)
console.log('\ncupHide 内訳:')
for (const [k, v] of Object.entries(ef.cupHideDist)) {
  console.log(`  ${k.padEnd(24)} ${v}`)
}
console.log('\nstaging 演出内訳:')
for (const [k, v] of Object.entries(ef.stagingDist)) {
  console.log(`  ${k.padEnd(24)} ${v}`)
}

const output = {
  generatedAt: new Date().toISOString(),
  summary,
  games: results,
}
writeFileSync(OUT, JSON.stringify(output, null, 2), 'utf8')
console.log(`\nFull log saved → ${OUT}`)
