/**
 * useNetMode.ts — GameScene と useNetGame をつなぐブリッジ
 *
 * GameScene が netMode prop を受け取ったとき、このフックが返す値を渡す。
 * HOST: GameScene は通常通り動作。ロール/キープ/記入後にゲストへ送信。
 * GUEST: ロール/記入はホストへリクエストし、結果を待ってから GameScene に注入。
 *        キープはホストへリクエストし、keep_update を受けて反映。
 */

import { useCallback, useEffect, useRef } from 'react'
import { peerConnection } from './PeerConnection'
import type { HostToGuest, GuestToHost, MsgRollResult, MsgKeepUpdate, MsgScoreRecorded, MsgGameOver, MsgLog } from './protocol'
import { rollDieValue } from '../game/dice'
import { calcCategoryScore, calcTotalScore, getDisplayRank, maxRoleScore } from '../game/scoring'
import { selectEffectFromTable, drawThrowEffect, drawConfidenceSE } from '../game/effectTable'
import { computeShowDice } from '../game/showDice'
import type { Category, DieValue, ScoreSheet } from '../game/types'

// ── GameScene が受け取る netMode の型 ─────────────────

export interface RollInjection {
  finals:        DieValue[]
  displayValues: DieValue[]
  effectId:      string
  effectVariant: string
  throwEffect:   string     // 投入演出ID（'none'/'slowA'/'slowB'/'fake'）
  confidenceSE:  string     // 信頼度音（'none'/'gako'/'gakokyuin'）
}

export interface NetMode {
  role: 'host' | 'guest'
  isMyTurn: () => boolean

  // ホスト専用：GameScene がロール確定後に呼ぶ → ゲストへ送信
  notifyRoll: (finals: DieValue[], displayValues: DieValue[], effectId: string, effectVariant: string, keptIds: number[], rollsLeft: number, throwEffect: string, confidenceSE: string) => void
  // ホスト専用：キープ変化後に呼ぶ
  notifyKeep: (keptIds: number[]) => void
  // ホスト専用：記入後に呼ぶ
  notifyRecord: (category: Category, points: number, playerSheet: ScoreSheet, opponentSheet: ScoreSheet) => void
  // ホスト専用：ゲーム終了後に呼ぶ
  notifyGameOver: (playerTotal: number, opponentTotal: number) => void
  // ホスト専用：次のゲーム開始時に呼ぶ（ゲストへリセット通知）
  notifyGameReset: () => void

  // ゲスト専用：振るボタン押下 → ホストへ req_roll を送る
  requestRoll: () => void
  // ゲスト専用：キープ操作 → ホストへ req_keep を送る
  requestKeep: (dieId: number, kept: boolean) => void
  // ゲスト専用：記入操作 → ホストへ req_record を送る
  requestRecord: (category: Category) => void

  // 両方：相手の操作受信時に GameScene へ通知するコールバックを登録
  onRollResult:   (cb: (r: RollInjection & { keptIds: number[]; rollsLeft: number }) => void) => () => void
  onKeepUpdate:   (cb: (keptIds: number[]) => void) => () => void
  onScoreUpdate:  (cb: (by: 'me'|'opponent', category: Category, points: number, mySheet: ScoreSheet, oppSheet: ScoreSheet) => void) => () => void
  onTurnChange:   (cb: (isMyTurn: boolean) => void) => () => void
  onGameOver:     (cb: (myTotal: number, oppTotal: number, winner: 'me'|'opponent'|'draw') => void) => () => void
  // staging 演出トリガー通知: アクティブ側が起動したとき相手へ送信、受信側は即再生
  notifyStaging:  (effectId: string) => void
  onStaging:      (cb: (effectId: string) => void) => () => void
  // ホストがゲームリセットしたときゲスト側で呼ばれる
  onGameReset:    (cb: () => void) => () => void
  // カップ投入開始通知: アクティブ側がカップをクリックした瞬間に相手へ送り、観戦側カップを連動させる
  notifyCupThrown: () => void
  onCupThrown:     (cb: () => void) => () => void
  // カップ解放通知: アクティブ側がポインタを離した瞬間に相手へ送り、観戦側カップも同時解放させる
  notifyCupReleased: () => void
  onCupReleased:     (cb: () => void) => () => void
  // プレイログ転送（ゲスト→ホスト）。sendLog で自分のログを送り、ホストは onLog で受け取って一括DLに含める
  sendLog: (startedAt: string, entries: unknown[]) => void
  onLog:   (cb: (role: 'host'|'guest', startedAt: string, entries: unknown[]) => void) => () => void
  // 相手との接続断（close/error）。GameScene が購読して切断オーバーレイを表示する
  onPeerDisconnected: (cb: () => void) => () => void
}

// ── フック ───────────────────────────────────────────────

export function useNetMode(role: 'host' | 'guest'): NetMode {
  // コールバック登録テーブル（useEffect 内で登録 → GameScene からサブスクライブ）
  const rollResultCbs  = useRef<Set<(r: RollInjection & { keptIds: number[]; rollsLeft: number }) => void>>(new Set())
  const keepUpdateCbs  = useRef<Set<(keptIds: number[]) => void>>(new Set())
  const scoreUpdateCbs = useRef<Set<(by: 'me'|'opponent', cat: Category, pts: number, my: ScoreSheet, opp: ScoreSheet) => void>>(new Set())
  const turnChangeCbs  = useRef<Set<(isMyTurn: boolean) => void>>(new Set())
  const gameOverCbs    = useRef<Set<(myTotal: number, oppTotal: number, winner: 'me'|'opponent'|'draw') => void>>(new Set())
  const stagingCbs     = useRef<Set<(effectId: string) => void>>(new Set())
  const cupThrownCbs    = useRef<Set<() => void>>(new Set())
  const cupReleasedCbs  = useRef<Set<() => void>>(new Set())
  const logCbs          = useRef<Set<(role: 'host'|'guest', startedAt: string, entries: unknown[]) => void>>(new Set())
  const disconnectCbs   = useRef<Set<() => void>>(new Set())
  const gameResetCbs    = useRef<Set<() => void>>(new Set())

  // ホストが管理するシート（ゲスト→ホストのreq_record受信時に使う）
  const hostSheetRef  = useRef<ScoreSheet>(emptySheet())
  const guestSheetRef = useRef<ScoreSheet>(emptySheet())
  const isTurnMineRef = useRef(role === 'host')  // ホスト先攻

  // ── ホスト専用: req_roll 受信時の処理 ────────────────
  const hostProcessGuestRoll = useCallback((keptIds: number[], prevFinals: DieValue[]) => {
    const newFinals: DieValue[] = prevFinals.map((v, i) =>
      keptIds.includes(i) ? v : rollDieValue()
    )
    const rank         = getDisplayRank(newFinals)
    const draw         = selectEffectFromTable(rank)
    const throwEffect  = drawThrowEffect(rank)
    const confidenceSE = drawConfidenceSE(maxRoleScore(newFinals))
    const rollMsg: MsgRollResult = {
      type: 'roll_result',
      turn: 'guest',
      rollsLeft: -1,            // ゲスト側の rollsLeft はホストが知らないのでゲスト自身が管理
      finalValues:   newFinals,
      displayValues: newFinals,
      keptIds,
      effectId:      draw.effectId,
      effectVariant: draw.variant ?? '-',
      displayRank:   rank,
      throwEffect,
      confidenceSE,
    }
    // ヨット成立時: デコイ付き displayValues を計算して送信（ゲスト・ホスト観戦側でも正しい見せ目になる）
    const isYacht = newFinals.every(v => v === newFinals[0])
    if (isYacht) {
      const { showValues } = computeShowDice(newFinals, 'success', keptIds)
      rollMsg.displayValues = showValues
    }
    guestDiceFinals.current = newFinals   // スコア記入時に正しい出目を参照できるよう更新
    guestKeptIds.current    = []          // 再振り後はキープ選択をリセット（gatherFieldDice で全員 field に戻るため）
    peerConnection.send(rollMsg)
    // ホスト自身の表示更新（相手ターンの演出観戦用）
    rollResultCbs.current.forEach(cb => cb({
      finals: newFinals, displayValues: newFinals,
      effectId: draw.effectId, effectVariant: draw.variant ?? '-',
      throwEffect, confidenceSE,
      keptIds, rollsLeft: -1,
    }))
  }, [])

  const hostProcessGuestRecord = useCallback((category: Category, prevFinals: DieValue[]) => {
    const fakeDice = prevFinals.map((value, id) => ({ id, value, kept: false }))
    const pts = calcCategoryScore(category, fakeDice)
    guestSheetRef.current = { ...guestSheetRef.current, [category]: pts }

    const scoreMsg: MsgScoreRecorded = {
      type: 'score_recorded',
      by: 'guest', category, points: pts,
      hostSheet:  hostSheetRef.current  as Record<Category, number | null>,
      guestSheet: guestSheetRef.current as Record<Category, number | null>,
    }
    peerConnection.send(scoreMsg)

    // ホスト自身も更新
    scoreUpdateCbs.current.forEach(cb =>
      cb('opponent', category, pts, hostSheetRef.current, guestSheetRef.current)
    )

    // ゲーム終了チェック
    const hostDone  = isSheetFull(hostSheetRef.current)
    const guestDone = isSheetFull(guestSheetRef.current)
    if (hostDone && guestDone) {
      const ht = calcTotalScore(hostSheetRef.current)
      const gt = calcTotalScore(guestSheetRef.current)
      const winner = ht > gt ? 'host' : gt > ht ? 'guest' : 'draw'
      const overMsg: MsgGameOver = { type: 'game_over', hostTotal: ht, guestTotal: gt, winner }
      peerConnection.send(overMsg)
      const myW = winner === 'host' ? 'me' : winner === 'guest' ? 'opponent' : 'draw'
      gameOverCbs.current.forEach(cb => cb(ht, gt, myW as 'me'|'opponent'|'draw'))
      return
    }

    // 次ターン（ホスト）
    isTurnMineRef.current = true
    turnChangeCbs.current.forEach(cb => cb(true))
    peerConnection.send({ type: 'turn_start', turn: 'host', rollsLeft: 3 })
  }, [])

  // ── 受信ハンドラ ─────────────────────────────────────

  // ゲストターン中のダイス状態をホストが把握するための ref
  const guestDiceFinals = useRef<DieValue[]>([1,1,1,1,1] as DieValue[])
  const guestKeptIds    = useRef<number[]>([])

  useEffect(() => {
    // ゲーム中の切断検知: ロビー（TitleScreen）は NetGame マウント時点でアンマウント済みなので
    // ここで上書き代入して問題ない。GameScene が onPeerDisconnected で購読し、切断オーバーレイを出す。
    let disconnectFired = false   // close/error/ICE/ハートビートの多重発火を1回に集約
    const fireDisconnect = () => {
      if (disconnectFired) return
      disconnectFired = true
      disconnectCbs.current.forEach(cb => cb())
    }
    peerConnection.onDisconnected = fireDisconnect

    // ハートビート: PeerJS はタブ閉じ等の突然切断で close が発火しないことがあるため、
    // アプリレベルで 2.5s 毎に ping を送り、10s 何も受信しなければ切断とみなす（確実な検知層）。
    let lastRecv = Date.now()
    const pingTimer  = setInterval(() => { peerConnection.send({ type: 'ping' }) }, 2500)
    const watchTimer = setInterval(() => {
      if (Date.now() - lastRecv > 10000) fireDisconnect()
    }, 3000)

    peerConnection.onData = (raw) => {
      lastRecv = Date.now()   // ping 含む全受信で生存更新
      if (role === 'host') {
        const msg = raw as GuestToHost
        switch (msg.type) {
          case 'req_roll':
            hostProcessGuestRoll(guestKeptIds.current, guestDiceFinals.current)
            break
          case 'req_keep': {
            const prev = guestKeptIds.current
            guestKeptIds.current = msg.kept
              ? [...prev.filter(id => id !== msg.dieId), msg.dieId]
              : prev.filter(id => id !== msg.dieId)
            const keepMsg: MsgKeepUpdate = { type: 'keep_update', keptIds: guestKeptIds.current }
            peerConnection.send(keepMsg)
            keepUpdateCbs.current.forEach(cb => cb(guestKeptIds.current))
            break
          }
          case 'req_record':
            hostProcessGuestRecord(msg.category, guestDiceFinals.current)
            break
          case 'staging':
            stagingCbs.current.forEach(cb => cb(msg.effectId))
            break
          case 'cup_thrown':
            cupThrownCbs.current.forEach(cb => cb())
            break
          case 'cup_released':
            cupReleasedCbs.current.forEach(cb => cb())
            break
          case 'log':
            logCbs.current.forEach(cb => cb(msg.role, msg.startedAt, msg.entries))
            break
          case 'chat':
            break
        }
      } else {
        // ゲスト：ホストからの通知を受けて GameScene を更新
        const msg = raw as HostToGuest
        switch (msg.type) {
          case 'game_start':
            isTurnMineRef.current = false  // ホスト先攻
            turnChangeCbs.current.forEach(cb => cb(false))  // ゲストの初期ターンを「相手ターン」に設定
            break
          case 'game_reset':
            isTurnMineRef.current = false  // ホスト先攻
            gameResetCbs.current.forEach(cb => cb())
            break
          case 'turn_start': {
            const mine = msg.turn === 'guest'
            isTurnMineRef.current = mine
            turnChangeCbs.current.forEach(cb => cb(mine))
            break
          }
          case 'roll_result': {
            rollResultCbs.current.forEach(cb => cb({
              finals:        msg.finalValues as DieValue[],
              displayValues: msg.displayValues as DieValue[],
              effectId:      msg.effectId,
              effectVariant: msg.effectVariant,
              throwEffect:   msg.throwEffect ?? 'none',
              confidenceSE:  msg.confidenceSE ?? 'none',
              keptIds:       msg.keptIds,
              rollsLeft:     msg.rollsLeft,
            }))
            break
          }
          case 'keep_update':
            keepUpdateCbs.current.forEach(cb => cb(msg.keptIds))
            break
          case 'score_recorded': {
            const [mySheet, oppSheet] = [
              msg.guestSheet as ScoreSheet,
              msg.hostSheet  as ScoreSheet,
            ]
            scoreUpdateCbs.current.forEach(cb =>
              cb(msg.by === 'guest' ? 'me' : 'opponent',
                msg.category, msg.points, mySheet, oppSheet)
            )
            break
          }
          case 'game_over': {
            const myTotal  = msg.guestTotal
            const oppTotal = msg.hostTotal
            const winner   = msg.winner === 'guest' ? 'me' : msg.winner === 'host' ? 'opponent' : 'draw'
            gameOverCbs.current.forEach(cb => cb(myTotal, oppTotal, winner as 'me'|'opponent'|'draw'))
            break
          }
          case 'staging':
            stagingCbs.current.forEach(cb => cb(msg.effectId))
            break
          case 'cup_thrown':
            cupThrownCbs.current.forEach(cb => cb())
            break
          case 'cup_released':
            cupReleasedCbs.current.forEach(cb => cb())
            break
        }
      }
    }
    return () => { clearInterval(pingTimer); clearInterval(watchTimer) }
  }, [role, hostProcessGuestRoll, hostProcessGuestRecord])

  // ── 公開 API ─────────────────────────────────────────

  const notifyRoll = useCallback((
    finals: DieValue[], displayValues: DieValue[],
    effectId: string, effectVariant: string,
    keptIds: number[], rollsLeft: number,
    throwEffect: string, confidenceSE: string,
  ) => {
    if (role !== 'host') return
    // notifyRoll はホスト自身のターンでのみ呼ばれる（ゲストロールは hostProcessGuestRoll が直接送信）。
    peerConnection.send({
      type: 'roll_result', turn: 'host', rollsLeft,
      finalValues: finals, displayValues, keptIds,
      effectId, effectVariant, displayRank: getDisplayRank(finals), throwEffect, confidenceSE,
    } satisfies HostToGuest)
  }, [role])

  const notifyKeep = useCallback((keptIds: number[]) => {
    if (role !== 'host') return
    peerConnection.send({ type: 'keep_update', keptIds } satisfies HostToGuest)
  }, [role])

  const notifyRecord = useCallback((
    category: Category, points: number,
    playerSheet: ScoreSheet, opponentSheet: ScoreSheet,
  ) => {
    if (role !== 'host') return
    hostSheetRef.current = playerSheet
    const scoreMsg: MsgScoreRecorded = {
      type: 'score_recorded', by: 'host', category, points,
      hostSheet:  playerSheet  as Record<Category, number | null>,
      guestSheet: opponentSheet as Record<Category, number | null>,
    }
    peerConnection.send(scoreMsg)

    const hostDone  = isSheetFull(playerSheet)
    const guestDone = isSheetFull(opponentSheet)
    if (hostDone && guestDone) return  // game_over は GameScene 側で notifyGameOver を呼ぶ

    // 次ターン（ゲスト）
    isTurnMineRef.current = false
    turnChangeCbs.current.forEach(cb => cb(false))   // ホスト自身の GameScene を「相手ターン」へ
    guestKeptIds.current  = []
    peerConnection.send({ type: 'turn_start', turn: 'guest', rollsLeft: 3 } satisfies HostToGuest)
  }, [role])

  const notifyGameOver = useCallback((playerTotal: number, opponentTotal: number) => {
    if (role !== 'host') return
    const winner = playerTotal > opponentTotal ? 'host' : opponentTotal > playerTotal ? 'guest' : 'draw'
    peerConnection.send({ type: 'game_over', hostTotal: playerTotal, guestTotal: opponentTotal, winner } satisfies HostToGuest)
  }, [role])

  const notifyGameReset = useCallback(() => {
    if (role !== 'host') return
    hostSheetRef.current    = emptySheet()
    guestSheetRef.current   = emptySheet()
    guestKeptIds.current    = []
    guestDiceFinals.current = [1, 1, 1, 1, 1] as DieValue[]
    isTurnMineRef.current   = true   // ホスト先攻
    peerConnection.send({ type: 'game_reset' } satisfies HostToGuest)
    peerConnection.send({ type: 'turn_start', turn: 'host', rollsLeft: 3 } satisfies HostToGuest)
  }, [role])

  const requestRoll = useCallback(() => {
    if (role !== 'guest') return
    peerConnection.send({ type: 'req_roll' } satisfies GuestToHost)
  }, [role])

  const requestKeep = useCallback((dieId: number, kept: boolean) => {
    if (role !== 'guest') return
    peerConnection.send({ type: 'req_keep', dieId, kept } satisfies GuestToHost)
  }, [role])

  const requestRecord = useCallback((category: Category) => {
    if (role !== 'guest') return
    peerConnection.send({ type: 'req_record', category } satisfies GuestToHost)
  }, [role])

  // staging トリガー通知: アクティブプレイヤーが演出を起動したとき相手へ送る（双方向）
  const notifyStaging = useCallback((effectId: string) => {
    peerConnection.send({ type: 'staging', effectId })
  }, [])

  // カップ投入開始通知: アクティブプレイヤーがカップをクリックした瞬間に相手へ送る（双方向）
  const notifyCupThrown = useCallback(() => {
    peerConnection.send({ type: 'cup_thrown' })
  }, [])

  // カップ解放通知: アクティブプレイヤーがポインタを離した瞬間に相手へ送る（双方向）
  const notifyCupReleased = useCallback(() => {
    peerConnection.send({ type: 'cup_released' })
  }, [])

  // プレイログ送信（主にゲスト→ホスト。送信側の role を自動付与）
  const sendLog = useCallback((startedAt: string, entries: unknown[]) => {
    peerConnection.send({ type: 'log', role, startedAt, entries } satisfies MsgLog)
  }, [role])

  const sub = <T,>(set: Set<T>) => (cb: T) => {
    set.add(cb)
    return () => { set.delete(cb) }
  }

  return {
    role,
    isMyTurn: () => isTurnMineRef.current,
    notifyRoll, notifyKeep, notifyRecord, notifyGameOver, notifyGameReset, notifyStaging, notifyCupThrown, notifyCupReleased,
    sendLog,
    requestRoll, requestKeep, requestRecord,
    onRollResult:  sub(rollResultCbs.current),
    onKeepUpdate:  sub(keepUpdateCbs.current),
    onScoreUpdate: sub(scoreUpdateCbs.current),
    onTurnChange:  sub(turnChangeCbs.current),
    onGameOver:    sub(gameOverCbs.current),
    onGameReset:   sub(gameResetCbs.current),
    onStaging:      sub(stagingCbs.current),
    onCupThrown:    sub(cupThrownCbs.current),
    onCupReleased:  sub(cupReleasedCbs.current),
    onLog:          sub(logCbs.current),
    onPeerDisconnected: sub(disconnectCbs.current),
  }
}

// ── ユーティリティ ────────────────────────────────────

function emptySheet(): ScoreSheet {
  return {
    ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
    choice: null, fourOfAKind: null, fullHouse: null,
    smallStraight: null, largeStraight: null, yacht: null,
  }
}

function isSheetFull(sheet: ScoreSheet): boolean {
  return Object.values(sheet).every(v => v !== null)
}
