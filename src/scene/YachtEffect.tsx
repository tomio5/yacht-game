/**
 * YachtEffect.tsx — ヨット成立時の光の柱演出（staging テーブル外）
 *
 * 全パターン共通の骨格（必ず守る3点）:
 *   1. 柱がフィールド中心へ「ワールド垂直の円柱」として降下する（カーテン状にしない）。
 *   2. 着地後、地面リングが中心から円状に広がる。
 *   3. 降雪が柱と同時に降り、柱が消えると雪も消える。
 *
 * variant（0〜9）で色・形・降雪・拡散サイズだけを差し替える（骨格・タイムラインは共通）。
 *
 * タイムライン:
 *   0〜3s  暗転 / 3〜8s 柱降下＋降雪 / 8〜13s 地面リング円状拡大＋柱膨張＋白飛び上昇
 *   13〜14s 白飛び最大キープ(onCover) / 14〜19s 連動フェードアウト(onDone)
 */

import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, DoubleSide } from 'three'
import type { Mesh, ShaderMaterial, BufferGeometry } from 'three'

export const DARK_DUR   = 3.0
export const BEAM_DUR   = 5.0
export const BLOOM_DUR  = 5.0
export const HOLD_DUR   = 1.0
export const FADE_DUR   = 5.0
export const YACHT_TOTAL = DARK_DUR + BEAM_DUR + BLOOM_DUR + HOLD_DUR + FADE_DUR

const FIELD_CX = 0
const FIELD_CZ = 0.19
const FLASH_POW = 0.55   // 白飛びの立ち上がり（<1 ほど速く白くなる）

type RGB = [number, number, number]

interface VariantCfg {
  name:      string
  core:      RGB     // 柱の芯（明）
  edge:      RGB     // 柱の縁／先端
  ring:      RGB     // 地面リング
  snowCol:   RGB     // 降雪
  snowCount: number
  snowSize:  number  // 粒サイズ倍率
  snowSpeed: number  // 落下速度倍率
  expand:    number  // 円柱の半径膨張倍率
  rtop:      number  // 上端半径
  rbot:      number  // 下端半径
  height:    number  // 柱の高さ
  ringSize:  number  // 地面リング平面サイズ（拡散の広さ）
  rainbow?:  boolean // true: 色相が時間で循環（虹グラデ。色フィールドは初期値）
}

// HSL(0〜1) → RGB(0〜1)。虹グラデの色循環用
function hsl(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1))
  const m = l - c / 2
  const r = h < 1/6 ? c : h < 2/6 ? x : h < 3/6 ? 0 : h < 4/6 ? 0 : h < 5/6 ? x : c
  const g = h < 1/6 ? x : h < 2/6 ? c : h < 3/6 ? c : h < 4/6 ? x : h < 5/6 ? 0 : 0
  const b = h < 1/6 ? 0 : h < 2/6 ? 0 : h < 3/6 ? x : h < 4/6 ? c : h < 5/6 ? c : x
  return [r + m, g + m, b + m]
}

// ── 10 パターン（骨格は共通、見た目だけ差し替え） ──
export const YACHT_VARIANTS: VariantCfg[] = [
  { name:'蒼白クラシック', core:[1,1,1],       edge:[0.72,0.90,1.0], ring:[0.80,0.92,1.0], snowCol:[0.82,0.92,1.0], snowCount:240, snowSize:1.0, snowSpeed:1.0, expand:3.0, rtop:1.15, rbot:0.70, height:24, ringSize:30 },
  { name:'黄金の祝福',     core:[1,1,0.95],    edge:[1.0,0.82,0.38], ring:[1.0,0.78,0.30], snowCol:[1.0,0.90,0.50], snowCount:200, snowSize:1.25, snowSpeed:0.8, expand:5.5, rtop:1.30, rbot:0.85, height:24, ringSize:34 },
  { name:'翠玉グリーン',   core:[0.95,1,0.95], edge:[0.50,1.0,0.60], ring:[0.40,0.95,0.50], snowCol:[0.60,1.0,0.70], snowCount:260, snowSize:0.9, snowSpeed:1.1, expand:3.0, rtop:1.15, rbot:0.70, height:24, ringSize:30 },
  { name:'紫オーロラ',     core:[1,0.97,1],    edge:[0.72,0.52,1.0], ring:[0.60,0.40,1.0], snowCol:[0.82,0.66,1.0], snowCount:300, snowSize:1.0, snowSpeed:0.7, expand:4.0, rtop:1.20, rbot:0.70, height:26, ringSize:36 },
  { name:'紅蓮の柱',       core:[1,1,0.9],     edge:[1.0,0.45,0.18], ring:[1.0,0.35,0.10], snowCol:[1.0,0.55,0.25], snowCount:180, snowSize:1.3, snowSpeed:1.7, expand:3.5, rtop:1.25, rbot:0.65, height:24, ringSize:32 },
  { name:'プリズム',       core:[1,1,1],       edge:[0.40,0.95,1.0], ring:[1.0,0.50,0.90], snowCol:[0.90,0.80,1.0], snowCount:240, snowSize:1.0, snowSpeed:1.2, expand:3.2, rtop:1.15, rbot:0.70, height:24, ringSize:32 },
  { name:'氷晶ブルー',     core:[1,1,1],       edge:[0.55,0.82,1.0], ring:[0.70,0.90,1.0], snowCol:[0.85,0.95,1.0], snowCount:360, snowSize:0.7, snowSpeed:1.35, expand:2.8, rtop:1.05, rbot:0.75, height:24, ringSize:28 },
  { name:'桜吹雪',         core:[1,0.98,0.99], edge:[1.0,0.68,0.82], ring:[1.0,0.60,0.78], snowCol:[1.0,0.75,0.88], snowCount:150, snowSize:1.7, snowSpeed:0.6, expand:3.0, rtop:1.20, rbot:0.70, height:24, ringSize:30 },
  { name:'極光ホワイト',   core:[1,1,1],       edge:[0.92,0.96,1.0], ring:[1.0,1.0,1.0],   snowCol:[1.0,1.0,1.0],   snowCount:280, snowSize:1.1, snowSpeed:1.0, expand:4.5, rtop:1.30, rbot:0.60, height:26, ringSize:40 },
  { name:'逆光の紫闇',     core:[1,1,1],       edge:[0.42,0.22,0.70], ring:[0.50,0.30,0.90], snowCol:[0.72,0.62,0.92], snowCount:320, snowSize:1.0, snowSpeed:1.2, expand:4.0, rtop:1.20, rbot:0.70, height:25, ringSize:34 },
  { name:'虹グラデ',       core:[1,1,1],       edge:[1.0,0.3,0.3],   ring:[0.3,0.6,1.0],   snowCol:[1.0,1.0,1.0],   snowCount:280, snowSize:1.0, snowSpeed:1.0, expand:3.6, rtop:1.20, rbot:0.68, height:25, ringSize:34, rainbow:true },
]

export const YACHT_VARIANT_NAMES = YACHT_VARIANTS.map(v => v.name)

// 降雪
const SNOW_X    = 24
const SNOW_ZMIN = -18
const SNOW_ZMAX = 24
const SNOW_YTOP = 28
const SNOW_YBOT = -1

// ── 柱シェーダ（高さ座標基準で降下＋先端グロー。色は uniform） ──
const PILLAR_VERT = /* glsl */`
  uniform float halfH;
  varying float vY;
  void main() {
    vY = position.y / (halfH * 2.0) + 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const PILLAR_FRAG = /* glsl */`
  uniform float progress;
  uniform float opacity;
  uniform vec3  uCore;
  uniform vec3  uEdge;
  varying float vY;
  void main() {
    float tipY    = 1.0 - progress;
    float lit     = smoothstep(tipY - 0.03, tipY + 0.03, vY);
    float tipGlow = exp(-abs(vY - tipY) * 14.0) * 1.6;
    vec3  col     = mix(uEdge, uCore, clamp(lit*0.6 + tipGlow*0.5, 0.0, 1.0));
    float a       = (lit * 0.62 + tipGlow) * opacity;
    gl_FragColor  = vec4(col, clamp(a, 0.0, 1.0));
  }
`

// ── 地面リングシェーダ（中心から円状に広がる帯＋内側の淡い光） ──
const GROUND_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`
const GROUND_FRAG = /* glsl */`
  uniform float spread;
  uniform float opacity;
  uniform vec3  uColor;
  varying vec2 vUv;
  void main() {
    float r     = length(vUv - 0.5) * 2.0;
    float ring  = smoothstep(spread - 0.14, spread, r) * (1.0 - smoothstep(spread, spread + 0.14, r));
    float inner = (1.0 - smoothstep(0.0, spread, r)) * 0.25;
    vec3  col   = mix(uColor, vec3(1.0,1.0,1.0), ring * 0.5);
    float a     = (ring + inner) * opacity;
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  }
`

// ── 降雪シェーダ（丸いソフト粒子・距離減衰。色は uniform） ──
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
  uniform vec3  uColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d) * opacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
  }
`

interface Props {
  onDark:  (v: number) => void
  onFlash: (v: number) => void
  onCover: () => void
  onDone:  () => void
  variant?: number   // 0〜9。範囲外は 0
}

export function YachtEffect({ onDark, onFlash, onCover, onDone, variant = 0 }: Props) {
  const cfg = YACHT_VARIANTS[variant] ?? YACHT_VARIANTS[0]

  const pillarRef    = useRef<Mesh>(null)
  const pillarMatRef = useRef<ShaderMaterial>(null)
  const groundRef    = useRef<Mesh>(null)
  const groundMatRef = useRef<ShaderMaterial>(null)
  const snowGeoRef   = useRef<BufferGeometry>(null)
  const snowMatRef   = useRef<ShaderMaterial>(null)
  const tRef         = useRef(0)
  const coveredRef   = useRef(false)
  const doneRef      = useRef(false)

  // 降雪の初期配置（variant の count/size/speed を反映。mount ごとに再生成）
  const snow = useMemo(() => {
    const n = cfg.snowCount
    const positions = new Float32Array(n * 3)
    const psize     = new Float32Array(n)
    const vy        = new Float32Array(n)
    const swA       = new Float32Array(n)
    const swF       = new Float32Array(n)
    const swP       = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      positions[i*3]   = (Math.random() * 2 - 1) * SNOW_X
      positions[i*3+1] = SNOW_YBOT + Math.random() * (SNOW_YTOP - SNOW_YBOT)
      positions[i*3+2] = SNOW_ZMIN + Math.random() * (SNOW_ZMAX - SNOW_ZMIN)
      psize[i] = (5 + Math.random() * 12) * cfg.snowSize
      vy[i]    = (2.0 + Math.random() * 3.5) * cfg.snowSpeed
      swA[i]   = 0.4 + Math.random() * 0.8
      swF[i]   = 0.6 + Math.random() * 1.2
      swP[i]   = Math.random() * Math.PI * 2
    }
    return { n, positions, psize, vy, swA, swF, swP }
  }, [cfg])

  useFrame((_, dt) => {
    if (doneRef.current) return
    tRef.current += dt
    const t  = tRef.current
    const T1 = DARK_DUR
    const T2 = T1 + BEAM_DUR
    const T3 = T2 + BLOOM_DUR          // 白ピーク・onCover
    const TH = T3 + HOLD_DUR           // 白飛び最大キープ終了
    const T4 = TH + FADE_DUR           // onDone

    let darkOp = 0, flashOp = 0
    let pillarProg = 0, pillarOp = 0, pillarScale = 1
    let spread = 0, groundOp = 0
    let snowOp = 0

    if (t < T1) {
      darkOp = 0.5 * (t / T1)
    } else if (t < T2) {
      // 柱降下＋降雪フェードイン
      const k = (t - T1) / BEAM_DUR
      darkOp     = 0.5
      pillarProg = k
      pillarOp   = Math.min(k * 6, 1.0)
      snowOp     = Math.min((t - T1) / 1.0, 1.0)
    } else if (t < T3) {
      // 地面リング円状拡大＋柱膨張＋白飛び上昇
      const k = (t - T2) / BLOOM_DUR
      const e = k * k * (3 - 2 * k)
      darkOp      = 0.5 * (1 - e)
      flashOp     = Math.pow(e, FLASH_POW)
      pillarProg  = 1.0
      pillarOp    = 1.0
      pillarScale = 1 + (cfg.expand - 1) * e
      spread      = Math.pow(e, 0.55)             // 前半に速く広がる
      groundOp    = Math.min(e * 2.0, 1.0)
      snowOp      = 1.0
    } else if (t < TH) {
      // 白飛び最大キープ
      flashOp     = 1.0
      pillarProg  = 1.0
      pillarOp    = 1.0
      pillarScale = cfg.expand
      spread      = 1.0
      groundOp    = 1.0
      snowOp      = 1.0
    } else if (t < T4) {
      // 連動フェードアウト
      const k = (t - TH) / FADE_DUR
      flashOp     = 1 - k
      pillarProg  = 1.0
      pillarOp    = 1 - k
      pillarScale = cfg.expand
      spread      = 1.0
      groundOp    = 1 - k
      snowOp      = 1 - k
    } else {
      if (!coveredRef.current) { coveredRef.current = true; onCover() }
      onDark(0); onFlash(0)
      doneRef.current = true
      onDone()
      return
    }

    if (!coveredRef.current && t >= T3) {
      coveredRef.current = true
      onCover()
    }

    onDark(darkOp)
    onFlash(flashOp)

    // 虹グラデ: 色相を時間で循環させ、柱縁／地面リング／降雪に位相差で適用（毎フレーム新配列を代入）
    if (cfg.rainbow) {
      const h = (t * 0.18) % 1
      if (pillarMatRef.current) pillarMatRef.current.uniforms.uEdge.value  = hsl(h, 0.9, 0.6)
      if (groundMatRef.current) groundMatRef.current.uniforms.uColor.value = hsl((h + 0.33) % 1, 0.9, 0.6)
      if (snowMatRef.current)   snowMatRef.current.uniforms.uColor.value   = hsl((h + 0.66) % 1, 0.85, 0.7)
    }

    if (pillarRef.current) {
      pillarRef.current.visible = pillarOp > 0.01
      pillarRef.current.scale.set(pillarScale, 1, pillarScale)
    }
    if (pillarMatRef.current) {
      pillarMatRef.current.uniforms.progress.value = pillarProg
      pillarMatRef.current.uniforms.opacity.value  = pillarOp
    }
    if (groundRef.current) groundRef.current.visible = groundOp > 0.01
    if (groundMatRef.current) {
      groundMatRef.current.uniforms.spread.value  = spread
      groundMatRef.current.uniforms.opacity.value = groundOp
    }
    if (snowMatRef.current) snowMatRef.current.uniforms.opacity.value = snowOp
    if (snowGeoRef.current && snowOp > 0.01) {
      const p = snow.positions
      for (let i = 0; i < snow.n; i++) {
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
      {/* 光の柱: ワールド垂直の円柱（フタ付き）。base=地面 */}
      <mesh
        ref={pillarRef}
        position={[FIELD_CX, cfg.height / 2, FIELD_CZ]}
        renderOrder={50}
        visible={false}
      >
        <cylinderGeometry args={[cfg.rtop, cfg.rbot, cfg.height, 40, 1, false]} />
        <shaderMaterial
          ref={pillarMatRef}
          vertexShader={PILLAR_VERT}
          fragmentShader={PILLAR_FRAG}
          uniforms={{
            progress: { value: 0 }, opacity: { value: 0 },
            halfH: { value: cfg.height / 2 },
            uCore: { value: cfg.core }, uEdge: { value: cfg.edge },
          }}
          blending={AdditiveBlending}
          transparent
          side={DoubleSide}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>

      {/* 地面リング: 水平面。中心から円状に広がる */}
      <mesh
        ref={groundRef}
        position={[FIELD_CX, 0.06, FIELD_CZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={48}
        visible={false}
      >
        <planeGeometry args={[cfg.ringSize, cfg.ringSize]} />
        <shaderMaterial
          ref={groundMatRef}
          vertexShader={GROUND_VERT}
          fragmentShader={GROUND_FRAG}
          uniforms={{ spread: { value: 0 }, opacity: { value: 0 }, uColor: { value: cfg.ring } }}
          blending={AdditiveBlending}
          transparent
          depthTest={false}
          depthWrite={false}
        />
      </mesh>

      {/* 降雪: 画面全体に降る光の粒子 */}
      <points renderOrder={49} frustumCulled={false}>
        <bufferGeometry ref={snowGeoRef}>
          <bufferAttribute attach="attributes-position" args={[snow.positions, 3]} />
          <bufferAttribute attach="attributes-psize"    args={[snow.psize, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={snowMatRef}
          vertexShader={SNOW_VERT}
          fragmentShader={SNOW_FRAG}
          uniforms={{ scale: { value: 15 }, opacity: { value: 0 }, uColor: { value: cfg.snowCol } }}
          blending={AdditiveBlending}
          transparent
          depthTest={false}
          depthWrite={false}
        />
      </points>
    </group>
  )
}
