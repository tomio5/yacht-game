/**
 * protocol.ts — ホスト/ゲスト間の通信メッセージ型定義
 *
 * 通信の原則:
 *   - ホストが唯一の真実源。乱数・演出抽選・スコア計算はすべてホスト側で行う。
 *   - ゲストは「操作リクエスト」をホストへ送る。
 *   - ホストは「状態更新」を両者へブロードキャストする（自分にも適用）。
 *
 * メッセージの方向:
 *   H→G : ホストからゲストへ（状態通知）
 *   G→H : ゲストからホストへ（操作リクエスト）
 *   両方 : chat
 */

import type { Category, DieValue } from '../game/types'

// ── ホスト → ゲスト（状態通知） ──────────────────────────

/** ゲーム開始。先攻(host)・後攻(guest)を通知 */
export interface MsgGameStart {
  type: 'game_start'
  hostGoesFirst: boolean   // true=ホスト先攻（現状は常に true）
}

/** ゲームリセット。ホストが次のゲームを押したときゲストへ通知 */
export interface MsgGameReset {
  type: 'game_reset'
}

/** ターン開始。誰のターンかと残りロール数をリセット */
export interface MsgTurnStart {
  type: 'turn_start'
  turn: 'host' | 'guest'
  rollsLeft: number         // 常に 3
}

/** ロール結果。乱数・演出はホストが決定して送る */
export interface MsgRollResult {
  type: 'roll_result'
  turn: 'host' | 'guest'
  rollsLeft: number         // 残り振り回数（この roll 後）
  finalValues: DieValue[]   // 5個の確定目（スコア判定用）
  displayValues: DieValue[] // 5個の表示目（見せ札）
  keptIds: number[]         // キープ中のダイスID（0〜4）
  effectId: string          // 演出ID（'none'/'flip'/etc）
  effectVariant: string     // 'success'|'miss'|'-'
  displayRank: string       // 役ランク
}

/** キープ状態の更新。ホスト/ゲストどちらかが操作した結果を全員へ */
export interface MsgKeepUpdate {
  type: 'keep_update'
  keptIds: number[]         // キープ中のダイスID一覧
}

/** スコア記入完了。両者のシートを同期 */
export interface MsgScoreRecorded {
  type: 'score_recorded'
  by: 'host' | 'guest'
  category: Category
  points: number
  hostSheet: Record<Category, number | null>
  guestSheet: Record<Category, number | null>
}

/** ゲーム終了 */
export interface MsgGameOver {
  type: 'game_over'
  hostTotal: number
  guestTotal: number
  winner: 'host' | 'guest' | 'draw'
}

/** 切断通知（peer の close イベントを受けて相手側の UI に表示するだけ） */
export interface MsgDisconnected {
  type: 'disconnected'
}

// ── ゲスト → ホスト（操作リクエスト） ───────────────────

/** 振るボタンを押した（1投目 or 再振り） */
export interface MsgReqRoll {
  type: 'req_roll'
}

/** ダイスのキープ/アンキープ操作 */
export interface MsgReqKeep {
  type: 'req_keep'
  dieId: number
  kept: boolean
}

/** スコア記入 */
export interface MsgReqRecord {
  type: 'req_record'
  category: Category
}

// ── 双方向 ──────────────────────────────────────────────

/** チャット */
export interface MsgChat {
  type: 'chat'
  text: string
}

/** staging 演出トリガー。アクティブプレイヤーが演出を起動した瞬間に相手へ送り、同時再生させる */
export interface MsgStaging {
  type: 'staging'
}

/** カップ投入開始。アクティブプレイヤーがカップをクリックした瞬間に相手へ送り、観戦側のカップを連動させる */
export interface MsgCupThrown {
  type: 'cup_thrown'
}

/** カップ解放。アクティブプレイヤーがポインタを離した瞬間に相手へ送り、観戦側のカップも同時解放させる */
export interface MsgCupReleased {
  type: 'cup_released'
}

/** ロビーで「ゲーム開始」を押した合図。両者が ready になったら対戦開始（双方向） */
export interface MsgReady {
  type: 'ready'
}

// ── ユニオン型 ───────────────────────────────────────────

/** ホスト→ゲスト方向のメッセージ */
export type HostToGuest =
  | MsgGameStart
  | MsgGameReset
  | MsgTurnStart
  | MsgRollResult
  | MsgKeepUpdate
  | MsgScoreRecorded
  | MsgGameOver
  | MsgDisconnected
  | MsgChat
  | MsgStaging
  | MsgCupThrown
  | MsgCupReleased
  | MsgReady

/** ゲスト→ホスト方向のメッセージ */
export type GuestToHost =
  | MsgReqRoll
  | MsgReqKeep
  | MsgReqRecord
  | MsgChat
  | MsgStaging
  | MsgCupThrown
  | MsgCupReleased
  | MsgReady

/** 受信データのナローイング用型ガード */
export function isHostToGuest(data: unknown): data is HostToGuest {
  return typeof data === 'object' && data !== null && 'type' in data
}

export function isGuestToHost(data: unknown): data is GuestToHost {
  return typeof data === 'object' && data !== null && 'type' in data
}
