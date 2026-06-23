import { NetTestPanel } from './net/NetTestPanel'
import { NetGamePanel } from './net/NetGamePanel'
import { TitleScreen } from './net/TitleScreen'

const params    = new URLSearchParams(window.location.search)
const isNetTest = params.has('nettest')
const isNetGame = params.has('netgame')

function App() {
  if (isNetTest) return <NetTestPanel />
  if (isNetGame) return <NetGamePanel />
  // デフォルト（パラメータなし）= ホストのタイトル画面 / ?connect_to=ID = ゲスト
  return <TitleScreen />
}

export default App
