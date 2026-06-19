/**
 * NetGameWrapper.tsx — PeerJS 接続を確立してから GameScene を起動する
 * ?netgame=1 で表示。接続前はロビー画面、接続後は GameScene（netMode 付き）。
 */

import { useEffect, useRef, useState } from 'react'
import { peerConnection } from './PeerConnection'
import { useNetMode } from './useNetMode'
import { GameScene } from '../scene/GameScene'

const params      = new URLSearchParams(window.location.search)
const connectToId = params.get('connect_to')
const role        = connectToId === null ? 'host' : 'guest'

export function NetGameWrapper() {
  const [status, setStatus]   = useState<'init' | 'ready' | 'connected'>('init')
  const [myId, setMyId]       = useState('')
  const [log, setLog]         = useState<string[]>([])
  const initialized           = useRef(false)

  const addLog = (msg: string) => setLog(l => [...l, msg])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    peerConnection.onConnected    = () => { setStatus('connected'); addLog('✅ 接続成功 — ゲームを開始します') }
    peerConnection.onDisconnected = () => { addLog('❌ 切断されました') }

    addLog(`役割: ${role === 'host' ? 'HOST（招待する側）' : 'GUEST（招待された側）'}`)
    addLog('サーバーに接続中…（初回は最大50秒）')

    peerConnection.init().then(id => {
      setMyId(id)
      setStatus('ready')
      addLog(`ID取得完了`)
      if (role === 'guest' && connectToId) {
        addLog('ホストへ接続中…')
        peerConnection.connectTo(connectToId)
      }
    }).catch(e => addLog(`エラー: ${e}`))
  }, [])

  if (status === 'connected') {
    return <ConnectedGame role={role as 'host' | 'guest'} />
  }

  const inviteLink = myId
    ? `${location.origin}${location.pathname}?net3d=1&connect_to=${myId}`
    : ''

  return (
    <div style={lobbyStyle}>
      <h2 style={{ margin: 0 }}>🎲 ヨット — フレンド対戦</h2>
      <div style={{ color: '#aaa', fontSize: 13 }}>
        役割: <b style={{ color: role === 'host' ? '#4af' : '#fa4' }}>{role.toUpperCase()}</b>
        　状態: <b>{status === 'init' ? '初期化中' : '待機中'}</b>
      </div>

      {role === 'host' && inviteLink && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ color: '#8f8', fontSize: 13 }}>友達にこのリンクを送ってください：</div>
          <div style={{
            background: '#1a2a1a', border: '1px solid #2a4a2a',
            borderRadius: 6, padding: '8px 12px',
            fontSize: 12, wordBreak: 'break-all', userSelect: 'all',
          }}>
            {inviteLink}
          </div>
          <button
            style={btnStyle}
            onClick={() => { navigator.clipboard.writeText(inviteLink) }}
          >
            リンクをコピー
          </button>
        </div>
      )}

      {role === 'guest' && status === 'ready' && (
        <div style={{ color: '#fa4' }}>ホストへ接続中…</div>
      )}

      <div style={logBoxStyle}>
        {log.map((l, i) => <div key={i} style={{ fontSize: 12 }}>{l}</div>)}
      </div>
    </div>
  )
}

function ConnectedGame({ role }: { role: 'host' | 'guest' }) {
  const netMode = useNetMode(role)

  // ホスト：接続時にゲーム開始を通知
  useEffect(() => {
    if (role === 'host') {
      peerConnection.send({ type: 'game_start', hostGoesFirst: true })
    }
  }, [role])

  return <GameScene netMode={netMode} />
}

// ── スタイル ─────────────────────────────────────────────

const lobbyStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: '#111', color: '#eee',
  fontFamily: 'sans-serif',
  display: 'flex', flexDirection: 'column', gap: 16,
  alignItems: 'center', justifyContent: 'center',
  padding: 32, boxSizing: 'border-box',
}
const btnStyle: React.CSSProperties = {
  background: '#2a6', color: '#fff', border: 'none',
  borderRadius: 6, padding: '8px 24px', cursor: 'pointer', fontSize: 14,
  alignSelf: 'flex-start',
}
const logBoxStyle: React.CSSProperties = {
  width: '100%', maxWidth: 480,
  background: '#1a1a1a', border: '1px solid #333',
  borderRadius: 6, padding: 12,
  display: 'flex', flexDirection: 'column', gap: 3,
  maxHeight: 200, overflowY: 'auto',
}
