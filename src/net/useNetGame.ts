/**
 * useNetGame.ts — ネット対戦ゲームロジックフック
 *
 * ホスト: 乱数・演出抽選・スコア計算を担当し、結果を両者へ送信。
 * ゲスト: 操作リクエストをホストへ送り、受け取った状態を反映するだけ。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { peerConnection } from './PeerConnection'
import type {
  HostToGuest, GuestToHost,
  MsgRollResult, MsgKeepUpdate, MsgScoreRecorded, MsgGameOver,
} from './protocol'
import { rollDieValue } from '../game/dice'
import { calcCategoryScore, calcTotalScore, getDisplayRank } from '../game/scoring'
import { selectEffectFromTable } from '../game/effectTable'
import type { Category, DieValue, ScoreSheet } from '../game/types'

// ── 型 ──────────────────────────────────────────────────

const CATEGORIES: Category[] = [
  'ones','twos','threes','fours','fives','sixes',
  'choice','fourOfAKind','fullHouse','smallStraight','largeStraight','yacht',
]

const EMPTY_SHEET = (): ScoreSheet => ({
  ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
  choice: null, fourOfAKind: null, fullHouse: null,
  smallStraight: null, largeStraight: null, yacht: null,
})

export interface NetDie {
  id: number
  finalValue: DieValue
  displayValue: DieValue
  kept: boolean
}

export type NetPhase = 'waiting' | 'my_turn' | 'opp_turn' | 'game_over' | 'disconnected'

export interface NetGameState {
  phase: NetPhase
  turn: 'host' | 'guest' | null
  rollsLeft: number
  dice: NetDie[]
  mySheet: ScoreSheet
  oppSheet: ScoreSheet
  myTotal: number
  oppTotal: number
  winner: 'me' | 'opp' | 'draw' | null
  log: string[]
}

const INIT_DICE: NetDie[] = Array.from({ length: 5 }, (_, i) => ({
  id: i, finalValue: 1 as DieValue, displayValue: 1 as DieValue, kept: false,
}))

const initState = (): NetGameState => ({
  phase: 'waiting', turn: null, rollsLeft: 3,
  dice: INIT_DICE,
  mySheet: EMPTY_SHEET(), oppSheet: EMPTY_SHEET(),
  myTotal: 0, oppTotal: 0, winner: null,
  log: [],
})

// ── フック ───────────────────────────────────────────────

export function useNetGame(role: 'host' | 'guest') {
  const [state, setState] = useState<NetGameState>(initState)
  const stateRef = useRef<NetGameState>(initState())

  const set = useCallback((updater: (s: NetGameState) => NetGameState) => {
    setState(prev => {
      const next = updater(prev)
      stateRef.current = next
      return next
    })
  }, [])

  const addLog = useCallback((msg: string) => {
    set(s => ({ ...s, log: [...s.log, `[${new Date().toLocaleTimeString()}] ${msg}`] }))
  }, [set])

  // ── ホスト側ユーティリティ ────────────────────────────

  const hostSend = useCallback((msg: HostToGuest) => {
    peerConnection.send(msg)
  }, [])

  /** ホストが自分にも適用しつつゲストへ送る */
  const hostApplyAndSend = useCallback((msg: HostToGuest) => {
    hostSend(msg)
    hostApplyMsg(msg)  // eslint-disable-line @typescript-eslint/no-use-before-define
  }, [hostSend]) // eslint-disable-line react-hooks/exhaustive-deps

  // ロール処理（ホスト専用）
  const hostProcessRoll = useCallback((forTurn: 'host' | 'guest') => {
    const cur = stateRef.current
    const prevDice = cur.dice
    const newDice: NetDie[] = prevDice.map(d => {
      if (d.kept) return d
      const v = rollDieValue()
      return { ...d, finalValue: v, displayValue: v }
    })
    const finals = newDice.map(d => d.finalValue) as DieValue[]
    const rank    = getDisplayRank(finals)
    const draw    = selectEffectFromTable(rank)
    const newRollsLeft = cur.rollsLeft - 1

    const msg: MsgRollResult = {
      type: 'roll_result',
      turn: forTurn,
      rollsLeft: newRollsLeft,
      finalValues:   finals,
      displayValues: finals,   // ネット対戦ではシンプルに final=display
      keptIds: newDice.filter(d => d.kept).map(d => d.id),
      effectId: draw.effectId,
      effectVariant: draw.variant ?? '-',
      displayRank: rank,
    }
    hostApplyAndSend(msg)
  }, [hostApplyAndSend])

  // スコア記入処理（ホスト専用）
  const hostProcessRecord = useCallback((by: 'host' | 'guest', category: Category) => {
    const cur = stateRef.current
    const sheet = by === (role === 'host' ? 'host' : 'guest') ? cur.mySheet : cur.oppSheet
    if (sheet[category] !== null) { addLog('そのカテゴリは記入済み'); return }

    const fakeDice = cur.dice.map(d => ({ id: d.id, value: d.finalValue, kept: d.kept }))
    const pts = calcCategoryScore(category, fakeDice)

    // role='host': mySheet=ホスト, oppSheet=ゲスト
    const newHostSheet  = by === 'host'
      ? { ...cur.mySheet,  [category]: pts }
      : { ...cur.mySheet  }
    const newGuestSheet = by === 'guest'
      ? { ...cur.oppSheet, [category]: pts }
      : { ...cur.oppSheet }

    const msg: MsgScoreRecorded = {
      type: 'score_recorded',
      by, category, points: pts,
      hostSheet:  newHostSheet as Record<Category, number | null>,
      guestSheet: newGuestSheet as Record<Category, number | null>,
    }
    hostApplyAndSend(msg)

    // ゲーム終了判定
    const hostDone  = CATEGORIES.every(c => newHostSheet[c]  !== null)
    const guestDone = CATEGORIES.every(c => newGuestSheet[c] !== null)
    if (hostDone && guestDone) {
      const ht = calcTotalScore(newHostSheet)
      const gt = calcTotalScore(newGuestSheet)
      const winner: 'host' | 'guest' | 'draw' = ht > gt ? 'host' : gt > ht ? 'guest' : 'draw'
      const overMsg: MsgGameOver = { type: 'game_over', hostTotal: ht, guestTotal: gt, winner }
      hostApplyAndSend(overMsg)
      return
    }

    // 次のターン
    const nextTurn: 'host' | 'guest' = by === 'host' ? 'guest' : 'host'
    hostApplyAndSend({ type: 'turn_start', turn: nextTurn, rollsLeft: 3 })
  }, [role, addLog, hostApplyAndSend])

  // ── メッセージ適用（ホスト自身にも同じ処理で反映） ───

  const hostApplyMsg = useCallback((msg: HostToGuest) => {
    switch (msg.type) {
      case 'game_start':
        addLog('ゲーム開始')
        break

      case 'turn_start': {
        const isMyTurn = msg.turn === (role === 'host' ? 'host' : 'guest')
        addLog(`${msg.turn === 'host' ? 'ホスト' : 'ゲスト'}のターン`)
        set(s => ({
          ...s,
          phase: isMyTurn ? 'my_turn' : 'opp_turn',
          turn: msg.turn,
          rollsLeft: msg.rollsLeft,
          dice: INIT_DICE,
        }))
        break
      }

      case 'roll_result': {
        const newDice: NetDie[] = msg.finalValues.map((v, i) => ({
          id: i,
          finalValue: v,
          displayValue: msg.displayValues[i],
          kept: msg.keptIds.includes(i),
        }))
        addLog(`ロール: [${msg.finalValues.join(',')}] 演出:${msg.effectId} 残り:${msg.rollsLeft}回`)
        set(s => ({ ...s, dice: newDice, rollsLeft: msg.rollsLeft }))
        break
      }

      case 'keep_update': {
        set(s => ({
          ...s,
          dice: s.dice.map(d => ({ ...d, kept: msg.keptIds.includes(d.id) })),
        }))
        addLog(`キープ更新: [${msg.keptIds.join(',')}]`)
        break
      }

      case 'score_recorded': {
        const [mySheet, oppSheet] = role === 'host'
          ? [msg.hostSheet as ScoreSheet, msg.guestSheet as ScoreSheet]
          : [msg.guestSheet as ScoreSheet, msg.hostSheet as ScoreSheet]
        addLog(`${msg.by === 'host' ? 'ホスト' : 'ゲスト'}: ${msg.category} = ${msg.points}点`)
        set(s => ({
          ...s,
          mySheet, oppSheet,
          myTotal:  calcTotalScore(mySheet),
          oppTotal: calcTotalScore(oppSheet),
        }))
        break
      }

      case 'game_over': {
        const [myTotal, oppTotal] = role === 'host'
          ? [msg.hostTotal, msg.guestTotal]
          : [msg.guestTotal, msg.hostTotal]
        const winner = role === 'host'
          ? (msg.winner === 'host' ? 'me' : msg.winner === 'guest' ? 'opp' : 'draw')
          : (msg.winner === 'guest' ? 'me' : msg.winner === 'host' ? 'opp' : 'draw')
        addLog(`ゲーム終了 ホスト:${msg.hostTotal} ゲスト:${msg.guestTotal}`)
        set(s => ({ ...s, phase: 'game_over', myTotal, oppTotal, winner: winner as 'me'|'opp'|'draw' }))
        break
      }

      case 'disconnected':
        addLog('相手が切断しました')
        break
    }
  }, [role, addLog, set])

  // ── 受信ハンドラ設定 ──────────────────────────────────

  useEffect(() => {
    peerConnection.onConnected = () => {
      addLog('接続確立')
      if (role === 'host') {
        // ホストが先にゲーム開始を宣言
        setTimeout(() => {
          hostApplyAndSend({ type: 'game_start', hostGoesFirst: true })
          hostApplyAndSend({ type: 'turn_start', turn: 'host', rollsLeft: 3 })
        }, 500)
      }
    }

    peerConnection.onDisconnected = () => {
      addLog('⚠️ 相手が切断しました')
      set(s => s.phase === 'game_over' ? s : { ...s, phase: 'disconnected' })
    }

    peerConnection.onData = (raw) => {
      if (role === 'host') {
        // ゲストからのリクエストを処理
        const msg = raw as GuestToHost
        switch (msg.type) {
          case 'req_roll':
            hostProcessRoll('guest')
            break
          case 'req_keep': {
            const cur = stateRef.current
            const keptIds = cur.dice
              .map(d => ({ ...d, kept: d.id === msg.dieId ? msg.kept : d.kept }))
              .filter(d => d.kept).map(d => d.id)
            const keepMsg: MsgKeepUpdate = { type: 'keep_update', keptIds }
            hostApplyAndSend(keepMsg)
            break
          }
          case 'req_record':
            hostProcessRecord('guest', msg.category)
            break
          case 'chat':
            addLog(`💬 相手: ${msg.text}`)
            break
        }
      } else {
        // ゲスト: ホストからの状態通知を適用
        const msg = raw as HostToGuest
        if (msg.type === 'chat') { addLog(`💬 相手: ${msg.text}`); return }
        hostApplyMsg(msg)
      }
    }
  }, [role, addLog, set, hostProcessRoll, hostProcessRecord, hostApplyAndSend, hostApplyMsg])

  // ── 公開アクション ────────────────────────────────────

  /** 振るボタン押下 */
  const roll = useCallback(() => {
    const cur = stateRef.current
    if (cur.phase !== 'my_turn' || cur.rollsLeft <= 0) return
    if (role === 'host') {
      hostProcessRoll('host')
    } else {
      peerConnection.send({ type: 'req_roll' } satisfies GuestToHost)
    }
  }, [role, hostProcessRoll])

  /** ダイスのキープ/アンキープ */
  const toggleKeep = useCallback((dieId: number) => {
    const cur = stateRef.current
    if (cur.phase !== 'my_turn' || cur.rollsLeft === 3) return  // 1投前はキープ不可
    const die = cur.dice.find(d => d.id === dieId)
    if (!die) return
    if (role === 'host') {
      const keptIds = cur.dice
        .map(d => ({ ...d, kept: d.id === dieId ? !d.kept : d.kept }))
        .filter(d => d.kept).map(d => d.id)
      hostApplyAndSend({ type: 'keep_update', keptIds })
    } else {
      peerConnection.send({ type: 'req_keep', dieId, kept: !die.kept } satisfies GuestToHost)
    }
  }, [role, hostApplyAndSend])

  /** スコア記入 */
  const record = useCallback((category: Category) => {
    const cur = stateRef.current
    if (cur.phase !== 'my_turn' || cur.rollsLeft > 0) return
    if (role === 'host') {
      hostProcessRecord('host', category)
    } else {
      peerConnection.send({ type: 'req_record', category } satisfies GuestToHost)
    }
  }, [role, hostProcessRecord])

  return { state, roll, toggleKeep, record }
}
