import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'

export class PeerConnection {
  peer: Peer | null = null
  conn: DataConnection | null = null
  myId: string = ''
  onData: (data: unknown) => void = () => {}
  onConnected: () => void = () => {}
  onDisconnected: () => void = () => {}

  init(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.peer = new Peer({
        host: 'yacht-signaling-server.onrender.com',
        secure: true,
        port: 443,
      })
      this.peer.on('open', (id) => {
        this.myId = id
        resolve(id)
      })
      this.peer.on('connection', (conn) => {
        this.setupConnection(conn)
      })
      this.peer.on('error', (err) => {
        reject(err)
      })
    })
  }

  connectTo(remoteId: string) {
    if (!this.peer) return
    const conn = this.peer.connect(remoteId)
    this.setupConnection(conn)
  }

  private setupConnection(conn: DataConnection) {
    this.conn = conn
    conn.on('open', () => this.onConnected())
    conn.on('data', (data) => this.onData(data))
    conn.on('close', () => this.onDisconnected())
    // DataConnection 自体のエラー（ICE 断など close が来ないケース）も切断として扱う
    conn.on('error', () => this.onDisconnected())
    // タブ閉じ等の突然切断では close が発火しない/数十秒遅れることがあるため、ICE 状態でも検知する
    conn.on('iceStateChanged', (state) => {
      if (state === 'disconnected' || state === 'failed' || state === 'closed') this.onDisconnected()
    })
  }

  send(data: unknown) {
    this.conn?.send(data)
  }

  destroy() {
    this.conn?.close()
    this.peer?.destroy()
    this.peer = null
    this.conn = null
    this.myId = ''
  }
}

export const peerConnection = new PeerConnection()
