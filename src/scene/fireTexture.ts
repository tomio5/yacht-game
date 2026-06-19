/**
 * fireTexture.ts — 炎 cover 用テクスチャ（canvas 生成）
 * 火炎放射器のような放射状グラデ（縦伸ばしなし・中心が白く外側へ橙→赤→透明）。
 */
import { CanvasTexture } from 'three'

export function createFlameTexture(): CanvasTexture {
  const s = 128
  const cv = document.createElement('canvas')
  cv.width = s; cv.height = s
  const g = cv.getContext('2d')!
  g.clearRect(0, 0, s, s)

  // 中心から放射状（縦伸ばしなし）。白熱コア→橙→赤→透明
  const rg = g.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s * 0.5)
  rg.addColorStop(0.00, 'rgba(255,255,245,1)')
  rg.addColorStop(0.18, 'rgba(255,225,80,0.97)')
  rg.addColorStop(0.45, 'rgba(255,95,15,0.78)')
  rg.addColorStop(0.75, 'rgba(200,25,5,0.30)')
  rg.addColorStop(1.00, 'rgba(90,0,0,0)')
  g.fillStyle = rg
  g.beginPath()
  g.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2)
  g.fill()

  const tex = new CanvasTexture(cv)
  tex.needsUpdate = true
  return tex
}
