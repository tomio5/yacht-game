import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// StrictMode は外す: 開発時の二重マウントが @react-three/rapier の
// ワールド二重ステップ（recursive use / フリーズ）を誘発するため。
createRoot(document.getElementById('root')!).render(
  <App />,
)
