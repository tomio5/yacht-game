/**
 * NetGamePanel.tsx — ネット対戦テスト用シンプルUI
 * ?netgame=1 で表示。3D演出なし・テキストだけでロジック確認用。
 */

import { useEffect, useRef, useState } from 'react'
import { peerConnection } from './PeerConnection'
import { useNetGame } from './useNetGame'
import type { Category } from '../game/types'

const params      = new URLSearchParams(window.location.search)
const connectToId = params.get('connect_to')
const role        = connectToId === null ? 'host' : 'guest'

const CATEGORY_LABELS: Record<Category, string> = {
  ones: 'エース', twos: 'デュース', threes: 'トレイ',
  fours: 'フォー', fives: 'ファイブ', sixes: 'シックス',
  choice: 'チョイス', fourOfAKind: 'フォーダイス',
  fullHouse: 'フルハウス', smallStraight: 'S.ストレート',
  largeStraight: 'B.ストレート', yacht: 'ヨット',
}
const CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[]

export function NetGamePanel() {
  const [ready, setReady]     = useState(false)
  const [myId, setMyId]       = useState('')
  const [initLog, setInitLog] = useState<string[]>([])
  const initialized           = useRef(false)

  // PeerJS 初期化（useNetGame より先に行う）
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    setInitLog(l => [...l, `役割: ${role === 'host' ? 'HOST' : 'GUEST'}`])
    setInitLog(l => [...l, 'サーバーに接続中…'])

    peerConnection.init().then(id => {
      setMyId(id)
      setInitLog(l => [...l, `ID取得: ${id}`])
      if (role === 'guest' && connectToId) {
        setInitLog(l => [...l, `ホストへ接続中…`])
        peerConnection.connectTo(connectToId)
      } else {
        setInitLog(l => [...l, 'ゲストの接続を待っています…'])
        setInitLog(l => [...l, `招待リンク: ${location.origin}${location.pathname}?netgame=1&connect_to=${id}`])
      }
      setReady(true)
    }).catch(e => {
      setInitLog(l => [...l, `エラー: ${e}`])
    })
  }, [])

  if (!ready) {
    return (
      <div style={panel}>
        <h2>接続準備中…</h2>
        {initLog.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    )
  }

  return <Game role={role as 'host' | 'guest'} myId={myId} initLog={initLog} />
}

function Game({ role, myId, initLog }: { role: 'host'|'guest'; myId: string; initLog: string[] }) {
  const { state, roll, toggleKeep, record } = useNetGame(role)
  const [chatInput, setChatInput] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [state.log])

  const sendChat = () => {
    if (!chatInput.trim()) return
    peerConnection.send({ type: 'chat', text: chatInput.trim() })
    setChatInput('')
  }

  const phaseLabel = {
    waiting:      '待機中',
    my_turn:      '自分のターン',
    opp_turn:     '相手のターン',
    game_over:    'ゲーム終了',
    disconnected: '切断',
  }[state.phase]

  const canRoll   = state.phase === 'my_turn' && state.rollsLeft > 0
  const canRecord = state.phase === 'my_turn' && state.rollsLeft === 0
  const isDisconnected = state.phase === 'disconnected'

  return (
    <div style={panel}>
      {/* 切断オーバーレイ */}
      {isDisconnected && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 100,
          background: 'rgba(0,0,0,0.75)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          <div style={{ fontSize: 48 }}>🔌</div>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: '#f88' }}>相手が切断しました</div>
          <div style={{ color: '#aaa', fontSize: 13 }}>ゲームを終了するか、ページを再読み込みしてください。</div>
          <button
            style={{ ...btn, background: '#444', color: '#eee', padding: '8px 24px', fontSize: 14 }}
            onClick={() => location.href = location.pathname}
          >
            トップに戻る
          </button>
        </div>
      )}

      {/* ヘッダー */}
      <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
        <b style={{ fontSize:16 }}>🎲 ネット対戦テスト</b>
        <Badge color={role==='host'?'#28a':'#a60'}>{role.toUpperCase()}</Badge>
        <Badge color={state.phase==='my_turn'?'#2a6':state.phase==='opp_turn'?'#888':'#c33'}>
          {phaseLabel}
        </Badge>
        <span style={{ color:'#888', fontSize:12 }}>残り{state.rollsLeft}回</span>
      </div>

      {/* 招待リンク（ホスト・待機中のみ） */}
      {role === 'host' && state.phase === 'waiting' && (
        <div style={{ color:'#fa0', fontSize:12, wordBreak:'break-all' }}>
          招待リンク: {`${location.origin}${location.pathname}?netgame=1&connect_to=${myId}`}
        </div>
      )}

      <div style={{ display:'flex', gap:12, flex:1, minHeight:0 }}>
        {/* 左：ダイス＋操作 */}
        <div style={{ display:'flex', flexDirection:'column', gap:10, minWidth:220 }}>
          {/* ダイス */}
          <div style={{ display:'flex', gap:6 }}>
            {state.dice.map(d => (
              <div
                key={d.id}
                onClick={() => toggleKeep(d.id)}
                style={{
                  width:48, height:48, borderRadius:8, fontSize:24,
                  display:'flex', alignItems:'center', justifyContent:'center',
                  background: d.kept ? '#2a6' : '#333',
                  border: `2px solid ${d.kept ? '#4f8' : '#555'}`,
                  cursor: state.phase === 'my_turn' && state.rollsLeft < 3 ? 'pointer' : 'default',
                  userSelect:'none',
                }}
              >
                {['','⚀','⚁','⚂','⚃','⚄','⚅'][d.displayValue]}
              </div>
            ))}
          </div>

          {/* ボタン */}
          <button
            style={{ ...btn, background: canRoll ? '#2a6' : '#444', color: canRoll ? '#fff' : '#888' }}
            onClick={roll}
            disabled={!canRoll}
          >
            🎲 振る（残り{state.rollsLeft}回）
          </button>

          {/* スコアシート */}
          <div style={{ fontSize:12, color:'#aaa' }}>スコアを記入（振り切った後）</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4 }}>
            {CATEGORIES.map(cat => {
              const myVal  = state.mySheet[cat]
              const oppVal = state.oppSheet[cat]
              const filled = myVal !== null
              const canRec = canRecord && !filled
              return (
                <div
                  key={cat}
                  onClick={() => canRec && record(cat)}
                  style={{
                    padding:'3px 6px', borderRadius:4, fontSize:11,
                    background: filled ? '#1a3a1a' : canRec ? '#1a3a5c' : '#1a1a1a',
                    border: `1px solid ${filled?'#2a6':canRec?'#48a':'#333'}`,
                    cursor: canRec ? 'pointer' : 'default',
                    display:'flex', justifyContent:'space-between',
                  }}
                >
                  <span>{CATEGORY_LABELS[cat]}</span>
                  <span style={{ color:'#8f8' }}>
                    {myVal !== null ? myVal : ''}
                    {oppVal !== null ? <span style={{ color:'#f88', marginLeft:4 }}>{oppVal}</span> : null}
                  </span>
                </div>
              )
            })}
          </div>

          {/* スコア合計 */}
          <div style={{ display:'flex', gap:8, fontSize:13 }}>
            <div style={{ color:'#8f8' }}>自分: <b>{state.myTotal}</b></div>
            <div style={{ color:'#f88' }}>相手: <b>{state.oppTotal}</b></div>
          </div>

          {/* ゲーム終了 */}
          {state.phase === 'game_over' && (
            <div style={{ fontSize:18, fontWeight:'bold', color: state.winner==='me'?'#4f8':state.winner==='opp'?'#f44':'#fa0' }}>
              {state.winner==='me'?'🎉 勝利！':state.winner==='opp'?'😢 敗北':'🤝 引き分け'}
            </div>
          )}

          {/* チャット */}
          <div style={{ display:'flex', gap:4, marginTop:'auto' }}>
            <input
              style={{ ...input, flex:1 }}
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key==='Enter' && sendChat()}
              placeholder="チャット"
            />
            <button style={{ ...btn, background:'#28a' }} onClick={sendChat}>送信</button>
          </div>
        </div>

        {/* 右：ログ */}
        <div ref={logRef} style={{ flex:1, background:'#1a1a1a', borderRadius:4, padding:10, overflowY:'auto', fontSize:11, display:'flex', flexDirection:'column', gap:3 }}>
          {[...initLog, ...state.log].map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  )
}

// ── スタイル ─────────────────────────────────────────────

const panel: React.CSSProperties = {
  position:'fixed', top:0, left:0, right:0, bottom:0, overflow:'hidden',
  background:'#111', color:'#eee', fontFamily:'monospace', fontSize:13,
  display:'flex', flexDirection:'column', gap:10, padding:16, boxSizing:'border-box',
}
const btn: React.CSSProperties = {
  border:'none', borderRadius:4, padding:'6px 12px', cursor:'pointer', fontSize:13,
}
const input: React.CSSProperties = {
  background:'#222', color:'#eee', border:'1px solid #555',
  borderRadius:4, padding:'4px 8px', fontSize:12,
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span style={{ background:color, color:'#fff', padding:'2px 8px', borderRadius:4, fontSize:11 }}>
      {children}
    </span>
  )
}
