// ゲームの状態を作る・進める関数群。状態は毎回新しいオブジェクトで返す（イミュータブル）。

import type { Category, GameState, Player, ScoreSheet } from "./types";
import { createInitialDice, rollDice } from "./dice";
import { calcCategoryScore } from "./scoring";

// 空のスコアシート（全項目未記入）
function createEmptySheet(): ScoreSheet {
  return {
    ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
    choice: null, fourOfAKind: null, fullHouse: null,
    smallStraight: null, largeStraight: null, yacht: null,
  };
}

// プレイヤーを作る
function createPlayer(id: string, name: string, isCPU: boolean): Player {
  return { id, name, isCPU, sheet: createEmptySheet() };
}

// ゲーム開始時の初期状態を作る
export function createGame(playerName: string): GameState {
  return {
    players: [
      createPlayer("p1", playerName, false),
      createPlayer("cpu", "CPU", true),
    ],
    currentPlayerIndex: 0,
    dice: createInitialDice(),
    rollsLeft: 3,
    turnCount: 0,
    isFinished: false,
  };
}

// サイコロを振る（残り回数がある時だけ）。内部抽選はここで起きる。
export function doRoll(state: GameState): GameState {
  if (state.rollsLeft <= 0) return state;
  return {
    ...state,
    dice: rollDice(state.dice),
    rollsLeft: state.rollsLeft - 1,
  };
}

// 指定IDのサイコロのキープ状態を切り替える
export function toggleKeep(state: GameState, dieId: number): GameState {
  return {
    ...state,
    dice: state.dice.map((d) =>
      d.id === dieId ? { ...d, kept: !d.kept } : d
    ),
  };
}

// 今の手番プレイヤーが、指定カテゴリにスコアを記入してターンを終える
export function recordScore(state: GameState, category: Category): GameState {
  const player = state.players[state.currentPlayerIndex];

  // すでに記入済みなら何もしない
  if (player.sheet[category] !== null) return state;

  const score = calcCategoryScore(category, state.dice);

  // 記入後のプレイヤーを作る
  const updatedPlayer: Player = {
    ...player,
    sheet: { ...player.sheet, [category]: score },
  };
  const updatedPlayers = state.players.map((p, i) =>
    i === state.currentPlayerIndex ? updatedPlayer : p
  );

  // 次の手番へ
  const nextIndex = (state.currentPlayerIndex + 1) % state.players.length;
  const nextTurnCount = state.turnCount + 1;

  // 全員が13カテゴリ全部埋めたら終了。
  // 13カテゴリ × 人数 回の記入で終わる。
  const totalRecordsNeeded = 13 * state.players.length;
  const recordsDone = updatedPlayers.reduce(
    (sum, p) =>
      sum + Object.values(p.sheet).filter((v) => v !== null).length,
    0
  );
  const finished = recordsDone >= totalRecordsNeeded;

  return {
    ...state,
    players: updatedPlayers,
    currentPlayerIndex: nextIndex,
    dice: createInitialDice(), // 次のプレイヤー用にリセット
    rollsLeft: 3,
    turnCount: nextTurnCount,
    isFinished: finished,
  };
}