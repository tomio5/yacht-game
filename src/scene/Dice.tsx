import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { RigidBody, RapierRigidBody } from '@react-three/rapier'
import { Quaternion as ThreeQuat, Vector3, Euler } from 'three'
import { createFaceTexture, MATERIAL_FACE_VALUES } from './diceTexture'
import type { DieValue } from '../game/types'

const TARGET_NORMALS: Record<DieValue, [number, number, number]> = {
  1: [ 0,  1,  0],  6: [ 0, -1,  0],
  2: [ 0,  0,  1],  5: [ 0,  0, -1],
  3: [ 1,  0,  0],  4: [-1,  0,  0],
}

/**
 * ターゲット面が「上」を向く初期回転。
 * - フィールドに落下するダイス用（A方式：目標面UP → 着地でUPのまま）
 * - コップ内ダイスは faceDown=true を渡す
 */
function computeInitRot(target: DieValue, faceDown = false): [number, number, number] {
  const localNormal = new Vector3(...TARGET_NORMALS[target])
  const dir = new Vector3(0, faceDown ? -1 : 1, 0)
  const q = new ThreeQuat().setFromUnitVectors(localNormal, dir)
  const yRot = new ThreeQuat().setFromAxisAngle(new Vector3(0, 1, 0), Math.random() * Math.PI * 2)
  const final = new ThreeQuat().multiplyQuaternions(yRot, q)
  const e = new Euler().setFromQuaternion(final, 'XYZ')
  return [e.x, e.y, e.z]
}

export interface DiceConfig {
  id:            number
  targetValue:   DieValue
  launchPos:     [number, number, number]
  launchImpulse: { x: number; y: number; z: number }
  launchTorque:  { x: number; y: number; z: number }
  faceDown?:     boolean   // コップ内配置時に true
}

interface DiceProps extends DiceConfig {
  onSettle?: (id: number, value: DieValue) => void
}

export function Dice({ id, targetValue, launchPos, launchImpulse, launchTorque, faceDown, onSettle }: DiceProps) {
  const rbRef    = useRef<RapierRigidBody>(null)
  const launched = useRef(false)
  const settled  = useRef(false)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initRot  = useMemo(() => computeInitRot(targetValue, faceDown), [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const textures = useMemo(() => MATERIAL_FACE_VALUES.map(createFaceTexture), [])

  useFrame(() => {
    if (launched.current || !rbRef.current) return
    launched.current = true
    const { x: ix, y: iy, z: iz } = launchImpulse
    const { x: tx, y: ty, z: tz } = launchTorque
    if (ix || iy || iz) rbRef.current.applyImpulse(launchImpulse, true)
    if (tx || ty || tz) rbRef.current.applyTorqueImpulse(launchTorque, true)
  })

  const handleSleep = () => {
    if (settled.current) return
    settled.current = true
    onSettle?.(id, targetValue)
  }

  return (
    <RigidBody
      ref={rbRef}
      colliders="cuboid"
      position={launchPos}
      rotation={initRot}
      restitution={0.25}
      friction={0.8}
      linearDamping={0.5}
      angularDamping={0.5}
      ccd={true}
      onSleep={handleSleep}
    >
      <mesh castShadow>
        <boxGeometry args={[1, 1, 1]} />
        {textures.map((tex, i) => (
          <meshStandardMaterial key={i} attach={`material-${i}`} map={tex} roughness={0.4} metalness={0.0} />
        ))}
      </mesh>
    </RigidBody>
  )
}
