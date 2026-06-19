import { useEffect, useRef, useState } from 'react'
import { peerConnection } from './PeerConnection'

const params      = new URLSearchParams(window.location.search)
const connectToId = params.get('connect_to')   // あればゲスト、なければホスト
const isGuest     = connectToId !== null

export function NetTestPanel() {
  const [myId, setMyId]           = useState<string>('')
  const [status, setStatus]       = useState<'init' | 'ready' | 'connected' | 'error'>('init')
  const [inputText, setInputText] = useState('')
  const [log, setLog]             = useState<string[]>([])
  const [errorMsg, setErrorMsg]   = useState('')
  const initialized               = useRef(false)

  const addLog = (msg: string) => setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    peerConnection.onConnected    = () => { setStatus('connected'); addLog('✅ 接続成功') }
    peerConnection.onDisconnected = () => { setStatus('ready');     addLog('❌ 切断されました') }
    peerConnection.onData         = (data) => { addLog(`📨 受信: ${JSON.stringify(data)}`) }

    addLog(`役割: ${isGuest ? 'ゲスト' : 'ホスト'}`)
    addLog('シグナリングサーバーに接続中…（初回は最大50秒）')

    peerConnection.init()
      .then((id) => {
        setMyId(id)
        setStatus('ready')
        addLog(`✅ 自分のID取得: ${id}`)

        if (isGuest && connectToId) {
          addLog(`🔗 ホストへ自動接続 → ${connectToId}`)
          peerConnection.connectTo(connectToId)
        }
      })
      .catch((err) => {
        setStatus('error')
        setErrorMsg(String(err))
        addLog(`🚨 エラー: ${err}`)
      })
  }, [])

  const handleSend = () => {
    if (!inputText.trim()) return
    const msg = { type: 'test', text: inputText.trim() }
    peerConnection.send(msg)
    addLog(`📤 送信: ${JSON.stringify(msg)}`)
    setInputText('')
  }

  const inviteLink = myId
    ? `${window.location.origin}${window.location.pathname}?nettest=1&connect_to=${myId}`
    : ''

  const s: Record<string, React.CSSProperties> = {
    panel: {
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: '#111', color: '#eee',
      fontFamily: 'monospace', fontSize: 14,
      display: 'flex', flexDirection: 'column', gap: 12,
      padding: 24, boxSizing: 'border-box',
    },
    row: { display: 'flex', gap: 8, alignItems: 'center' },
    input: {
      background: '#222', color: '#eee', border: '1px solid #555',
      borderRadius: 4, padding: '6px 10px', fontSize: 14, flex: 1,
    },
    btn: {
      background: '#2a6', color: '#fff', border: 'none',
      borderRadius: 4, padding: '6px 16px', cursor: 'pointer', fontSize: 14,
    },
    btnDisabled: {
      background: '#444', color: '#888', border: 'none',
      borderRadius: 4, padding: '6px 16px', fontSize: 14, cursor: 'default',
    },
    logBox: {
      flex: 1, background: '#1a1a1a', border: '1px solid #333',
      borderRadius: 4, padding: 12, overflowY: 'auto',
      display: 'flex', flexDirection: 'column', gap: 4,
    },
    badge: (color: string) => ({
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      background: color, color: '#fff', fontSize: 12, marginLeft: 8,
    }),
  }

  const statusColor = { init: '#888', ready: '#28a', connected: '#2a6', error: '#c33' }[status]
  const statusLabel = { init: '初期化中', ready: '待機中', connected: '接続済み', error: 'エラー' }[status]
  const roleColor   = isGuest ? '#a60' : '#28a'
  const roleLabel   = isGuest ? 'GUEST' : 'HOST'

  return (
    <div style={s.panel}>
      <div style={{ fontSize: 18, fontWeight: 'bold' }}>
        🔌 PeerJS 接続テスト
        <span style={s.badge(roleColor)}>{roleLabel}</span>
        <span style={s.badge(statusColor)}>{statusLabel}</span>
      </div>

      {errorMsg && <div style={{ color: '#f66' }}>エラー: {errorMsg}</div>}

      {/* ホスト: 招待リンクを表示 */}
      {!isGuest && (
        <div style={s.row}>
          <span style={{ minWidth: 90 }}>招待リンク：</span>
          <span style={{ ...s.input, wordBreak: 'break-all', cursor: 'text', userSelect: 'all', opacity: myId ? 1 : 0.4 }}>
            {inviteLink || '取得中…'}
          </span>
          <button
            style={myId ? s.btn : s.btnDisabled}
            disabled={!myId}
            onClick={() => { navigator.clipboard.writeText(inviteLink); addLog('📋 招待リンクをコピーしました') }}
          >
            コピー
          </button>
        </div>
      )}

      {/* ゲスト: 接続先を表示 */}
      {isGuest && (
        <div style={s.row}>
          <span style={{ minWidth: 90 }}>接続先：</span>
          <span style={{ ...s.input, opacity: 0.7 }}>{connectToId}</span>
        </div>
      )}

      <div style={s.row}>
        <span style={{ minWidth: 90 }}>メッセージ：</span>
        <input
          style={s.input}
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          placeholder="送信するテキスト（Enter で送信）"
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          disabled={status !== 'connected'}
        />
        <button
          style={status === 'connected' ? s.btn : s.btnDisabled}
          onClick={handleSend}
          disabled={status !== 'connected'}
        >
          送信
        </button>
      </div>

      <div style={s.logBox}>
        {log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  )
}
