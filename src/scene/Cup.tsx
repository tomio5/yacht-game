import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import type { RapierRigidBody } from '@react-three/rapier'
import { Group, Quaternion as ThreeQuat, Euler, DoubleSide } from 'three'
import type { DieValue } from '../game/types'

export const CUP_IDLE_X      = 6
export const CUP_IDLE_Y      = 1.75
export const CUP_IDLE_Z      = 0
export const CUP_HEIGHT      = 3.5
export const CUP_R_TOP       = 2.2
export const CUP_R_BOT       = 1.8
export const CUP_INNER_R     = 0.65
export const CUP_DICE_WORLD_Y = 0.62   // コップ底面の上でのダイス中心 Y

const N_WALLS = 12
const WALL_T  = 0.10

type CupState = 'idle' | 'shaking' | 'pouring'

export interface CupCallbacks {
  onShaking: (targets: DieValue[]) => void
  onIdle:    () => void
  onPour:    (targets: DieValue[]) => void   // targets を再度渡す
}

export function Cup({ onShaking, onIdle, onPour }: CupCallbacks) {
  const cupBodyRef = useRef<RapierRigidBody>(null)
  const visualRef  = useRef<Group>(null)
  const stateRef   = useRef<CupState>('idle')
  const shakeT     = useRef(0)
  const pourT      = useRef(0)
  const holdStart  = useRef<number | null>(null)
  const targets    = useRef<DieValue[]>([])
  const poured     = useRef(false)

  const wallSegs = useMemo(() =>
    Array.from({ length: N_WALLS }, (_, i) => {
      const angle   = (i / N_WALLS) * Math.PI * 2
      const arcHalf = Math.PI * CUP_R_BOT / N_WALLS + 0.08
      return {
        pos: [Math.cos(angle) * CUP_R_BOT, 0, Math.sin(angle) * CUP_R_BOT] as [number, number, number],
        rot: [0, angle, 0] as [number, number, number],
        args: [WALL_T, CUP_HEIGHT / 2 + 0.15, arcHalf] as [number, number, number],
      }
    })
  , [])

  const handleDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    if (stateRef.current !== 'idle') return
    holdStart.current = Date.now()
    stateRef.current = 'shaking'
    shakeT.current = 0
    targets.current = Array.from({ length: 5 }, () =>
      (Math.floor(Math.random() * 6) + 1) as DieValue
    )
    onShaking(targets.current)
  }

  const handleUp = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    if (stateRef.current !== 'shaking') return
    const held = holdStart.current !== null ? Date.now() - holdStart.current : 0
    holdStart.current = null
    if (held < 1000) {
      stateRef.current = 'idle'
      onIdle()
      return
    }
    stateRef.current = 'pouring'
    pourT.current = 0
    poured.current = false
  }

  const handleLeave = () => {
    if (stateRef.current === 'shaking') {
      holdStart.current = null
      stateRef.current = 'idle'
      onIdle()
    }
  }

  useFrame((_, delta) => {
    const cb = cupBodyRef.current
    const vg = visualRef.current
    if (!vg) return

    const state = stateRef.current
    let px = CUP_IDLE_X, py = CUP_IDLE_Y, pz = CUP_IDLE_Z
    let rx = 0, rz = 0

    if (state === 'shaking') {
      shakeT.current += delta
      const t = shakeT.current
      px = CUP_IDLE_X + Math.sin(t * 13) * 0.14
      py = CUP_IDLE_Y + Math.abs(Math.sin(t * 9)) * 0.10
      pz = CUP_IDLE_Z + Math.cos(t * 11) * 0.12
      rx = Math.sin(t * 10) * 0.07
      rz = Math.cos(t * 12) * 0.07
    } else if (state === 'pouring') {
      pourT.current = Math.min(1, pourT.current + delta * 1.4)
      const t = pourT.current
      px = CUP_IDLE_X + (0 - CUP_IDLE_X) * t
      py = CUP_IDLE_Y + Math.sin(t * Math.PI) * 3 + (4 - CUP_IDLE_Y) * t
      rz = Math.PI * Math.min(1, t * 1.6)

      if (t >= 0.6 && !poured.current) {
        poured.current = true
        onPour(targets.current)   // ← ここでフィールドダイスを生成させる
      }
      if (t >= 1) {
        stateRef.current = 'idle'
        onIdle()
      }
    } else {
      shakeT.current = 0
    }

    const quat = new ThreeQuat().setFromEuler(new Euler(rx, 0, rz, 'XYZ'))

    // pour 中は物理ボディを動かさない（高速回転でダイスが吹き飛ぶのを防止）
    if (state !== 'pouring' && cb) {
      cb.setNextKinematicTranslation({ x: px, y: py, z: pz })
      cb.setNextKinematicRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
    }

    vg.position.set(px, py, pz)
    vg.quaternion.copy(quat)
  })

  return (
    <>
      <RigidBody
        ref={cupBodyRef}
        type="kinematicPosition"
        position={[CUP_IDLE_X, CUP_IDLE_Y, CUP_IDLE_Z]}
      >
        <CuboidCollider args={[CUP_R_BOT, 0.05, CUP_R_BOT]} position={[0, -CUP_HEIGHT / 2, 0]} />
        {wallSegs.map((w, i) => (
          <CuboidCollider key={i} args={w.args} position={w.pos} rotation={w.rot} />
        ))}
      </RigidBody>

      <group ref={visualRef} position={[CUP_IDLE_X, CUP_IDLE_Y, CUP_IDLE_Z]}>
        <mesh castShadow onPointerDown={handleDown} onPointerUp={handleUp} onPointerLeave={handleLeave}>
          <cylinderGeometry args={[CUP_R_TOP, CUP_R_BOT, CUP_HEIGHT, 32, 1, true]} />
          <meshStandardMaterial color="#0e0e0e" roughness={0.88} metalness={0.08} side={DoubleSide} />
        </mesh>
        <mesh position={[0, -CUP_HEIGHT / 2, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <circleGeometry args={[CUP_R_BOT, 32]} />
          <meshStandardMaterial color="#0e0e0e" roughness={0.88} metalness={0.08} />
        </mesh>
        <mesh position={[0, -CUP_HEIGHT / 2 + 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[CUP_R_BOT - 0.06, 32]} />
          <meshStandardMaterial color="#1a3a7a" roughness={0.95} />
        </mesh>
        <mesh position={[0, CUP_HEIGHT / 2, 0]}>
          <torusGeometry args={[CUP_R_TOP, 0.06, 10, 48]} />
          <meshStandardMaterial color="#1a1a1a" roughness={0.80} metalness={0.15} />
        </mesh>
      </group>
    </>
  )
}
