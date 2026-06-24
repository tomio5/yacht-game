// 13カテゴリそれぞれの得点計算。アソビ大全準拠。

import type { Category, Die, DieValue, DisplayRank, ScoreSheet } from "./types";

// 出目の配列から「各目が何個あるか」を数える
function countValues(values: DieValue[]): Record<number, number> {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const v of values) counts[v]++;
  return counts;
}

// 上段：指定した目の合計（例 threes なら3の目の合計）
function sumOfValue(values: DieValue[], target: DieValue): number {
  return values.filter((v) => v === target).reduce((a, b) => a + b, 0);
}

// 指定カテゴリに、今の出目を記入したら何点になるかを計算
export function calcCategoryScore(category: Category, dice: Die[]): number {
  const values = dice.map((d) => d.value);
  const counts = countValues(values);
  const total = values.reduce((a, b) => a + b, 0);
  const countList = Object.values(counts);

  switch (category) {
    case "ones": return sumOfValue(values, 1);
    case "twos": return sumOfValue(values, 2);
    case "threes": return sumOfValue(values, 3);
    case "fours": return sumOfValue(values, 4);
    case "fives": return sumOfValue(values, 5);
    case "sixes": return sumOfValue(values, 6);

    case "choice": return total; // 全部の合計

    case "fourOfAKind":
      // 同じ目が4個以上あれば全部の合計、なければ0
      return countList.some((c) => c >= 4) ? total : 0;

    case "fullHouse": {
      // 3個＋2個の組み合わせなら全部の合計、なければ0
      const hasThree = countList.includes(3);
      const hasTwo = countList.includes(2);
      // 5個同じ(yacht)もフルハウス扱いにするか否かはルール差あり。
      // アソビ大全は「3+2ちょうど」のみ成立とする実装にしている。
      return hasThree && hasTwo ? total : 0;
    }

    case "smallStraight": {
      // 4連続が含まれれば15点（固定）、なければ0
      const has = (n: number) => counts[n] > 0;
      const ok =
        (has(1) && has(2) && has(3) && has(4)) ||
        (has(2) && has(3) && has(4) && has(5)) ||
        (has(3) && has(4) && has(5) && has(6));
      return ok ? 15 : 0;
    }

    case "largeStraight": {
      // 5連続なら30点（固定）、なければ0
      const has = (n: number) => counts[n] > 0;
      const ok =
        (has(1) && has(2) && has(3) && has(4) && has(5)) ||
        (has(2) && has(3) && has(4) && has(5) && has(6));
      return ok ? 30 : 0;
    }

    case "yacht":
      // 5個全部同じなら50点、なければ0
      return countList.some((c) => c === 5) ? 50 : 0;
  }
}

// ── 演出選択用「決定役」と「役ランク」 ──
// finalValue（長さ5・各1〜6）から、出目が作れる「最強役」を1つ決める共有関数。
// getDisplayRank（演出テーブル駆動）と見せ札生成（showDice）が必ず同じ役を見るよう、
// 役の選定ロジックをここ1箇所に集約する。判定は既存の calcCategoryScore を再利用。
//   max    : ヨット（5個同じ）
//   strong : B.ストレート、または変動役の実点 28〜30
//   mid    : S.ストレート、または変動役の実点 15〜27
//   weak   : 変動役の実点 1〜14
//   none   : 揃い（2個以上）もストレート（S/B）も無い
// 「変動役」＝フォーダイス(実点=5個合計)／フルハウス(実点=5個合計)／上段(目×個数, 2個以上のみ)。
// チョイスは常に5以上入る受け皿なので判定に使わない（除外）。

// ストレートの run を構成するダイス（見せ札の端伸ばし/穴埋め用）
export interface RunDie { index: number; value: DieValue }

// 決定役（種類＋見せ札に必要なパラメータ＋ランク）
export type ScoringRole =
  | { type: "yacht";         rank: DisplayRank }
  | { type: "bigStraight";   rank: DisplayRank; runDice: RunDie[] }                  // 5個すべて run
  | { type: "smallStraight"; rank: DisplayRank; runDice: RunDie[]; freeIndex: number } // 4個 run＋free1個
  | { type: "fourDice";      n: DieValue; rank: DisplayRank }              // 揃いの目 n
  | { type: "fullHouse";     a: DieValue; b: DieValue; rank: DisplayRank } // a=トリプル, b=ペア
  | { type: "upper";         n: DieValue; rank: DisplayRank }              // 対象の目 n（k≥2個）
  | { type: "none";          rank: "none" };

const RANK_ORDER: DisplayRank[] = ["none", "weak", "mid", "strong", "max"];
export function rankIndex(r: DisplayRank): number { return RANK_ORDER.indexOf(r); }

// 変動役の実点 → ランク
function rankFromVariablePoint(p: number): DisplayRank {
  if (p >= 28) return "strong";
  if (p >= 15) return "mid";
  if (p >= 1)  return "weak";
  return "none";
}

export function getBestScoringRole(finalValue: DieValue[]): ScoringRole {
  // calcCategoryScore は Die[] を取るため、judging 用に最小の Die[] を組み立てる
  const dice: Die[] = finalValue.map((v, i) => ({ id: i, value: v, kept: false }));
  const counts = countValues(finalValue);

  // max: ヨット
  if (calcCategoryScore("yacht", dice) > 0) return { type: "yacht", rank: "max" };

  // 変動役（フォーダイス／フルハウス／上段）の中で最も実点の高い1役を決める。
  // ・フォーダイスとフルハウスは排他（4揃いは3+2にならない）。
  // ・実点はいずれも自分の上段成分以上なので、成立していればその役が変動役の代表になる。
  let variable: ScoringRole | null = null;
  const fourScore = calcCategoryScore("fourOfAKind", dice); // 4個以上→合計, 他0
  const fullScore = calcCategoryScore("fullHouse", dice);   // 3+2ちょうど→合計, 他0
  if (fourScore > 0) {
    const n = ([1, 2, 3, 4, 5, 6] as DieValue[]).find(v => counts[v] === 4)!;
    variable = { type: "fourDice", n, rank: rankFromVariablePoint(fourScore) };
  } else if (fullScore > 0) {
    const a = ([1, 2, 3, 4, 5, 6] as DieValue[]).find(v => counts[v] === 3)!;
    const b = ([1, 2, 3, 4, 5, 6] as DieValue[]).find(v => counts[v] === 2)!;
    variable = { type: "fullHouse", a, b, rank: rankFromVariablePoint(fullScore) };
  } else {
    // 上段：同じ目が2個以上ある目のうち「目×個数」が最大の目を採用（1個だけは揃い扱いしない）
    let bestN: DieValue | null = null, bestP = 0;
    for (const v of [1, 2, 3, 4, 5, 6] as DieValue[]) {
      if (counts[v] >= 2 && v * counts[v] > bestP) { bestP = v * counts[v]; bestN = v; }
    }
    if (bestN) variable = { type: "upper", n: bestN, rank: rankFromVariablePoint(bestP) };
  }

  // ストレート（固定ランク）。run を構成するダイス（index/値）を持たせる。
  const cands: ScoringRole[] = [];
  if (calcCategoryScore("largeStraight", dice) > 0) {
    // B.スト：5個すべてが run die
    const runDice: RunDie[] = finalValue.map((value, index) => ({ index, value }));
    cands.push({ type: "bigStraight", rank: "strong", runDice });
  }
  if (calcCategoryScore("smallStraight", dice) > 0) {
    // S.スト：成立している4連続を1つ特定し、各値に1個ずつ index を割り当て、残りを free とする
    const win = ([[1, 2, 3, 4], [2, 3, 4, 5], [3, 4, 5, 6]] as DieValue[][])
      .find(w => w.every(n => counts[n] > 0))!;
    const used = new Set<number>();
    const runDice: RunDie[] = win.map(value => {
      const index = finalValue.findIndex((v, i) => v === value && !used.has(i));
      used.add(index);
      return { index, value };
    });
    const freeIndex = finalValue.findIndex((_, i) => !used.has(i));
    cands.push({ type: "smallStraight", rank: "mid", runDice, freeIndex });
  }
  if (variable) cands.push(variable);

  if (cands.length === 0) return { type: "none", rank: "none" };

  // 最強ランクの役を採用。同ランクのときは「見せ札を作れる変動役」を優先（ランク値は不変）。
  const topRank = cands.reduce((m, c) => (rankIndex(c.rank) > rankIndex(m) ? c.rank : m), "none" as DisplayRank);
  const top = cands.filter(c => c.rank === topRank);
  return top.find(c => c.type === "fourDice" || c.type === "fullHouse" || c.type === "upper") ?? top[0];
}

// 役ランクのみが欲しいときの薄いラッパー（決定役は getBestScoringRole と必ず一致する）
export function getDisplayRank(finalValue: DieValue[]): DisplayRank {
  return getBestScoringRole(finalValue).rank;
}

// 上段6カテゴリの合計
export function calcUpperSum(sheet: ScoreSheet): number {
  const upper: Category[] = ["ones", "twos", "threes", "fours", "fives", "sixes"];
  return upper.reduce((sum, c) => sum + (sheet[c] ?? 0), 0);
}

// 上段ボーナス：63点以上で+35点
export function calcUpperBonus(sheet: ScoreSheet): number {
  return calcUpperSum(sheet) >= 63 ? 35 : 0;
}

// 合計点（上段＋ボーナス＋下段）
export function calcTotalScore(sheet: ScoreSheet): number {
  const base = (Object.keys(sheet) as Category[]).reduce(
    (sum, c) => sum + (sheet[c] ?? 0),
    0
  );
  return base + calcUpperBonus(sheet);
}

// finalValue の出目で「いずれかのカテゴリに記入したときの最高点」。信頼度音（gako/gakokyuin）の対象判定に使う。
const SCORE_CATEGORIES: Category[] = [
  "ones", "twos", "threes", "fours", "fives", "sixes",
  "choice", "fourOfAKind", "fullHouse", "smallStraight", "largeStraight", "yacht",
];
export function maxRoleScore(finals: DieValue[]): number {
  const dice: Die[] = finals.map((value, id) => ({ id, value, kept: false }));
  return Math.max(...SCORE_CATEGORIES.map((c) => calcCategoryScore(c, dice)));
}