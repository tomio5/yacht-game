/**
 * YachtEffect.tsx — ヨット成立時の光の柱演出（staging テーブル外）
 *
 * 構成（すべてワールド座標。雷と同じ「ワールド垂直」軸で立てる）:
 *   - 光の柱   : フィールド中心に立つ垂直の円柱。上空→地面へ降下する。
 *   - 地面リング: 柱が着地した中心から円状に広がる水平リング。
 *   - 降雪粒子 : 柱降下と同時に画面全体へ雪のように降る。柱フェードと連動して消える。
 *
 * タイムライン:
 *   0〜3s  (DARK_DUR)  : 暗転 dark 0→0.5
 *   3〜8s  (BEAM_DUR)  : 柱が上から中心へ降下。降雪フェードイン。
 *   8〜13s (BLOOM_DUR) : 地面リングが円状に拡大。dark 0.5→0 / flash 0→1（白ピーク）。13s で onCover。
 *  13〜18s (FADE_DUR)  : flash 1→0。柱・リング・降雪が連動フェードアウト。
 *  18s     : onDone
 *
 * Bloom は EffectComposer を使わず HTML div（flashOverlay）の opacity 1 で白飛びを再現。
 * onCover は flash opacity が 1.0 になった瞬間（完全に白く隠れた状態）で呼ぶ。
 */

import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, DoubleSide } from 'three'
import type { Mesh, ShaderMaterial, BufferGeometry } from 'three'

export const DARK_DUR   = 3.0
export const BEAM_DUR   = 5.0
export const BLOOM_DUR  = 5.0
export const FADE_DUR   = 5.0
export const YACHT_TOTAL = DARK_DUR + BEAM_DUR + BLOOM_DUR + FADE_DUR  // 18s

// フィールド中心（集約後ダイスの重心 ≒ 原点。z はわずかに手前寄り）
const FIELD_CX = 0
const FIELD_CZ = 0.19

// 柱（垂直円柱）
const PILLAR_H    = 24        // 高さ（上空〜地面）
const PILLAR_RTOP = 1.15      // 上端半径（わずかに広げて末広がりに）
const PILLAR_RBOT = 0.55      // 下端半径

// 地面リング（水平面・円状拡大）
const GROUND_SIZE = 30        // 拡大しきったリングが収まる平面サイズ

// 降雪
const SNOW_COUNT = 240
const SNOW_X     = 24         // x: ±SNOW_X
const SNOW_ZMIN  = -18
const SNOW_ZMAX  = 24
const SNOW_YTOP  = 28
const SNOW_YBOT  = -1

// ── 柱シェーダ（円柱。上→下へ充填して降下＋先端グロー） ──
const PILLAR_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`
const PILLAR_FRAG = /* glsl */`
  uniform float progress;   // 0=未降下, 1=地面まで充填
  uniform float opacity;
  varying vec2 vUv;
  void main() {
    float tipY    = 1.0 - progress;                              // 降りてくる先端の高さ（1=上端,0=地面）
    float lit     = smoothstep(tipY - 0.03, tipY + 0.03, vUv.y); // 先端より上が点灯
    float tipGlow = exp(-abs(vUv.y - tipY) * 15.0) * 1.8;        // 先端の強い光
    vec3  col     = mix(vec3(0.72,0.90,1.0), vec3(1.0,1.0,1.0), clamp(lit*0.6 + tipGlow*0.5, 0.0, 1.0));
    float a       = (lit * 0.5 + tipGlow) * opacity;
    gl_FragColor  = vec4(col, clamp(a, 0.0, 1.0));
  }
`

// ── 地面リングシェーダ（中心から円状に広がる帯＋内側の淡い光） ──
const GROUND_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`
const GROUND_FRAG = /* glsl */`
  uniform float spread;    // 0→1 リング半径（vUv 中心からの正規化距離）
  uniform float opacity;
  varying vec2 vUv;
  void main() {
    float r     = length(vUv - 0.5) * 2.0;                       // 0=中心, 1=端
    float ring  = smoothstep(spread - 0.14, spread, r) * (1.0 - smoothstep(spread, spread + 0.14, r));
    float inner = (1.0 - smoothstep(0.0, spread, r)) * 0.30;     // 内側の淡い満たし
    vec3  col   = mix(vec3(0.80,0.92,1.0), vec3(1.0,1.0,1.0), ring);
    float a     = (ring + inner) * opacity;
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  }
`

// ── 降雪シェーダ（丸いソフト粒子・距離減衰） ──
const SNOW_VERT = /* glsl */`
  uniform float scale;
  attribute float psize;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = psize * (scale / -mv.z);
    gl_Position  = projectionMatrix * mv;
  }
`
const SNOW_FRAG = /* glsl */`
  uniform float opacity;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d) * opacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(0.82,0.92,1.0), a);
  }
`

interface Props {
  onDark:  (v: number) => void  // 黒オーバーレイ opacity（0→0.5→0）
  onFlash: (v: number) => void  // 白オーバーレイ opacity（0→1→0）。1.0 で完全に白く隠れる
  onCover: () => void           // flash=1.0 の瞬間に1回。finalValue 書き換えをここで
  onDone:  () => void           // 18s で完了通知
}

export function YachtEffect({ onDark, onFlash, onCover, onDone }: Props) {
  const pillarRef    = useRef<Mesh>(null)
  const pillarMatRef = useRef<ShaderMaterial>(null)
  const groundRef    = useRef<Mesh>(null)
  const groundMatRef = useRef<ShaderMaterial>(null)
  const snowGeoRef   = useRef<BufferGeometry>(null)
  const snowMatRef   = useRef<ShaderMaterial>(null)
  const tRef         = useRef(0)
  const coveredRef   = useRef(false)
  const doneRef      = useRef(false)

  // 降雪の初期配置と1個ごとの運動パラメータ（位置は毎フレーム更新）
  const snow = useMemo(() => {
    const positions = new Float32Array(SNOW_COUNT * 3)
    const psize     = new Float32Array(SNOW_COUNT)
    const vy        = new Float32Array(SNOW_COUNT)  // 落下速度
    const swA       = new Float32Array(SNOW_COUNT)  // 横揺れ振幅
    const swF       = new Float32Array(SNOW_COUNT)  // 横揺れ周波数
    const swP       = new Float32Array(SNOW_COUNT)  // 横揺れ位相
    for (let i = 0; i < SNOW_COUNT; i++) {
      positions[i*3]   = (Math.random() * 2 - 1) * SNOW_X
      positions[i*3+1] = SNOW_YBOT + Math.random() * (SNOW_YTOP - SNOW_YBOT)
      positions[i*3+2] = SNOW_ZMIN + Math.random() * (SNOW_ZMAX - SNOW_ZMIN)
      psize[i] = 5 + Math.random() * 12
      vy[i]    = 2.0 + Math.random() * 3.5
      swA[i]   = 0.4 + Math.random() * 0.8
      swF[i]   = 0.6 + Math.random() * 1.2
      swP[i]   = Math.random() * Math.PI * 2
    }
    return { positions, psize, vy, swA, swF, swP }
  }, [])

  useFrame((_, dt) => {
    if (doneRef.current) return
    tRef.current += dt
    const t  = tRef.current
    const T1 = DARK_DUR                // 3
    const T2 = T1 + BEAM_DUR          // 8
    const T3 = T2 + BLOOM_DUR         // 13 ← onCover
    const T4 = T3 + FADE_DUR          // 18 ← onDone

    let darkOp = 0, flashOp = 0
    let pillarProg = 0, pillarOp = 0
    let spread = 0, groundOp = 0
    let snowOp = 0

    if (t < T1) {
      // フェーズ1: 暗転
      darkOp = 0.5 * (t / T1)
    } else if (t < T2) {
      // フェーズ2: 柱降下（降雪フェードイン）
      const k = (t - T1) / BEAM_DUR
      darkOp     = 0.5
      pillarProg = k
      pillarOp   = Math.min(k * 6, 1.0)
      snowOp     = Math.min((t - T1) / 1.0, 1.0)
    } else if (t < T3) {
      // フェーズ3: 地面リングが円状に拡大 + 白フラッシュ上昇
      const k = (t - T2) / BLOOM_DUR
      const e = k * k * (3 - 2 * k)     // ease in-out
      darkOp     = 0.5 * (1 - e)        // dark 0.5→0
      flashOp    = e                     // flash 0→1
      pillarProg = 1.0
      pillarOp   = 1.0
      spread     = Math.pow(e, 0.55)     // 前半に速く広がる（白飛び前に見せる）
      groundOp   = Math.min(e * 2.0, 1.0)
      snowOp     = 1.0
    } else if (t < T4) {
      // フェーズ4: 連動フェードアウト
      const k = (t - T3) / FADE_DUR
      flashOp    = 1 - k                 // flash 1→0
      pillarProg = 1.0
      pillarOp   = 1 - k
      spread     = 1.0
      groundOp   = 1 - k
      snowOp     = 1 - k
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

    // 柱
    if (pillarRef.current) pillarRef.current.visible = pillarOp > 0.01
    if (pillarMatRef.current) {
      pillarMatRef.current.uniforms.progress.value = pillarProg
      pillarMatRef.current.uniforms.opacity.value  = pillarOp
    }
    // 地面リング
    if (groundRef.current) groundRef.current.visible = groundOp > 0.01
    if (groundMatRef.current) {
      groundMatRef.current.uniforms.spread.value  = spread
      groundMatRef.current.uniforms.opacity.value = groundOp
    }
    // 降雪（落下＋横揺れ。下端を割ったら上端へ再投入）
    if (snowMatRef.current) snowMatRef.current.uniforms.opacity.value = snowOp
    if (snowGeoRef.current && snowOp > 0.01) {
      const p = snow.positions
      for (let i = 0; i < SNOW_COUNT; i++) {
        const yi = i*3 + 1
        p[yi] -= snow.vy[i] * dt
        p[i*3]   += Math.sin(t * snow.swF[i] + snow.swP[i]) * snow.swA[i] * dt
        p[i*3+2] += Math.cos(t * snow.swF[i] * 0.7 + snow.swP[i]) * snow.swA[i] * 0.5 * dt
        if (p[yi] < SNOW_YBOT) {
          p[yi]    = SNOW_YTOP
          p[i*3]   = (Math.random() * 2 - 1) * SNOW_X
          p[i*3+2] = SNOW_ZMIN + Math.random() * (SNOW_ZMAX - SNOW_ZMIN)
        }
      }
      snowGeoRef.current.attributes.position.needsUpdate = true
    }
  })

  return (
    <group>
      {/* 光の柱: ワールド垂直の円柱。base=地面(y=0), 中心はフィールド中心 */}
      <mesh
        ref={pillarRef}
        position={[FIELD_CX, PILLAR_H / 2, FIELD_CZ]}
        renderOrder={50}
        visible={false}
      >
        <cylinderGeometry args={[PILLAR_RTOP, PILLAR_RBOT, PILLAR_H, 28, 1, true]} />
        <shaderMaterial
          ref={pillarMatRef}
          vertexShader={PILLAR_VERT}
          fragmentShader={PILLAR_FRAG}
          uniforms={{ progress: { value: 0 }, opacity: { value: 0 } }}
          blending={AdditiveBlending}
          transparent
          side={DoubleSide}   // 前後の壁が加算で重なり中央が密に光る
          depthTest={false}
          depthWrite={false}
        />
      </mesh>

      {/* 地面リング: 水平面（法線上向き）。中心から円状に広がる */}
      <mesh
        ref={groundRef}
        position={[FIELD_CX, 0.06, FIELD_CZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={48}
        visible={false}
      >
        <planeGeometry args={[GROUND_SIZE, GROUND_SIZE]} />
        <shaderMaterial
          ref={groundMatRef}
          vertexShader={GROUND_VERT}
          fragmentShader={GROUND_FRAG}
          uniforms={{ spread: { value: 0 }, opacity: { value: 0 } }}
          blending={AdditiveBlending}
          transparent
          depthTest={false}
          depthWrite={false}
        />
      </mesh>

      {/* 降雪: 画面全体に降る光の粒子（移動で bounds が変わるためカリング無効） */}
      <points renderOrder={49} frustumCulled={false}>
        <bufferGeometry ref={snowGeoRef}>
          <bufferAttribute attach="attributes-position" args={[snow.positions, 3]} />
          <bufferAttribute attach="attributes-psize"    args={[snow.psize, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={snowMatRef}
          vertexShader={SNOW_VERT}
          fragmentShader={SNOW_FRAG}
          uniforms={{ scale: { value: 15 }, opacity: { value: 0 } }}
          blending={AdditiveBlending}
          transparent
          depthTest={false}
          depthWrite={false}
        />
      </points>
    </group>
  )
}
