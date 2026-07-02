/**
 * TitleScreen.tsx — タイトル画面＋フレンド対戦ロビー
 *
 * デフォルト画面（パラメータなし or ?connect_to=ID）でこれを表示する。
 * 背後に暗くした 3D ゲーム画面（CPU・操作不可）を敷き、リザルト画面風の
 * ダークオーバーレイにタイトル「リアルヨット」とボタンを重ねる。
 *
 * フロー:
 *   HOST（connect_to なし）:
 *     home → [URLを生成]押下 → hosting（招待URL表示・接続待ち）
 *          → ゲスト接続で ready（[ゲーム開始]）
 *     home には [ひとりで遊ぶ（CPU）] も置き、既存ソロ対戦を残す。
 *   GUEST（connect_to あり）:
 *     connecting（自動接続）→ 接続成立で ready（[ゲーム開始]）
 *   両者:
 *     ready で [ゲーム開始] → {type:'ready'} を送信。自分と相手の両方が
 *     ready になった時点で対戦開始（NetGame をマウント）。
 */

import { useEffect, useRef, useState } from 'react'
import { peerConnection } from './PeerConnection'
import { useNetMode } from './useNetMode'
import { GameScene } from '../scene/GameScene'

const params      = new URLSearchParams(window.location.search)
const connectToId = params.get('connect_to')
const role: 'host' | 'guest' = connectToId === null ? 'host' : 'guest'

export function TitleScreen() {
  // null=ロビー / 'solo'=CPU対戦（オーバーレイ除去のみ）/ 'net'=フレンド対戦
  const [started, setStarted] = useState<null | 'solo' | 'net'>(null)

  if (started === 'net') return <NetGame role={role} />

  // ロビー & ソロは同じ CPU GameScene を共有。ソロはオーバーレイを外すだけ。
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <GameScene />
      {started !== 'solo' && (
        <Lobby
          role={role}
          onSolo={() => setStarted('solo')}
          onNetStart={() => setStarted('net')}
        />
      )}
    </div>
  )
}

// ── 対戦本体（接続確立後） ───────────────────────────────
function NetGame({ role }: { role: 'host' | 'guest' }) {
  const netMode = useNetMode(role)
  useEffect(() => {
    // ホスト先攻。ゲストの useNetMode が game_start を受けてターンを設定する。
    if (role === 'host') peerConnection.send({ type: 'game_start', hostGoesFirst: true })
  }, [role])
  return <GameScene netMode={netMode} />
}

// ── ロビー（タイトルオーバーレイ） ──────────────────────
type LobbyPhase = 'home' | 'hosting' | 'connecting' | 'ready'

function Lobby({ role, onSolo, onNetStart }: {
  role: 'host' | 'guest'
  onSolo: () => void
  onNetStart: () => void
}) {
  const [phase, setPhase]     = useState<LobbyPhase>(role === 'host' ? 'home' : 'connecting')
  const [myId, setMyId]       = useState('')
  const [copied, setCopied]   = useState(false)
  const [waiting, setWaiting] = useState(false)   // 自分は ready、相手待ち
  const [err, setErr]         = useState('')

  const iAmReady   = useRef(false)
  const peerReady  = useRef(false)
  const started    = useRef(false)
  const peerInited = useRef(false)
  const aliveRef   = useRef(true)
  // ready 再送タイマー: 1回きりの送信だと紛失時に両者「相手待ち」で永久停止（デッドロック）するため、
  // 開始が成立するまで 2 秒毎に再送する。受信側は冪等（peerReady=true の重複代入）なので安全。
  const readyResendRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopReadyResend = () => {
    if (readyResendRef.current) { clearInterval(readyResendRef.current); readyResendRef.current = null }
  }

  const tryStart = () => {
    if (started.current) return
    if (iAmReady.current && peerReady.current) {
      started.current = true
      stopReadyResend()
      onNetStart()
    }
  }

  // ロビー中は onData/onConnected をロビーが所有（NetGame マウント時に useNetMode が上書き）
  useEffect(() => {
    aliveRef.current = true
    peerConnection.onData = (raw) => {
      const msg = raw as { type?: string }
      if (msg?.type === 'ready') {
        // エコー: 相手の ready を「初めて」受けたとき、自分が ready 済みならもう一度返す。
        // 相手が自分の ready を取りこぼしていた場合の即時回復（初回のみ返すのでピンポンしない）。
        const firstReceipt = !peerReady.current
        peerReady.current = true
        if (firstReceipt && iAmReady.current && !started.current) peerConnection.send({ type: 'ready' })
        tryStart()
      }
    }
    peerConnection.onConnected = () => { if (aliveRef.current) setPhase('ready') }
    peerConnection.onDisconnected = () => { if (aliveRef.current) setErr('相手との接続が切れました') }
    return () => { aliveRef.current = false; stopReadyResend() }
  }, [])

  // ゲスト: マウント即・初期化＆ホストへ接続
  useEffect(() => {
    if (role !== 'guest' || peerInited.current) return
    peerInited.current = true
    peerConnection.init()
      .then(() => { if (connectToId) peerConnection.connectTo(connectToId) })
      .catch(e => setErr(`接続エラー: ${e}`))
  }, [])

  const hostGenerate = () => {
    if (peerInited.current) return
    peerInited.current = true
    setPhase('hosting')
    peerConnection.init()
      .then(id => { if (aliveRef.current) setMyId(id) })
      .catch(e => setErr(`サーバー接続エラー: ${e}`))
  }

  const clickReady = () => {
    if (iAmReady.current) return
    iAmReady.current = true
    setWaiting(true)
    peerConnection.send({ type: 'ready' })
    // 開始成立まで 2 秒毎に再送（tryStart 成功 or アンマウントで停止）
    readyResendRef.current = setInterval(() => {
      if (started.current) { stopReadyResend(); return }
      peerConnection.send({ type: 'ready' })
    }, 2000)
    tryStart()
  }

  const inviteLink = myId ? `${location.origin}${location.pathname}?connect_to=${myId}` : ''
  const copyLink = () => {
    navigator.clipboard.writeText(inviteLink).then(() => {
      setCopied(true)
      setTimeout(() => aliveRef.current && setCopied(false), 1500)
    })
  }

  return (
    <div style={overlayStyle}>
     <div style={contentStyle}>
      <div style={titleStyle}>リアルヨット</div>
      <div style={subtitleStyle}>REAL YACHT</div>

      <div style={panelStyle}>
        {err && <div style={{ color: '#ff8080', fontSize: 14 }}>{err}</div>}

        {/* HOST: ホーム（URL生成 or ソロ） */}
        {phase === 'home' && (
          <>
            <button style={primaryBtn} onClick={hostGenerate}>
              対戦URLを生成して招待
            </button>
            <button style={ghostBtn} onClick={onSolo}>
              ひとりで遊ぶ（CPU対戦）
            </button>
          </>
        )}

        {/* HOST: 招待URL表示・接続待ち */}
        {phase === 'hosting' && (
          <>
            <div style={hintStyle}>友達にこのURLを送ってください</div>
            <div style={urlBoxStyle}>{inviteLink || 'URLを生成中…（初回は最大50秒）'}</div>
            <button style={primaryBtn} disabled={!inviteLink} onClick={copyLink}>
              {copied ? 'コピーしました ✓' : 'URLをコピー'}
            </button>
            <div style={waitStyle}>相手の接続を待っています…</div>
          </>
        )}

        {/* GUEST: 接続中 */}
        {phase === 'connecting' && (
          <div style={waitStyle}>ホストに接続中…（初回は最大50秒）</div>
        )}

        {/* 両者: 接続成立 → ゲーム開始 */}
        {phase === 'ready' && (
          <>
            {waiting ? (
              <div style={waitStyle}>相手の準備を待っています…</div>
            ) : (
              <button style={primaryBtn} onClick={clickReady}>
                ゲーム開始
              </button>
            )}
          </>
        )}
      </div>
     </div>
    </div>
  )
}

// ── スタイル ─────────────────────────────────────────────
const overlayStyle: React.CSSProperties = {
  position: 'absolute', inset: 0,
  background: 'rgba(0,0,0,0.78)',
  color: '#fff', fontFamily: 'sans-serif',
}
// コンテンツ下端を画面中央のすぐ上にアンカー（中央バナーと被らない）
const contentStyle: React.CSSProperties = {
  position: 'absolute', left: 0, right: 0, bottom: '52%',
  display: 'flex', flexDirection: 'column',
  alignItems: 'center', gap: 4, paddingBottom: 16,
}
const titleStyle: React.CSSProperties = {
  fontSize: 'clamp(52px, 9vw, 100px)', fontWeight: 800, letterSpacing: 6,
  color: '#cdf7ff',
  WebkitTextStroke: '1.6px #39d9ff',
  paintOrder: 'stroke',
  textShadow: '0 0 8px #39d9ff, 0 0 20px #1aa3ff, 0 0 40px #1166cc',
  lineHeight: 1.15,
}
const subtitleStyle: React.CSSProperties = {
  fontSize: 16, letterSpacing: 12, color: '#cdf7ff', fontWeight: 600,
  textShadow: '0 0 6px #39d9ff, 0 0 14px #1aa3ff', marginBottom: 30, textIndent: 12,
}
const panelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12,
  alignItems: 'center', minWidth: 280, maxWidth: 520, width: '90%',
}
const primaryBtn: React.CSSProperties = {
  background: 'linear-gradient(180deg, #f5b942, #d98a1f)', color: '#3a2606',
  border: 'none', borderRadius: 10, padding: '14px 36px',
  cursor: 'pointer', fontSize: 18, fontWeight: 700,
  boxShadow: '0 4px 16px rgba(0,0,0,0.4)', width: '100%',
}
const ghostBtn: React.CSSProperties = {
  background: 'transparent', color: '#cbb890',
  border: '1px solid #6a5a3a', borderRadius: 10, padding: '11px 28px',
  cursor: 'pointer', fontSize: 14, width: '100%',
}
const hintStyle: React.CSSProperties = { color: '#8fd88f', fontSize: 13 }
const urlBoxStyle: React.CSSProperties = {
  background: '#16170f', border: '1px solid #3a3520', borderRadius: 8,
  padding: '10px 14px', fontSize: 12, wordBreak: 'break-all',
  userSelect: 'all', color: '#e8e0c0', width: '100%', boxSizing: 'border-box',
}
const waitStyle: React.CSSProperties = { color: '#e0c98a', fontSize: 15, padding: '6px 0' }
