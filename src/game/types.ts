// ゲーム全体で使う型定義

// サイコロ1個の出目（1〜6）
export type DieValue = 1 | 2 | 3 | 4 | 5 | 6;

// サイコロ1個の状態
export interface Die {
  id: number;        // 0〜4の識別番号
  value: DieValue;   // 現在の出目
  kept: boolean;     // キープ中か（振り直し対象外か）
}

// スコア記入欄のカテゴリ（アソビ大全準拠の13種）
export type Category =
  | "ones" | "twos" | "threes" | "fours" | "fives" | "sixes" // 上段
  | "choice"          // 全部の合計
  | "fourOfAKind"     // 4個同じ
  | "fullHouse"       // 3個＋2個
  | "smallStraight"   // 4連続
  | "largeStraight"   // 5連続
  | "yacht";          // 5個同じ

// 1人分のスコアシート。未記入は null
export type ScoreSheet = {
  [K in Category]: number | null;
};

// プレイヤー
export interface Player {
  id: string;
  name: string;
  isCPU: boolean;
  sheet: ScoreSheet;
}

// ゲーム全体の状態
export interface GameState {
  players: Player[];
  currentPlayerIndex: number; // 今の手番のプレイヤー
  dice: Die[];                // 5個のサイコロ
  rollsLeft: number;          // 残り振り回数（最大3）
  turnCount: number;          // 経過ターン数
  isFinished: boolean;        // ゲーム終了フラグ
}
// ── 演出システム ──

// 演出モード。success/miss/none=デバッグ強制。auto=通常プレイ/CPU（staging で確率抽選）
export type EffectMode = 'success' | 'miss' | 'none' | 'auto'

// 演出選択用「役ランク」。出目そのものの見栄えの強さ（スコア記入とは無関係）。
// none < weak < mid < strong < max。getDisplayRank() で算出（scoring.ts）。
export type DisplayRank = 'none' | 'weak' | 'mid' | 'strong' | 'max'

// ダイス1個の視覚状態（displayValue と finalValue を分離）
export interface DiceVisualState {
  id:           number
  displayValue: DieValue   // 現在画面に映っている目（見せ札 → 演出後に final へ）
  finalValue:   DieValue   // 最終確定目（スコア判定はこれ）
  covered:      boolean    // カップに今覆われているか
}
