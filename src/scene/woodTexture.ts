/**
 * woodTexture.ts — 背景の床用「ダークウォルナット」木目テクスチャ（procedural / canvas）
 * カップの茶色よりはっきり暗くして、カップ・緑フェルト・浮遊ダイスを際立たせる。
 */
import { CanvasTexture, SRGBColorSpace, RepeatWrapping } from 'three'

export function createWoodTexture(): CanvasTexture {
  const S = 512
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const x = cv.getContext('2d')!

  // ベース（暗い木地）
  const g = x.createLinearGradient(0, 0, S, S)
  g.addColorStop(0,   '#241509')
  g.addColorStop(0.5, '#1c1006')
  g.addColorStop(1,   '#28190d')
  x.fillStyle = g
  x.fillRect(0, 0, S, S)

  // 縦方向の波打つ木目
  for (let i = 0; i < 95; i++) {
    const baseX = Math.random() * S
    const amp   = 4 + Math.random() * 14
    const freq  = 0.5 + Math.random() * 1.6
    const dark  = Math.random() < 0.5
    x.strokeStyle = dark
      ? `rgba(8,5,2,${0.10 + Math.random() * 0.20})`
      : `rgba(96,66,38,${0.05 + Math.random() * 0.12})`
    x.lineWidth = 0.5 + Math.random() * 2
    x.beginPath()
    for (let y = 0; y <= S; y += 8) {
      const xx = baseX + Math.sin((y / S) * Math.PI * freq + i) * amp
      if (y === 0) x.moveTo(xx, y)
      else         x.lineTo(xx, y)
    }
    x.stroke()
  }

  // 節（knot）を少し
  for (let i = 0; i < 4; i++) {
    const cx = Math.random() * S
    const cy = Math.random() * S
    for (let r = 2; r < 14; r += 2) {
      x.strokeStyle = 'rgba(6,4,2,0.13)'
      x.lineWidth = 1
      x.beginPath()
      x.ellipse(cx, cy, r, r * 1.6, 0, 0, Math.PI * 2)
      x.stroke()
    }
  }

  const tex = new CanvasTexture(cv)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.repeat.set(8, 8)
  return tex
}
