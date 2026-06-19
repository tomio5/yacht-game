import { CanvasTexture } from 'three'
import type { DieValue } from '../game/types'

export const DOT_POSITIONS: Record<DieValue, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.75, 0.25], [0.25, 0.75]],
  3: [[0.75, 0.25], [0.5,  0.5 ], [0.25, 0.75]],
  4: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
  5: [[0.25, 0.25], [0.75, 0.25], [0.5,  0.5 ], [0.25, 0.75], [0.75, 0.75]],
  6: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.5 ], [0.75, 0.5 ], [0.25, 0.75], [0.75, 0.75]],
}

// BoxGeometry マテリアル順: +X, -X, +Y, -Y, +Z, -Z → 出目
export const MATERIAL_FACE_VALUES: DieValue[] = [3, 4, 1, 6, 2, 5]

export function createFaceTexture(value: DieValue): CanvasTexture {
  const S = 256
  const canvas = document.createElement('canvas')
  canvas.width = S; canvas.height = S
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fffdf5'
  ctx.fillRect(0, 0, S, S)
  ctx.fillStyle = value === 1 ? '#cc2200' : '#2a1a0e'
  const r = S * 0.09
  for (const [x, y] of DOT_POSITIONS[value]) {
    ctx.beginPath()
    ctx.arc(x * S, y * S, r, 0, Math.PI * 2)
    ctx.fill()
  }
  return new CanvasTexture(canvas)
}
