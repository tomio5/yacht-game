/**
 * SlashDieEffect.tsx — 斬撃割れ演出用「半割れ破片プール」常設コンポーネント（A-2）
 *
 * FractureSystem と同じ設計パターン:
 *   - 破片 RigidBody 2個（上半・下半）をシーン起動時から常設。add/remove 一切なし。
 *   - 非演出時: visible=false・kinematic で退避座標へ待機。
 *   - activate(pos, dieId): pos に配置して元ダイスを隠す（kinematic のまま）。
 *   - triggerFall(slashAngleDeg): kinematic→dynamic で斬撃方向に左右へ倒す。
 *     2秒後に timeout force-restore で deactivate（物理が暴れても強制回収）。
 *   - deactivate(): kinematic 化→速度ゼロ→退避。元ダイス再表示は呼び出し側が行う。
 *
 * 形状: 高さ 1.0 のダイスを上下 0.5 ずつに分割。
 *   上半分: BoxGeometry(1, 0.5, 1), Y+0.25
 *   下半分: BoxGeometry(1, 0.5, 1), Y-0.25
 *   → 合わさるとダイス 1個に見える。質感は A-5 で作り込む。
 */

import { forwardRef, useImperativeHandle, useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import type { RapierRigidBody } from '@react-three/rapier'
import { RigidBodyType } from '@dimforge/rapier3d-compat'
import { Vector3, Quaternion as ThreeQuat, Euler, CanvasTexture } from 'three'
import type { Mesh } from 'three'
import { createFaceTexture, MATERIAL_FACE_VALUES } from './diceTexture'

// ── 定数 ─────────────────────────────────────────────────────────────────────

const DIE_SIZE    = 1.0
const HALF_W      = DIE_SIZE / 4   // 0.25 = 半割れ片の幅の半分（X 軸オフセット）
const HALF_FULL_W = DIE_SIZE / 2   // 0.5  = 半割れ片の幅

const SPLIT_SPEED  = 3.0   // 左右分離速度（実機調整可）
const UP_SPEED     = 2.5   // 上方向の初速（実機調整可）
const Z_SPREAD     = 1.5   // 奥行き方向の広がり（俯瞰で軌跡が分かれて見える）
const TIP_SPEED    = 5.0   // 倒れる角速度（実機調整可）
const FALL_TIMEOUT         = 2.0   // force-restore までの秒数
const ASSEMBLE_COVER_RATIO = 0.75  // アニメ長の何割で onAssembled を発火するか
const ASSEMBLE_SPINS       = 1.5   // missB のスピン回転数

// パターン別アニメ時間
const PATTERN_DUR: Record<SlashAssemblePattern, number> = {
  missA: 0.6, successA: 0.6,
  missB: 0.8, successB: 0.8,
}

// successB 用: finalValue の面が +Y を向く基準クォータニオン（ランダム yaw なし）
const FINAL_NORMALS: Record<number, [number,number,number]> = {
  1:[0,1,0], 6:[0,-1,0], 2:[0,0,1], 5:[0,0,-1], 3:[1,0,0], 4:[-1,0,0],
}
function quatForFinalFace(v: number): ThreeQuat {
  const n = FINAL_NORMALS[v] ?? [0,1,0] as [number,number,number]
  return new ThreeQuat().setFromUnitVectors(new Vector3(...n), new Vector3(0,1,0))
}

function createCrossTexture(): CanvasTexture {
  const S = 256
  const canvas = document.createElement('canvas')
  canvas.width = S; canvas.height = S
  canvas.getContext('2d')!.fillStyle = '#fffdf5'
  canvas.getContext('2d')!.fillRect(0, 0, S, S)
  return new CanvasTexture(canvas)
}

const PARK: [[number,number,number],[number,number,number]] = [
  [0, -100, 0],
  [2, -100, 0],
]

// ── 型 ────────────────────────────────────────────────────────────────────────

export type SlashAssemblePattern = 'missA' | 'missB' | 'successA' | 'successB'

export interface SlashDieEffectHandle {
  /**
   * 斬撃準備: 破片を元ダイスの位置に待機させる（まだ非表示・元ダイスも非表示にしない）。
   * worldRot は readPose().rot で得たオイラー角。triggerFall() で破片に適用する。
   */
  activate(pos: Vector3, dieId: number, worldRot: [number,number,number]): void
  /**
   * 斬撃の瞬間: 元ダイスを隠して破片を表示（ダイスと同じ回転で出現）→ 物理で左右に飛ぶ。
   * FALL_TIMEOUT 後に自動で deactivate。
   */
  triggerFall(slashAngleDeg: number): void
  /**
   * 破片が元位置へ戻る復活アニメ。パターンで動きが変わる。
   * ASSEMBLE_COVER_RATIO 地点で onAssembled() を発火（呼び出し側が元ダイス表示＆目書き換えを行う）。
   * 完了後は自動で deactivate。
   *   missA/successA : スピンなし直線補間（0.6s）
   *   missB          : Y 軸スピンしながら戻る（0.8s）
   *   successB       : finalValue の面が上になる向きへ slerp（0.8s）
   */
  assemble(pattern: SlashAssemblePattern, finalValue: number, onAssembled: () => void): void
  /** 破片を退避座標へ戻す（元ダイスの再表示は呼び出し側が行う） */
  deactivate(): void
}

interface Props {
  onHide: (dieId: number) => void
}

// ── コンポーネント ─────────────────────────────────────────────────────────────

// assemble アニメの状態
interface AssembleState {
  t:           number
  pattern:     SlashAssemblePattern
  dur:         number
  firedCover:  boolean
  fromPos:     [number, number, number][]
  fromQuat:    ThreeQuat[]
  toPos:       [number, number, number][]
  toQuat:      ThreeQuat[]   // 収束先の回転（パターンで異なる）
  onAssembled: () => void
}

export const SlashDieEffect = forwardRef<SlashDieEffectHandle, Props>(
  function SlashDieEffect({ onHide }, ref) {
    const bodies  = useRef<(RapierRigidBody | null)[]>([null, null])
    const meshes  = useRef<(Mesh | null)[]>([null, null])
    const fallTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null)
    const activeDieIdRef    = useRef<number>(-1)
    const activeWorldRotRef = useRef<[number,number,number]>([0, 0, 0])

    // 各破片は「元ダイスの左半分 / 右半分」に見えるよう、
    // 全面に texture.repeat(0.5,1) + offset で左/右クロップする。
    // → 「4」上面なら 左片=左2ドット、右片=右2ドット に見える。
    const crossTex = useMemo(() => createCrossTexture(), [])
    const halfTexL = useMemo(() => MATERIAL_FACE_VALUES.map(v => {
      const t = createFaceTexture(v); t.repeat.set(0.5, 1); t.offset.set(0, 0); t.needsUpdate = true; return t
    }), [])
    const halfTexR = useMemo(() => MATERIAL_FACE_VALUES.map(v => {
      const t = createFaceTexture(v); t.repeat.set(0.5, 1); t.offset.set(0.5, 0); t.needsUpdate = true; return t
    }), [])
    // BoxGeometry face 順: [+X, -X, +Y, -Y, +Z, -Z]
    // 断面: fragment 0 の +X(index 0)、fragment 1 の -X(index 1) → crossTex(白)
    // 他の面: 左片=左半分テクスチャ、右片=右半分テクスチャ
    const fragMats = useMemo(() => [
      [crossTex,    halfTexL[1], halfTexL[2], halfTexL[3], halfTexL[4], halfTexL[5]],
      [halfTexR[0], crossTex,    halfTexR[2], halfTexR[3], halfTexR[4], halfTexR[5]],
    ], [crossTex, halfTexL, halfTexR])
    const assembleRef     = useRef<AssembleState | null>(null)
    const activePosRef    = useRef<Vector3>(new Vector3())  // activate() で記憶した元ダイス位置

    // X オフセット: 左(i=0)=-0.25, 右(i=1)=+0.25 → 縦割れ（カメラから見て左右に開く）
    const xOffsets = [-HALF_W, +HALF_W] as const

    const deactivate = () => {
      if (fallTimerRef.current) { clearTimeout(fallTimerRef.current); fallTimerRef.current = null }
      for (let i = 0; i < 2; i++) {
        const rb = bodies.current[i]
        if (rb) {
          rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
          rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
          rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
          const [px, py, pz] = PARK[i]
          rb.setNextKinematicTranslation({ x: px, y: py, z: pz })
        }
        const m = meshes.current[i]
        if (m) m.visible = false
      }
    }

    useImperativeHandle(ref, () => ({
      activate(pos: Vector3, dieId: number, worldRot: [number,number,number]) {
        activePosRef.current.copy(pos)
        activeDieIdRef.current  = dieId
        activeWorldRotRef.current = worldRot
        assembleRef.current = null
        // 破片を正しい位置に待機（非表示のまま・ダイスも隠さない）
        for (let i = 0; i < 2; i++) {
          const rb = bodies.current[i]
          if (rb) {
            rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
            rb.setNextKinematicTranslation({
              x: pos.x + xOffsets[i],
              y: pos.y,
              z: pos.z,
            })
          }
          // visible は false のまま（triggerFall で表示する）
        }
      },

      triggerFall(_slashAngleDeg: number) {
        // 斬撃の瞬間: ダイスを隠して破片を同じ向きで出現
        onHide(activeDieIdRef.current)
        const rot = activeWorldRotRef.current
        const dieQuat = new ThreeQuat().setFromEuler(new Euler(rot[0], rot[1], rot[2]))

        for (let i = 0; i < 2; i++) {
          const m = meshes.current[i]
          if (m) {
            m.quaternion.copy(dieQuat)   // ダイスと同じ回転 → 同じ目が見える
            m.visible = true
          }
          const rb = bodies.current[i]
          if (!rb) continue
          rb.setBodyType(RigidBodyType.Dynamic, true)
          rb.wakeUp()

          const sign = i === 0 ? -1 : 1
          rb.setLinvel({
            x:  SPLIT_SPEED * sign,
            y:  UP_SPEED,
            z: -Z_SPREAD * sign,
          }, true)
          rb.setAngvel({
            x:  TIP_SPEED * sign * 0.6,
            y:  0,
            z:  TIP_SPEED * sign,
          }, true)
        }

        fallTimerRef.current = setTimeout(deactivate, FALL_TIMEOUT * 1000)
      },

      assemble(pattern: SlashAssemblePattern, finalValue: number, onAssembled: () => void) {
        if (fallTimerRef.current) { clearTimeout(fallTimerRef.current); fallTimerRef.current = null }
        const fromPos: [number, number, number][] = []
        const fromQuat: ThreeQuat[] = []
        const toPos:  [number, number, number][] = []
        const toQuat: ThreeQuat[] = []
        const origin = activePosRef.current

        // 収束先の回転:
        //   missA/B/successA → 元ダイスの姿勢（切断前と同じ向き）
        //   successB         → finalValue の面が +Y を向く基準姿勢
        const rot = activeWorldRotRef.current
        const dieQuat = new ThreeQuat().setFromEuler(new Euler(rot[0], rot[1], rot[2]))
        const targetQuat = pattern === 'successB' ? quatForFinalFace(finalValue) : dieQuat

        for (let i = 0; i < 2; i++) {
          const rb = bodies.current[i]
          if (rb) {
            rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
            rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
            rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
            const tr = rb.translation()
            const qt = rb.rotation()
            fromPos[i] = [tr.x, tr.y, tr.z]
            fromQuat[i] = new ThreeQuat(qt.x, qt.y, qt.z, qt.w)
          } else {
            fromPos[i] = [0, 0, 0]
            fromQuat[i] = new ThreeQuat()
          }
          toPos[i]  = [origin.x + xOffsets[i], origin.y, origin.z]
          toQuat[i] = targetQuat.clone()
        }
        assembleRef.current = {
          t: 0,
          pattern,
          dur: PATTERN_DUR[pattern],
          firedCover: false,
          fromPos, fromQuat, toPos, toQuat,
          onAssembled,
        }
      },

      deactivate,
    }))

    useFrame((_, dt) => {
      const anim = assembleRef.current
      if (!anim) return
      anim.t += dt
      const k = Math.min(1, anim.t / anim.dur)
      const e = 1 - (1 - k) * (1 - k) * (1 - k)   // ease-out cubic

      for (let i = 0; i < 2; i++) {
        const rb = bodies.current[i]
        if (!rb) continue
        // ── 位置: 全パターン共通 ease-out lerp ──
        const fp = anim.fromPos[i]
        const tp = anim.toPos[i]
        rb.setNextKinematicTranslation({
          x: fp[0] + (tp[0] - fp[0]) * e,
          y: fp[1] + (tp[1] - fp[1]) * e,
          z: fp[2] + (tp[2] - fp[2]) * e,
        })
        // ── 回転: パターン別 ──
        let q: ThreeQuat
        if (anim.pattern === 'missB') {
          // missB: Y 軸スピン + toQuat へ slerp
          const sign = i === 0 ? 1 : -1
          const spinAngle = ASSEMBLE_SPINS * Math.PI * 2 * (1 - k)
          const spinQ = new ThreeQuat().setFromEuler(new Euler(0, spinAngle * sign, 0))
          q = anim.fromQuat[i].clone().slerp(anim.toQuat[i], e).multiply(spinQ)
        } else {
          // missA / successA / successB: スピンなし slerp
          q = anim.fromQuat[i].clone().slerp(anim.toQuat[i], e)
        }
        const m = meshes.current[i]
        if (m) m.quaternion.copy(q)
      }

      // 書き換え通知（アニメ長の ASSEMBLE_COVER_RATIO 時点で1回）
      if (!anim.firedCover && anim.t >= anim.dur * ASSEMBLE_COVER_RATIO) {
        anim.firedCover = true
        anim.onAssembled()
      }
      if (k >= 1) { assembleRef.current = null; deactivate() }
    })

    return (
      <>
        {([0, 1] as const).map((i) => (
          <RigidBody
            key={i}
            ref={(el) => { bodies.current[i] = el }}
            type="kinematicPosition"
            colliders={false}
            position={PARK[i]}
          >
            <CuboidCollider args={[HALF_FULL_W / 2, DIE_SIZE / 2, DIE_SIZE / 2]} />
            <mesh ref={(el) => { meshes.current[i] = el }} visible={false}>
              <boxGeometry args={[HALF_FULL_W, DIE_SIZE, DIE_SIZE]} />
              {fragMats[i].map((tex, fi) => (
                <meshStandardMaterial
                  key={fi}
                  attach={`material-${fi}`}
                  map={tex}
                  roughness={0.4}
                  metalness={0.0}
                />
              ))}
            </mesh>
          </RigidBody>
        ))}
      </>
    )
  }
)
