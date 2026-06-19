// サイコロの出目を扱う関数群

import type { Die, DieValue } from "./types";

// 1〜6をランダムに返す（ここが「内部抽選」の心臓部）
export function rollDieValue(): DieValue {
  return (Math.floor(Math.random() * 6) + 1) as DieValue;
}

// 5個のサイコロを初期状態で作る
export function createInitialDice(): Die[] {
  return Array.from({ length: 5 }, (_, i) => ({
    id: i,
    value: rollDieValue(),
    kept: false,
  }));
}

// キープされていないサイコロだけ振り直す。新しい配列を返す（元は変更しない）
export function rollDice(dice: Die[]): Die[] {
  return dice.map((die) =>
    die.kept ? die : { ...die, value: rollDieValue() }
  );
}