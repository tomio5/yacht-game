/**
 * FractureSystem.tsx
 * 「分解→飛散→再集合→終了」を1パッケージで実行する独立モジュール（雷v2・将来の斬撃等で共有）。
 *
 * 設計（物理演出ポリシー準拠）:
 * - 欠片 RigidBody を起動時に 32 個常設。以後 add/remove は一切しない（visible/teleport/setLinvel のみ）。
 * - 非演出時は visible=false・kinematic でシーン外へ退避。
 * - kinematic→dynamic 直後の速度付与は setLinvel/setAngvel（invMass 非依存）で行う。
 * - 欠片は床/壁/他ダイス/欠片同士と衝突（group0）。演出物体（発光メッシュ等＝コライダー無し）とは当たらない。
 * - 各フェイズは時間ベースで必ず進む＝ハングしない。全体 timeout も保険で持つ。
 *
 * フェイズ: explode（爆散初速）→ scatter（物理任せ）→ assemble（kinematic で origin へ収束）→ cleanup（退避）。
 */

import { forwardRef, useImperativeHandle, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { RigidBody, CuboidCollider, interactionGroups } from '@react-three/rapier'
import type { RapierRigidBody } from '@react-three/rapier'
import { RigidBodyType } from '@dimforge/rapier3d-compat'
import { Vector3, Quaternion as ThreeQuat, Euler } from 'three'
import type { Mesh } from 'three'

// ── 定数（すべて実機調整可） ─────────────────────────────
const FRAG_COUNT_MAX = 128         // 常設プール数（増減しない）
const FRAG_SIZE      = 0.33        // 欠片サイズ（元ダイス 1/3 程度）
const FRAG_HALF      = FRAG_SIZE / 2
const FRAG_GROUP     = interactionGroups(0, [0])   // 床/壁/ダイス/欠片同士と衝突
const PARK           = new Vector3(140, -80, 140)  // 非演出時の退避座標（シーン外）
// 欠片の物理マテリアル（弾けあって乗っかる／永遠に弾け続けない値域）
const FRAG_RESTITUTION = 0.3
const FRAG_FRICTION    = 0.7
const FRAG_LINDAMP     = 0.6
const FRAG_ANGDAMP     = 0.4

export interface FractureExplodeOpts {
  hSpeed:      number   // 水平初速の振れ幅(±)
  vSpeed:      number   // 垂直初速（中心値・上向き）
  torque:      number   // 角速度の振れ幅(±)
  spread:      number   // 爆散開始の teleport 半径
  explodeDur:  number   // 爆散初速を与えてからの猶予（秒）
  scatterDur:  number   // 物理任せ期間（秒）
  lingerDur:   number   // 散らばり終わったあとの余韻（秒。欠片は dynamic のまま静止して見せる）
  assembleDur: number   // origin へ収束する期間（秒）
  totalTimeout: number  // 全体の安全 timeout（秒）
}

export interface FractureSystemHandle {
  /** 分解演出を1パッケージで実行。onAssembled=収束終端の少し手前で1回／onComplete=退避完了後。 */
  fracture(
    origin: [number, number, number],
    count: number,
    opts: FractureExplodeOpts,
    onAssembled: () => void,
    onComplete: () => void,
  ): void
}

type Phase = 'idle' | 'explode' | 'scatter' | 'linger' | 'assemble' | 'cleanup'

export const FractureSystem = forwardRef<FractureSystemHandle, object>(
  function FractureSystem(_props, ref) {
    const bodies = useRef<(RapierRigidBody | null)[]>(Array(FRAG_COUNT_MAX).fill(null))
    const meshes = useRef<(Mesh | null)[]>(Array(FRAG_COUNT_MAX).fill(null))

    const phase   = useRef<Phase>('idle')
    const t       = useRef(0)        // フェイズ内経過
    const totalT  = useRef(0)        // 全体経過（timeout 用）
    const count   = useRef(0)
    const origin  = useRef(new Vector3())
    const opts    = useRef<FractureExplodeOpts | null>(null)
    const pendingExplode = useRef(false)
    const assembleFrom   = useRef<Vector3[]>([])      // assemble 開始時の各欠片位置
    const assembleTo     = useRef<Vector3[]>([])      // 収束先（origin 近傍の微小ばらけ）
    const assembledFired = useRef(false)
    const onAssembledCb  = useRef<(() => void) | null>(null)
    const onCompleteCb   = useRef<(() => void) | null>(null)

    const parkPos = (i: number): [number, number, number] =>
      [PARK.x + (i % 8) * 0.6, PARK.y, PARK.z + Math.floor(i / 8) * 0.6]

    useImperativeHandle(ref, () => ({
      fracture(o, c, op, onAssembled, onComplete) {
        origin.current.set(o[0], o[1], o[2])
        count.current = Math.min(c, FRAG_COUNT_MAX)
        opts.current = op
        onAssembledCb.current = onAssembled
        onCompleteCb.current  = onComplete
        assembledFired.current = false
        pendingExplode.current = true
        phase.current = 'explode'
        t.current = 0
        totalT.current = 0
      },
    }))

    useFrame((_, dt) => {
      if (phase.current === 'idle' || !opts.current) return
      const op = opts.current
      const n  = count.current
      t.current += dt
      totalT.current += dt

      // 全体 timeout: 強制 cleanup（最終状態は同一に収束）
      if (totalT.current >= op.totalTimeout && phase.current !== 'cleanup') {
        if (!assembledFired.current) { assembledFired.current = true; onAssembledCb.current?.() }
        phase.current = 'cleanup'; t.current = 0
      }

      // ── EXPLODE: 非表示→origin 周辺へ teleport＋dynamic＋爆散初速 ──
      if (phase.current === 'explode') {
        if (pendingExplode.current) {
          pendingExplode.current = false
          for (let i = 0; i < n; i++) {
            const rb = bodies.current[i]
            if (!rb) continue
            const px = origin.current.x + (Math.random() * 2 - 1) * op.spread
            const py = origin.current.y + (Math.random() * 2 - 1) * op.spread
            const pz = origin.current.z + (Math.random() * 2 - 1) * op.spread
            rb.setBodyType(RigidBodyType.Dynamic, true)
            rb.setTranslation({ x: px, y: py, z: pz }, true)
            const q = new ThreeQuat().setFromEuler(
              new Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2))
            rb.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
            rb.wakeUp()
            // 速度直接指定（kinematic→dynamic 直後の invMass 罠回避）
            rb.setLinvel({
              x: (Math.random() * 2 - 1) * op.hSpeed,
              y: op.vSpeed * (0.7 + Math.random() * 0.6),
              z: (Math.random() * 2 - 1) * op.hSpeed,
            }, true)
            rb.setAngvel({
              x: (Math.random() * 2 - 1) * op.torque,
              y: (Math.random() * 2 - 1) * op.torque,
              z: (Math.random() * 2 - 1) * op.torque,
            }, true)
            const m = meshes.current[i]
            if (m) m.visible = true
          }
        }
        if (t.current >= op.explodeDur) { phase.current = 'scatter'; t.current = 0 }
        return
      }

      // ── SCATTER: 物理任せ（重力・欠片同士・他ダイス・床壁と自然に衝突） ──
      if (phase.current === 'scatter') {
        if (t.current >= op.scatterDur) { phase.current = 'linger'; t.current = 0 }
        return
      }

      // ── LINGER: 散らばり終わったあとの余韻（dynamic のまま静止して見せる） ──
      if (phase.current === 'linger') {
        if (t.current >= op.lingerDur) {
          // assemble の始点（現在位置）と収束先（origin 近傍微小ばらけ）を確定し、全部 kinematic に
          assembleFrom.current = []
          assembleTo.current = []
          for (let i = 0; i < n; i++) {
            const rb = bodies.current[i]
            const tr = rb?.translation()
            assembleFrom.current[i] = tr ? new Vector3(tr.x, tr.y, tr.z) : origin.current.clone()
            const a = Math.random() * Math.PI * 2
            const rr = Math.random() * 0.05
            assembleTo.current[i] = new Vector3(
              origin.current.x + Math.cos(a) * rr,
              origin.current.y + (Math.random() * 2 - 1) * 0.05,
              origin.current.z + Math.sin(a) * rr,
            )
            if (rb) {
              rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
              rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
              rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
            }
          }
          phase.current = 'assemble'; t.current = 0
        }
        return
      }

      // ── ASSEMBLE: kinematic で origin へ収束（ease-out）。終端手前で onAssembled ──
      if (phase.current === 'assemble') {
        const k = Math.min(1, t.current / op.assembleDur)
        const e = 1 - (1 - k) * (1 - k)   // ease-out
        for (let i = 0; i < n; i++) {
          const rb = bodies.current[i]
          if (!rb) continue
          const p = assembleFrom.current[i].clone().lerp(assembleTo.current[i], e)
          rb.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z })
        }
        if (!assembledFired.current && k >= 0.85) {   // 収束終端の少し手前で1回
          assembledFired.current = true
          onAssembledCb.current?.()
        }
        if (k >= 1) { phase.current = 'cleanup'; t.current = 0 }
        return
      }

      // ── CLEANUP: visible=false＋速度ゼロ＋退避座標へ。1フレーム確認後 onComplete ──
      if (phase.current === 'cleanup') {
        for (let i = 0; i < n; i++) {
          const rb = bodies.current[i]
          if (rb) {
            rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
            rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
            rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
            const pk = parkPos(i)
            rb.setNextKinematicTranslation({ x: pk[0], y: pk[1], z: pk[2] })
          }
          const m = meshes.current[i]
          if (m) m.visible = false
        }
        // 退避を1フレーム反映してから完了（onComplete 後にカップ等が動いても事故らないよう保証）
        if (t.current >= dt * 1.5) {
          phase.current = 'idle'
          const cb = onCompleteCb.current
          onCompleteCb.current = null
          cb?.()
        }
        return
      }
    })

    return (
      <>
        {Array.from({ length: FRAG_COUNT_MAX }).map((_, i) => (
          <RigidBody
            key={i}
            ref={(el) => { bodies.current[i] = el }}
            type="kinematicPosition"
            colliders={false}
            collisionGroups={FRAG_GROUP}
            restitution={FRAG_RESTITUTION}
            friction={FRAG_FRICTION}
            linearDamping={FRAG_LINDAMP}
            angularDamping={FRAG_ANGDAMP}
            ccd
            position={parkPos(i)}
          >
            {/* 明示コライダー（visible=false マウントでも mass>0 を保証＝cuboid 自動生成の落とし穴回避） */}
            <CuboidCollider args={[FRAG_HALF, FRAG_HALF, FRAG_HALF]} />
            <mesh ref={(el) => { meshes.current[i] = el }} visible={false}>
              <boxGeometry args={[FRAG_SIZE, FRAG_SIZE, FRAG_SIZE]} />
              <meshStandardMaterial color="#e9e9ee" roughness={0.5} metalness={0.0} />
            </mesh>
          </RigidBody>
        ))}
      </>
    )
  },
)
