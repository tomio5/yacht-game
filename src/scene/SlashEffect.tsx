/**
 * SlashEffect.tsx — ゲーム風斬撃エフェクト（B系統）
 *
 * 曲線リボンジオメトリ + ホワイトコア/ブルーグロウシェーダー。
 * zangeki.wav の4打点に同期して4本の弧状スラッシュを発火。
 * 打点タイミング（秒）: 0.02 / 0.46 / 0.90 / 1.37
 * 各スラッシュ: 展開(0.22s) → フェードアウト(0.22s) = 計 0.44s
 */

import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending, BufferGeometry, BufferAttribute,
  QuadraticBezierCurve3, Vector3, DoubleSide, Group,
} from 'three'
import type { ShaderMaterial } from 'three'

// ── 定数 ─────────────────────────────────────────────────────────────────

const SLASH_DUR   = 0.073  // リボン展開時間（秒）
const SLASH_FADE  = 0.073  // 展開後フェードアウト時間（秒）
const RIBBON_SEGS = 40     // リボンの分割数
const RIBBON_W    = 0.62   // リボン最大幅

// rotation.x = -1.25 でカメラ正面向き（camera=[0,18,6] の72°俯瞰から導出）
const FACE_CAM_X = -1.25

// 各スラッシュ: 二次ベジェ曲線の3制御点 + 発火タイミング
// XY 平面で定義（group の rotation.x で正面向きに傾く）
const SLASH_DEFS = [
  // 左下→右上 弧（緩やかな S 字弧）
  { p0: [-3.5, -1.8, 0] as const, p1: [-0.3,  2.4, 0] as const, p2: [ 3.5,  0.4, 0] as const, triggerAt: 0.02 },
  // 左上→右下 鋭い斜め弧
  { p0: [-2.8,  3.0, 0] as const, p1: [ 1.2,  0.3, 0] as const, p2: [ 2.8, -3.0, 0] as const, triggerAt: 0.46 },
  // 左→右 大きな下弧（横一文字）
  { p0: [-3.5,  1.0, 0] as const, p1: [ 0.0, -2.0, 0] as const, p2: [ 3.5,  1.0, 0] as const, triggerAt: 0.90 },
  // 右上→左下 急角度弧
  { p0: [ 2.0,  3.5, 0] as const, p1: [-1.6,  0.5, 0] as const, p2: [ 1.0, -3.5, 0] as const, triggerAt: 1.37 },
]

// ── リボンジオメトリ生成 ─────────────────────────────────────────────────

function createRibbonGeo(
  p0: readonly [number, number, number],
  p1: readonly [number, number, number],
  p2: readonly [number, number, number],
): BufferGeometry {
  const curve = new QuadraticBezierCurve3(
    new Vector3(...p0), new Vector3(...p1), new Vector3(...p2),
  )
  const pts = curve.getPoints(RIBBON_SEGS)

  const pos: number[] = []
  const uvs: number[] = []
  const idx: number[] = []

  for (let i = 0; i <= RIBBON_SEGS; i++) {
    const t  = i / RIBBON_SEGS
    const pt = pts[i]

    // タンジェント（有限差分）
    const nx_pt = pts[Math.min(i + 1, RIBBON_SEGS)]
    const pv_pt = pts[Math.max(i - 1, 0)]
    const txRaw = nx_pt.x - pv_pt.x
    const tyRaw = nx_pt.y - pv_pt.y
    const tlen  = Math.hypot(txRaw, tyRaw) || 1

    // 法線（タンジェントと直交、XY 平面内）
    const nx = -tyRaw / tlen
    const ny =  txRaw / tlen

    // 両端を尖らせる taper。前半は素早く開き、後半はゆっくり閉じる
    const taper = Math.sin(Math.pow(t, 0.65) * Math.PI)
    const w     = RIBBON_W * taper

    pos.push(
      pt.x + nx * w, pt.y + ny * w, 0,
      pt.x - nx * w, pt.y - ny * w, 0,
    )
    uvs.push(t, 0, t, 1)

    if (i < RIBBON_SEGS) {
      const b = i * 2
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2)
    }
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('uv',       new BufferAttribute(new Float32Array(uvs), 2))
  geo.setIndex(idx)
  return geo
}

// ── シェーダー ─────────────────────────────────────────────────────────

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */`
  uniform float revealP;   // リボン展開進行度 0→1
  uniform float fadeP;     // フェードアウト進行度 0→1（展開完了後）
  varying vec2 vUv;

  void main() {
    if (revealP <= 0.0) discard;
    if (vUv.x > revealP) discard;

    // d: リボン中心からの距離 0=中心 1=端
    float d = abs(vUv.y - 0.5) * 2.0;

    // ホワイトコア（極細の輝く中心線）
    float core  = 1.0 - smoothstep(0.0,  0.14, d);
    // ミドルグロウ（水色）
    float mid   = 1.0 - smoothstep(0.10, 0.55, d);
    // アウターグロウ（青）
    float outer = 1.0 - smoothstep(0.35, 1.00, d);

    // トレイルフェード（先端に近いほど明るい）
    float age       = (revealP - vUv.x) / max(revealP, 0.001);
    float trailFade = 1.0 - smoothstep(0.0, 0.80, age);

    // 全体フェードアウト（展開後）
    float fade = 1.0 - fadeP;

    // 色: 中心は白、外に向かって水色 → 青
    vec3 col = vec3(1.0, 1.0, 1.0);
    col = mix(col, vec3(0.45, 0.70, 1.00), smoothstep(0.10, 0.50, d));
    col = mix(col, vec3(0.20, 0.40, 0.95), smoothstep(0.40, 0.85, d));

    float alpha = (core * 2.8 + mid * 1.3 + outer * 0.6) * trailFade * fade;

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`

// ── コンポーネント ─────────────────────────────────────────────────────

interface Props {
  onDone?: () => void
  /** B系統: 各スラッシュが発火した瞬間のダイス位置を返す。省略時は原点に固定。 */
  getDiePos?: () => [number, number, number]
}

export function SlashEffect({ onDone, getDiePos }: Props) {
  const geos = useMemo(
    () => SLASH_DEFS.map(d => createRibbonGeo(d.p0, d.p1, d.p2)),
    [],
  )
  const matRefs   = useRef<(ShaderMaterial | null)[]>(SLASH_DEFS.map(() => null))
  const groupRefs = useRef<(Group | null)[]>(SLASH_DEFS.map(() => null))
  const tRef      = useRef(0)
  const doneRef   = useRef(false)
  const firedRef  = useRef<boolean[]>(SLASH_DEFS.map(() => false))

  useFrame((_, dt) => {
    if (doneRef.current) return
    tRef.current += dt
    const t = tRef.current

    let allDone = true
    for (let i = 0; i < SLASH_DEFS.length; i++) {
      const def = SLASH_DEFS[i]
      const mat = matRefs.current[i]
      if (!mat) continue

      // 発火タイミングで group をダイス位置へ移動
      if (!firedRef.current[i] && t >= def.triggerAt) {
        firedRef.current[i] = true
        const pos = getDiePos?.() ?? [0, 0.5, 0] as [number, number, number]
        const g = groupRefs.current[i]
        if (g) g.position.set(pos[0], pos[1] + 0.1, pos[2])
      }

      if (t < def.triggerAt) {
        mat.uniforms.revealP.value = 0
        mat.uniforms.fadeP.value   = 0
        allDone = false
        continue
      }

      const tRel   = t - def.triggerAt
      const revealP = Math.min(tRel / SLASH_DUR, 1.0)
      const fadeP   = Math.max(0, Math.min((tRel - SLASH_DUR) / SLASH_FADE, 1.0))

      mat.uniforms.revealP.value = revealP
      mat.uniforms.fadeP.value   = fadeP

      if (fadeP < 1) allDone = false
    }

    if (allDone) {
      doneRef.current = true
      onDone?.()
    }
  })

  return (
    <>
      {SLASH_DEFS.map((_, i) => (
        <group
          key={i}
          ref={(g) => { groupRefs.current[i] = g }}
          position={[0, 0.5, 0]}
          rotation={[FACE_CAM_X, 0, 0]}
        >
          <mesh geometry={geos[i]} renderOrder={20}>
            <shaderMaterial
              ref={(m) => { matRefs.current[i] = m }}
              vertexShader={VERT}
              fragmentShader={FRAG}
              uniforms={{ revealP: { value: 0 }, fadeP: { value: 0 } }}
              blending={AdditiveBlending}
              transparent
              depthTest={false}
              depthWrite={false}
              side={DoubleSide}
            />
          </mesh>
        </group>
      ))}
    </>
  )
}
