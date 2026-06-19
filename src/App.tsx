import { GameScene } from './scene/GameScene'
import { NetTestPanel } from './net/NetTestPanel'
import { NetGamePanel } from './net/NetGamePanel'
import { NetGameWrapper } from './net/NetGameWrapper'

const params    = new URLSearchParams(window.location.search)
const isNetTest = params.has('nettest')
const isNetGame = params.has('netgame')
const isNet3D   = params.has('net3d')

function App() {
  if (isNetTest) return <NetTestPanel />
  if (isNetGame) return <NetGamePanel />
  if (isNet3D)   return <NetGameWrapper />
  return <GameScene />
}

export default App
