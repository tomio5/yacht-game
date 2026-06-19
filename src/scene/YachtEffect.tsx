/**
 * YachtEffect.tsx — ヨット成立時の光の柱演出（20秒・staging テーブル外）
 *
 * タイムライン:
 *   0〜3s  (DARK_DUR)  : 暗転 dark opacity 0→0.5
 *   3〜8s  (BEAM_DUR)  : 光の柱が上から下へ降下
 *   8〜13s (BLOOM_DUR) : 柱幅拡大、dark 0.5→0 / flash 0→1（白ピーク）。13s で onCover
 *  13〜18s (FADE_DUR)  : flash 1→0、柱フェードアウト
 *  18s     : onDone
 *
 * Bloom は EffectComposer を使わず HTML div（flashOverlay）の opacity 1 で白飛びを再現。
 * onCover は flash opacity が 1.0 になった瞬間（完全に白く隠れた状態）で呼ぶ。
 */

import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending } from 'three'
import type { Mesh, ShaderMaterial } from 'three'

export const DARK_DUR   = 3.0
export const BEAM_DUR   = 5.0
export const BLOOM_DUR  = 5.0
export const FADE_DUR   = 5.0
export const YACHT_TOTAL = DARK_DUR + BEAM_DUR + BLOOM_DUR + FADE_DUR  // 18s

const BEAM_WIDTH_START = 0.4
const BEAM_WIDTH_END   = 28
const BEAM_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`
const BEAM_FRAG = /* glsl */`
  uniform float progress;
  uniform float opacity;
  varying vec2 vUv;
  void main() {
    float tipY    = 1.0 - progress;
    float filled  = smoothstep(tipY - 0.04, tipY + 0.04, vUv.y);
    float tipGlow = exp(-abs(vUv.y - tipY) * 18.0) * 2.5;
    float cx      = 1.0 - abs(vUv.x - 0.5) * 2.0;
    float bright  = clamp(cx, 0.0, 1.0);
    float edge    = max(bright * 3.5, 0.12);
    vec3  col     = mix(vec3(0.72,0.90,1.0), vec3(1.0,1.0,1.0), bright * bright);
    float a       = (filled + tipGlow) * edge * opacity;
    gl_FragColor  = vec4(col, clamp(a, 0.0, 1.0));
  }
`

interface Props {
  onDark:  (v: number) => void  // 黒オーバーレイ opacity（0→0.5→0）
  onFlash: (v: number) => void  // 白オーバーレイ opacity（0→1→0）。1.0 で完全に白く隠れる
  onCover: () => void           // flash=1.0 の瞬間に1回。finalValue 書き換えをここで
  onDone:  () => void           // 18s で完了通知
}

export function YachtEffect({ onDark, onFlash, onCover, onDone }: Props) {
  const beamRef    = useRef<Mesh>(null)
  const matRef     = useRef<ShaderMaterial>(null)
  const tRef       = useRef(0)
  const coveredRef = useRef(false)
  const doneRef    = useRef(false)

  useFrame((_, dt) => {
    if (doneRef.current) return
    tRef.current += dt
    const t  = tRef.current
    const T1 = DARK_DUR                // 3
    const T2 = T1 + BEAM_DUR          // 8
    const T3 = T2 + BLOOM_DUR         // 13 ← onCover
    const T4 = T3 + FADE_DUR          // 18 ← onDone

    let darkOp = 0, flashOp = 0, beamProg = 0, beamOp = 0
    let beamScaleX = BEAM_WIDTH_START

    if (t < T1) {
      // フェーズ1: 暗転
      darkOp = 0.5 * (t / T1)
    } else if (t < T2) {
      // フェーズ2: 柱降下
      const k = (t - T1) / BEAM_DUR
      darkOp     = 0.5
      beamProg   = k
      beamOp     = Math.min(k * 8, 1.0)
      beamScaleX = BEAM_WIDTH_START
    } else if (t < T3) {
      // フェーズ3: 柱拡大 + 白フラッシュ上昇（dark と入れ替わり）
      const k  = (t - T2) / BLOOM_DUR
      const e  = k * k * (3 - 2 * k)    // ease in-out
      darkOp     = 0.5 * (1 - e)         // dark 0.5→0
      flashOp    = e                      // flash 0→1
      beamProg   = 1.0
      beamOp     = 1.0
      beamScaleX = BEAM_WIDTH_START + (BEAM_WIDTH_END - BEAM_WIDTH_START) * e
    } else if (t < T4) {
      // フェーズ4: フェードアウト
      const k  = (t - T3) / FADE_DUR
      flashOp    = 1 - k                  // flash 1→0
      beamProg   = 1.0
      beamOp     = 1 - k
      beamScaleX = BEAM_WIDTH_END
    } else {
      // 終了
      if (!coveredRef.current) { coveredRef.current = true; onCover() }
      onDark(0); onFlash(0)
      doneRef.current = true
      onDone()
      return
    }

    // onCover: flash が 1.0 に達した瞬間（= 完全に白く隠れた = T3 直後の最初のフレーム）
    if (!coveredRef.current && t >= T3) {
      coveredRef.current = true
      onCover()
    }

    onDark(darkOp)
    onFlash(flashOp)

    if (beamRef.current) {
      beamRef.current.scale.x = beamScaleX
      beamRef.current.visible  = beamOp > 0.01
    }
    if (matRef.current) {
      matRef.current.uniforms.progress.value = beamProg
      matRef.current.uniforms.opacity.value  = beamOp
    }
  })

  return (
    // rotation.x = -1.25 rad でカメラ正面向き（camera=[0,18,6] から導出した screenUp 方向）
    <mesh
      ref={beamRef}
      position={[0, 5, 0]}
      rotation={[-1.25, 0, 0]}
      renderOrder={50}
      visible={false}
    >
      <planeGeometry args={[1, 30]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={BEAM_VERT}
        fragmentShader={BEAM_FRAG}
        uniforms={{ progress: { value: 0 }, opacity: { value: 0 } }}
        blending={AdditiveBlending}
        transparent
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  )
}
