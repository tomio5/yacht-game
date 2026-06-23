/**
 * CupAnim.tsx v4 — ロール演出 + カップ隠し演出 両モード
 *
 * ■ ロールモード (反転アニメ修正版)
 *   通常時: カップ口が上向き (face-up) で HOME (右下) に表示
 *   ホールド: HOME で内側ダイスがカチャカチャ
 *   離す (最低 0.5 s 後):
 *     (1) HOME → POUR_POS (中央やや右・高め) へ移動 (揺れ継続)
 *     (2) POUR_POS で 140° 反転して停止
 *         → 口が横向き (90°) になったら内側ダイスを隠す
 *     (3) 140°停止から 0.2 s 後に onSpawn 発火
 *     (4) さらに 0.2 s 後に HOME へ帰還 (z: 140° → 0°)
 *
 * ■ カップ隠しモード
 *   animate(tx, tz, onCovered, onDone) → 従来通り
 *
 * ■ 爆発防止
 *   カップは物理なし。ダイスとカップは物理接触ゼロ。
 */

import { useRef, forwardRef, useImperativeHandle, useEffect, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  RigidBody, CuboidCollider, interactionGroups,
  useBeforePhysicsStep, useAfterPhysicsStep,
} from '@react-three/rapier'
import type { RapierRigidBody, CollisionEnterPayload } from '@react-three/rapier'
import { Group, FrontSide, BackSide } from 'three'
import { createFaceTexture, MATERIAL_FACE_VALUES } from './diceTexture'
import { playDiceHit } from '../game/audio'
import type { DieValue } from '../game/types'

// ── 定数 ──────────────────────────────────────────────
export const CUP_HEIGHT   = 4.5
export const CUP_R_TOP    = 2.8
export const CUP_R_BOT    = 2.4
export const CUP_CENTER_Y = CUP_HEIGHT / 2   // 2.25

/** カップ定位置（画面右下） */
export const HOME_POS: [number, number, number] = [7, CUP_CENTER_Y, 5]

/** ダイスを注ぐ位置（中央やや右・高め）。反転がフィールドすれすれにならないよう高くする */
export const POUR_POS: [number, number, number] = [5.0, 7.0, 0.5]

/** 反転角度 140° */
const POUR_ANGLE = 140 * Math.PI / 180   // ≈ 2.443 rad

/** 内側ダイスを隠す角度しきい値 (z = π/2 = 90°) の pour 進捗 */
const HIDE_T = (Math.PI / 2) / POUR_ANGLE   // ≈ 0.643

const MIN_HOLD_SECS   = 0.5
const MOVE_DURATION   = 0.5    // HOME → POUR_POS
const POUR_DURATION   = 0.45   // z: 0 → POUR_ANGLE
const HOLD_AFTER_POUR = 0.05   // 140°到達後すぐにこぼす（傾けた瞬間に投入＝自然なpour）
const HOLD_AFTER_SPAWN = 0.2   // onSpawn 発火後、帰還開始までの待ち
const RETURN_DURATION = 0.65   // POUR_POS → HOME

// フェイク投入: 空振り1回の尺と、前へあおる振れ幅、1回目後の静止時間（実機調整可）
const FAKE_PUMP_DUR = 0.42
const FAKE_PUMP_AMP = 0.45
const FAKE_PAUSE    = 1.0   // 1回目の空振り直後に挟む静止（秒）

const SHAKE_FREQ = 9.0
const CUP_SHAKE_AMP = 0.12   // カチャカチャ中のカップ本体の振れ幅（水平のみ。傾けると底が浮いて緑が出る）

// 演出ダイス（見た目）の静止位置。引き継ぎフォールバック用
const INNER_BASE: [number, number, number][] = [
  [ 1.05, -1.65,  0.65],
  [-1.00, -1.65, -0.60],
  [ 0.30, -1.75, -1.10],
  [-0.70, -1.65,  1.00],
  [ 0.95, -1.75, -0.55],
]

// ── カップ内 物理ラトル（常設・5個固定。add/remove しない＝Rapier再帰借用クラッシュ回避） ──
// ・dynamic ボディは常にマウント。ON/OFF は「動かす/見せる」だけで切替（存在は不変）。
// ・物理操作は useFrame でなく useBeforePhysicsStep で行う（World借用の競合回避）。
// ・衝突グループ group1 でフィールドダイス(group0)から完全隔離（誤衝突・干渉なし）。
const RATTLE_GROUP = interactionGroups(1, [1])   // group1 同士のみ衝突
const RATTLE_R           = 2.0
const RATTLE_WALL_N      = 8
const RATTLE_WALL_HALF_H = 2.0
const RATTLE_LID_Y       = CUP_HEIGHT * 0.7
const RATTLE_TARGET_SPEED = 1.5
const RATTLE_SPEED        = 10.0
const RATTLE_VY_MAX       = 3.0
const RATTLE_SPIN         = 26.0
const RATTLE_DIE_POS: [number, number, number][] = [
  [ 0.0, 0.7,  0.0],
  [ 1.1, 0.6,  0.1],
  [-1.1, 0.6, -0.1],
  [ 0.1, 0.6,  1.1],
  [-0.1, 0.6, -1.1],
]
// カップ内ラトルの衝突音（フィールドと同じ音源を流用。容器内なので控えめ）
const RATTLE_HIT_SPEED_MIN = 2.0   // これ未満の接触は鳴らさない
const RATTLE_HIT_COOLDOWN  = 0.08  // ダイスごとのクールダウン（クラッタ抑制）

function CupRattle({ active, count, bodiesRef }: {
  active: boolean
  count: number
  bodiesRef: { current: (RapierRigidBody | null)[] }
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const textures = useMemo(() => MATERIAL_FACE_VALUES.map(createFaceTexture), [])
  // step コールバックが最新値を読むためのミラー（stale closure 回避）
  const activeRef = useRef(active); activeRef.current = active
  const countRef  = useRef(count);  countRef.current  = count
  // 衝突音のクールダウン（ダイスごと）
  const hitTimesRef = useRef<number[]>([0, 0, 0, 0, 0])

  function onRattleHit(i: number, p: CollisionEnterPayload) {
    if (!activeRef.current) return   // ラトル中だけ鳴らす
    const rb = bodiesRef.current[i]
    if (!rb) return
    const now = performance.now() / 1000
    if (now - hitTimesRef.current[i] < RATTLE_HIT_COOLDOWN) return
    const v = rb.linvel()
    const speed = Math.hypot(v.x, v.y, v.z)
    if (speed < RATTLE_HIT_SPEED_MIN) return
    hitTimesRef.current[i] = now
    const otherKind = (p.other.rigidBodyObject?.userData as { kind?: string } | undefined)?.kind
    const kind = otherKind === 'die' ? 'clack' : 'land'   // 相手がダイス→clack、容器→land
    const intensity = 0.25 + Math.min(1, speed / 8) * 0.5  // 控えめ
    playDiceHit(kind, intensity)
  }

  // 物理操作は beforeStep で（useFrame と違い World ステップと競合しない）
  useBeforePhysicsStep(() => {
    if (!activeRef.current) return
    const n = countRef.current
    for (let i = 0; i < n; i++) {
      const rb = bodiesRef.current[i]
      if (!rb || rb.mass() <= 0) continue
      const v = rb.linvel()
      if (v.y > RATTLE_VY_MAX) rb.setLinvel({ x: v.x, y: RATTLE_VY_MAX, z: v.z }, true)
      const hsp = Math.hypot(v.x, v.z)
      if (hsp < RATTLE_TARGET_SPEED) {
        rb.setLinvel({
          x: (Math.random() - 0.5) * RATTLE_SPEED,
          y: Math.min(v.y, RATTLE_VY_MAX),
          z: (Math.random() - 0.5) * RATTLE_SPEED,
        }, true)
        rb.setAngvel({
          x: (Math.random() - 0.5) * RATTLE_SPIN,
          y: (Math.random() - 0.5) * RATTLE_SPIN * 0.4,
          z: (Math.random() - 0.5) * RATTLE_SPIN,
        }, true)
      }
    }
  })

  const hx = HOME_POS[0]
  const hz = HOME_POS[2]
  return (
    <group>
      {/* 容器（常設・fixed・group1）: 円周ウォール＋蓋＋底。動かない */}
      <RigidBody type="fixed" colliders={false} collisionGroups={RATTLE_GROUP} userData={{ kind: 'cup' }}>
        {Array.from({ length: RATTLE_WALL_N }).map((_, k) => {
          const a = (k / RATTLE_WALL_N) * Math.PI * 2
          return (
            <CuboidCollider
              key={k}
              args={[0.15, RATTLE_WALL_HALF_H, 1.3]}
              position={[hx + Math.cos(a) * RATTLE_R, RATTLE_WALL_HALF_H, hz + Math.sin(a) * RATTLE_R]}
              rotation={[0, -a, 0]}
            />
          )
        })}
        <CuboidCollider args={[RATTLE_R + 0.3, 0.1, RATTLE_R + 0.3]} position={[hx, RATTLE_LID_Y, hz]} />
        {/* 底（group1隔離なのでメイン床に頼れない。専用の底を置く） */}
        <CuboidCollider args={[RATTLE_R + 0.3, 0.2, RATTLE_R + 0.3]} position={[hx, -0.2, hz]} />
      </RigidBody>

      {/* dynamic ダイス 5個固定（常設）。active && i<count のときだけ見せる。ボディは消さない */}
      {RATTLE_DIE_POS.map((p, i) => (
        <RigidBody
          key={i}
          ref={(el) => { bodiesRef.current[i] = el }}
          colliders={false}
          collisionGroups={RATTLE_GROUP}
          userData={{ kind: 'die' }}
          position={[hx + p[0], p[1], hz + p[2]]}
          restitution={0.5}
          friction={0.3}
          linearDamping={0.1}
          angularDamping={0.1}
          ccd
          onCollisionEnter={(e) => onRattleHit(i, e)}
        >
          {/* 明示コライダー: メッシュ可視状態に依存せず常に質量を持つ（mass=0 回避） */}
          <CuboidCollider args={[0.5, 0.5, 0.5]} collisionGroups={RATTLE_GROUP} />
          <mesh castShadow raycast={() => null} visible={active && i < count}>
            <boxGeometry args={[1, 1, 1]} />
            {textures.map((tex, j) => (
              <meshStandardMaterial key={j} attach={`material-${j}`} map={tex} roughness={0.85} metalness={0.0} />
            ))}
          </mesh>
        </RigidBody>
      ))}
    </group>
  )
}

// ── 型 ────────────────────────────────────────────────
type CupPhase =
  | 'idle'
  | 'roll_ready'
  | 'roll_shaking'    // HOME で揺れる (ホールド中)
  | 'roll_moving'     // HOME → POUR_POS (揺れたまま)
  | 'roll_pouring'    // z: 0 → POUR_ANGLE (140°)
  | 'roll_hold'       // 140°で停止 → 0.2s 待機
  | 'roll_fake'       // フェイク投入: 傾いたまま空振りを繰り返す → 最後に射出
  | 'roll_spawn_wait' // onSpawn 発火後 → 0.2s 待機
  | 'roll_returning'  // POUR_POS → HOME, z: POUR_ANGLE → 0
  | 'conceal_going'
  | 'conceal_covering'
  | 'conceal_returning'

export interface CupAnimHandle {
  animate(
    targetX:   number,
    targetZ:   number,
    onCovered: () => void,
    onDone:    () => void
  ): void
  /** count: カップに入っている中身の数（再振り時は非キープ数）。省略時は showValues 全数 */
  setRollReady(showValues: DieValue[], count?: number): void
  clearRoll(): void
  triggerAutoRoll(): void
  /** 観戦側用: autoRoll=false でシェイク開始（releaseThrow() が呼ばれるまでホールド継続） */
  triggerSyncRoll(): void
  /** 観戦側用: アクティブ側の pointerup に合わせて holdReleased をセット */
  releaseThrow(): void
  /** 現在のフェイズが idle か（HOME で完全静止中）。pre_gather_cover で animate 発火前に確認用 */
  isIdle(): boolean
  /** フェイク投入: 次の投入で「傾いたまま空振り(再投入モーション)を n 回してから射出」。0 で通常。 */
  setFakeThrow(n: number): void
}

interface CupAnimProps {
  /** プレイヤーがカップをクリックして投入を開始した瞬間に呼ばれる（net mode でタイミング同期に使う） */
  onThrowStart?: () => void
  /** プレイヤーがポインタを離した瞬間に呼ばれる（net mode でホールド時間同期に使う） */
  onThrowRelease?: () => void
  /**
   * 140°停止から 0.2s 後に呼ばれる。
   * pourOrigin: ダイスを生成する起点 (world 座標)
   */
  onSpawn?: (pourOrigin: [number, number, number]) => void
  /**
   * カップを手動クリックで投げられるか。false のときポインタ操作を無視する。
   * ネット対戦の観戦側（相手ターン）では false にして、観戦側カップが自分で投入を開始しないようにする。
   * triggerSyncRoll/triggerAutoRoll（プログラム呼び出し）はこのフラグに関係なく動く。
   */
  canThrow?: boolean
}

// ── コンポーネント ─────────────────────────────────────
export const CupAnim = forwardRef<CupAnimHandle, CupAnimProps>(
  function CupAnim({ onSpawn, onThrowStart, onThrowRelease, canThrow = true }, ref) {

    const groupRef  = useRef<Group>(null)
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const innerRefs = INNER_BASE.map(() => useRef<Group>(null))

    // カップ内 物理ラトル制御（常設ボディを「動かす/見せる」で切替）
    const [rattle,   setRattle]   = useState(false)
    const [cupCount, setCupCount] = useState(5)
    const cupCountRef     = useRef(5)
    const rattleBodiesRef = useRef<(RapierRigidBody | null)[]>([])
    const handoffPendingRef = useRef(false)   // 解放時、ラトル姿勢を見た目へ引き継ぐ要求

    const phase        = useRef<CupPhase>('idle')
    const t            = useRef(0)
    const shakeTime    = useRef(0)
    const holdReleased = useRef(false)
    const innerHidden  = useRef(false)   // 内側ダイスを隠したか
    const autoRoll     = useRef(false)
    const fakePumps    = useRef(0)       // フェイク投入: 残り空振り回数（roll_hold で消費）
    const fakeTotal    = useRef(0)       // フェイク投入: 総空振り回数（1回目判定用）
    const fakeT        = useRef(0)       // フェイク投入: 1回の空振りの進行(0..1)
    const fakePauseT   = useRef(0)       // フェイク投入: 1回目後の静止の残り(秒)
    const readyAt      = useRef(0)       // roll_ready になった時刻(ms)。誤発火防止用

    const targetXZ     = useRef<[number, number]>([0, 0])
    const coveredFired = useRef(false)
    const onCoveredCb  = useRef<(() => void) | null>(null)
    const onDoneCb     = useRef<(() => void) | null>(null)

    const onSpawnRef        = useRef(onSpawn)
    const onThrowStartRef   = useRef(onThrowStart)
    const onThrowReleaseRef = useRef(onThrowRelease)
    const canThrowRef       = useRef(canThrow)
    useEffect(() => { onSpawnRef.current        = onSpawn        }, [onSpawn])
    useEffect(() => { onThrowStartRef.current   = onThrowStart   }, [onThrowStart])
    useEffect(() => { onThrowReleaseRef.current = onThrowRelease }, [onThrowRelease])
    useEffect(() => { canThrowRef.current       = canThrow       }, [canThrow])

    useEffect(() => {
      const handleUp = () => {
        if (phase.current === 'roll_shaking' || phase.current === 'roll_moving') {
          holdReleased.current = true
          onThrowReleaseRef.current?.()
        }
      }
      window.addEventListener('pointerup', handleUp)
      return () => window.removeEventListener('pointerup', handleUp)
    }, [])

    useImperativeHandle(ref, () => ({
      animate(tx, tz, onCov, onDone) {
        innerRefs.forEach(r => { if (r.current) r.current.visible = false })
        phase.current        = 'conceal_going'
        t.current            = 0
        coveredFired.current = false
        targetXZ.current     = [tx, tz]
        onCoveredCb.current  = onCov
        onDoneCb.current     = onDone
      },
      setRollReady(_sv, count = 5) {
        cupCountRef.current = count
        setCupCount(count)
        setRattle(false)
        // roll_ready は「カップに中身が載っている」見た目。見た目ダイスを count 個表示
        innerRefs.forEach((r, i) => {
          if (!r.current) return
          r.current.visible = i < count
          const [bx, by, bz] = INNER_BASE[i]
          r.current.position.set(bx, by, bz)
          r.current.rotation.set(0, 0, 0)
        })
        holdReleased.current = false
        innerHidden.current  = false
        autoRoll.current     = false
        phase.current        = 'roll_ready'
        readyAt.current      = performance.now()
      },
      clearRoll() {
        if (phase.current === 'roll_ready') phase.current = 'idle'
      },
      triggerAutoRoll() {
        if (phase.current !== 'roll_ready') return
        holdReleased.current = false
        innerHidden.current  = false
        autoRoll.current     = true
        shakeTime.current    = 0
        phase.current        = 'roll_shaking'
        t.current            = 0
        setRattle(true)
      },
      triggerSyncRoll() {
        if (phase.current !== 'roll_ready') return
        holdReleased.current = false
        innerHidden.current  = false
        autoRoll.current     = false   // 手動解放待ち（releaseThrow() が呼ばれるまでホールド）
        shakeTime.current    = 0
        phase.current        = 'roll_shaking'
        t.current            = 0
        setRattle(true)
      },
      releaseThrow() {
        if (phase.current === 'roll_shaking' || phase.current === 'roll_moving') {
          holdReleased.current = true
        }
      },
      isIdle() {
        return phase.current === 'idle'
      },
      setFakeThrow(n: number) {
        fakePumps.current = Math.max(0, n)
        fakeTotal.current = Math.max(0, n)
        fakePauseT.current = 0
      },
    }))

    // ── ラトル姿勢の引き継ぎ（物理 read は afterStep で行う） ──
    useAfterPhysicsStep(() => {
      if (!handoffPendingRef.current) return
      handoffPendingRef.current = false
      const g = groupRef.current
      const gx = g ? g.position.x : HOME_POS[0]
      const gy = g ? g.position.y : HOME_POS[1]
      const gz = g ? g.position.z : HOME_POS[2]
      innerRefs.forEach((r, i) => {
        if (!r.current) return
        if (i >= cupCountRef.current) { r.current.visible = false; return }
        r.current.visible = true
        const body = rattleBodiesRef.current[i]
        if (body) {
          const p = body.translation()
          const q = body.rotation()
          r.current.position.set(p.x - gx, p.y - gy, p.z - gz)
          r.current.quaternion.set(q.x, q.y, q.z, q.w)
        } else {
          const [bx, by, bz] = INNER_BASE[i]
          r.current.position.set(bx, by, bz)
          r.current.rotation.set(0, 0, 0)
        }
      })
    })

    const diceTextures = useMemo(
      () => MATERIAL_FACE_VALUES.map(createFaceTexture),
      []
    )

    function hideInner() {
      if (innerHidden.current) return
      innerHidden.current = true
      innerRefs.forEach(r => { if (r.current) r.current.visible = false })
    }

    function ease(s: number) { return s * s * (3 - 2 * s) }

    // pourOrigin: 140°反転時のカップ口位置 (world 座標)
    function calcPourOrigin(): [number, number, number] {
      // 口 (local +Y = CUP_HEIGHT/2) を POUR_ANGLE 回転させた world 位置
      const sinA = Math.sin(POUR_ANGLE)
      const cosA = Math.cos(POUR_ANGLE)
      const half = CUP_HEIGHT / 2
      return [
        POUR_POS[0] - half * sinA,               // ≈ 0.05
        POUR_POS[1] + half * cosA,               // ≈ 1.78
        POUR_POS[2],
      ]
    }

    useFrame((_, delta) => {
      const g = groupRef.current
      if (!g) return

      // ─ idle / roll_ready ──────────────────────────────
      if (phase.current === 'idle' || phase.current === 'roll_ready') {
        g.rotation.z = 0
        g.position.set(...HOME_POS)
        innerRefs.forEach((r, i) => {
          const ir = r.current
          if (!ir) return
          const [bx, by, bz] = INNER_BASE[i]
          ir.position.set(bx, by, bz)
          ir.rotation.set(0, 0, 0)
        })
        return
      }

      // ─ roll_shaking: HOME で揺れる（中身は物理ラトル）──────
      if (phase.current === 'roll_shaking') {
        shakeTime.current += delta
        const st = shakeTime.current
        // カップ本体を左右に振動（水平のみ。底を一定の高さ・傾きに保ち緑が出ないように）
        g.position.set(
          HOME_POS[0] + Math.sin(st * SHAKE_FREQ) * CUP_SHAKE_AMP,
          HOME_POS[1],
          HOME_POS[2] + Math.cos(st * SHAKE_FREQ * 1.3) * CUP_SHAKE_AMP * 0.6,
        )
        g.rotation.z = 0
        // 中身は物理ラトル(CupRattle)が担当。見た目の演出ダイスは隠す（二重表示防止）
        innerRefs.forEach(r => { if (r.current) r.current.visible = false })

        const shouldClose = autoRoll.current
          ? shakeTime.current >= MIN_HOLD_SECS
          : holdReleased.current && shakeTime.current >= MIN_HOLD_SECS

        if (shouldClose) {
          // ラトル停止 → afterStep でラトル姿勢を見た目ダイスへ引き継ぐ
          setRattle(false)
          handoffPendingRef.current = true
          phase.current = 'roll_moving'
          t.current     = 0
        }
        return
      }

      // ─ roll_moving: HOME → POUR_POS ───────────────────
      if (phase.current === 'roll_moving') {
        t.current = Math.min(1, t.current + delta / MOVE_DURATION)
        const s = ease(t.current)
        g.rotation.z = 0
        g.position.x = HOME_POS[0] + (POUR_POS[0] - HOME_POS[0]) * s
        g.position.y = CUP_CENTER_Y + (POUR_POS[1] - CUP_CENTER_Y) * s
                       + Math.sin(t.current * Math.PI) * 0.6
        g.position.z = HOME_POS[2] + (POUR_POS[2] - HOME_POS[2]) * s
        // 引き継いだ姿勢のままカップに乗って運ばれる（上書きしない）
        if (t.current >= 1) {
          phase.current = 'roll_pouring'
          t.current     = 0
        }
        return
      }

      // ─ roll_pouring: z: 0 → POUR_ANGLE (140°) ─────────
      if (phase.current === 'roll_pouring') {
        t.current = Math.min(1, t.current + delta / POUR_DURATION)
        g.rotation.z = POUR_ANGLE * t.current
        g.position.set(...POUR_POS)

        // z ≥ 90° になったら内側ダイスを目隠し
        if (t.current >= HIDE_T) hideInner()

        if (t.current >= 1) {
          phase.current = 'roll_hold'
          t.current     = 0
        }
        return
      }

      // ─ roll_hold: 140°で停止 → 0.2s 待機後 onSpawn（フェイク時は roll_fake へ） ──
      if (phase.current === 'roll_hold') {
        g.rotation.z = POUR_ANGLE
        g.position.set(...POUR_POS)
        t.current += delta
        if (t.current >= HOLD_AFTER_POUR) {
          if (fakePumps.current > 0) {
            // フェイク投入: 傾いたまま空振りを繰り返す
            phase.current = 'roll_fake'
            fakeT.current = 0
          } else {
            onSpawnRef.current?.(calcPourOrigin())   // ダイスを投入
            phase.current = 'roll_spawn_wait'
            t.current     = 0
          }
        }
        return
      }

      // ─ roll_fake: 傾いたまま空振り → 1回目後に静止 → 残りを振って射出 ─
      if (phase.current === 'roll_fake') {
        g.position.set(...POUR_POS)
        // 1回目の空振り直後の静止中は傾けたまま止める
        if (fakePauseT.current > 0) {
          fakePauseT.current -= delta
          g.rotation.z = POUR_ANGLE
          return
        }
        fakeT.current += delta / FAKE_PUMP_DUR
        const s = Math.min(1, fakeT.current)
        // POUR_ANGLE を基準に前へあおって戻す（中身が出ない空振り）
        g.rotation.z = POUR_ANGLE + Math.sin(s * Math.PI) * FAKE_PUMP_AMP
        if (s >= 1) {
          fakePumps.current -= 1
          fakeT.current = 0
          if (fakePumps.current <= 0) {
            onSpawnRef.current?.(calcPourOrigin())   // ようやく射出
            phase.current = 'roll_spawn_wait'
            t.current     = 0
          } else if (fakePumps.current === fakeTotal.current - 1) {
            fakePauseT.current = FAKE_PAUSE   // 1回目の空振り直後だけ静止を挟む
          }
        }
        return
      }

      // ─ roll_spawn_wait: onSpawn 後 → 0.2s 待機して帰還 ─
      if (phase.current === 'roll_spawn_wait') {
        g.rotation.z = POUR_ANGLE
        g.position.set(...POUR_POS)
        t.current += delta
        if (t.current >= HOLD_AFTER_SPAWN) {
          phase.current = 'roll_returning'
          t.current     = 0
        }
        return
      }

      // ─ roll_returning: POUR_POS → HOME, z: POUR_ANGLE → 0 ─
      if (phase.current === 'roll_returning') {
        t.current = Math.min(1, t.current + delta / RETURN_DURATION)
        const s = ease(t.current)
        g.rotation.z = POUR_ANGLE * (1 - t.current)
        g.position.x = POUR_POS[0] + (HOME_POS[0] - POUR_POS[0]) * s
        g.position.y = POUR_POS[1] + (HOME_POS[1] - POUR_POS[1]) * s
                       + Math.sin(t.current * Math.PI) * 0.5
        g.position.z = POUR_POS[2] + (HOME_POS[2] - POUR_POS[2]) * s
        if (t.current >= 1) {
          // 修正1: 投入後は中身を再生産しない（空のまま戻る）。中身は飛び込みでのみ補充
          hideInner()
          cupCountRef.current = 0
          setCupCount(0)
          setRattle(false)
          autoRoll.current = false
          phase.current    = 'idle'
        }
        return
      }

      // ─ conceal_going ─────────────────────────────────────
      if (phase.current === 'conceal_going') {
        t.current = Math.min(1, t.current + delta * 1.8)
        const s = t.current
        const [tx, tz] = targetXZ.current
        g.rotation.z = Math.min(Math.PI, Math.PI * s * 4)
        g.position.x = HOME_POS[0] + (tx - HOME_POS[0]) * s
        g.position.y = CUP_CENTER_Y + Math.sin(s * Math.PI) * 4
        g.position.z = HOME_POS[2] + (tz - HOME_POS[2]) * s
        if (s >= 1) { phase.current = 'conceal_covering'; t.current = 0 }
        return
      }

      // ─ conceal_covering ──────────────────────────────────
      if (phase.current === 'conceal_covering') {
        t.current = Math.min(1, t.current + delta * 1.8)
        const [tx, tz] = targetXZ.current
        g.rotation.z = Math.PI
        g.position.set(tx, CUP_CENTER_Y, tz)
        if (t.current >= 0.4 && !coveredFired.current) {
          coveredFired.current = true
          onCoveredCb.current?.()
        }
        if (t.current >= 1) { phase.current = 'conceal_returning'; t.current = 0 }
        return
      }

      // ─ conceal_returning ─────────────────────────────────
      if (phase.current === 'conceal_returning') {
        t.current = Math.min(1, t.current + delta * 1.8)
        const s = t.current
        const [tx, tz] = targetXZ.current
        g.rotation.z = Math.PI * Math.max(0, 1 - Math.max(0, (s - 0.5) * 2))
        g.position.x = tx + (HOME_POS[0] - tx) * s
        g.position.y = CUP_CENTER_Y + Math.sin(s * Math.PI) * 4
        g.position.z = tz + (HOME_POS[2] - tz) * s
        if (s >= 1) {
          // カップ隠し演出は「覆って戻るだけ」。中身に触らない（再生産しない）。
          phase.current = 'idle'
          onDoneCb.current?.()
        }
      }
    })

    function handlePointerDown() {
      if (phase.current !== 'roll_ready') return
      // 観戦側（相手ターン）はカップを手動で投げられない。投入は triggerSyncRoll で連動させる。
      if (!canThrowRef.current) return
      // roll_ready になった直後の誤発火を防ぐ（振るボタンのクリックがキャンバスへ伝播するケース）
      if (performance.now() - readyAt.current < 150) return
      onThrowStartRef.current?.()
      holdReleased.current = false
      innerHidden.current  = false
      shakeTime.current    = 0
      phase.current        = 'roll_shaking'
      t.current            = 0
      setRattle(true)
    }

    return (
      <>
      {/* カップ内 物理ラトル（常設。world座標 HOME。動くカップ group の外に置く） */}
      <CupRattle active={rattle} count={cupCount} bodiesRef={rattleBodiesRef} />

      <group
        ref={groupRef}
        position={HOME_POS}
        rotation={[0, 0, 0]}
        onPointerDown={handlePointerDown}
      >
        {/* 外壁（茶タンの革） */}
        <mesh castShadow>
          <cylinderGeometry args={[CUP_R_TOP, CUP_R_BOT, CUP_HEIGHT, 48, 1, true]} />
          <meshStandardMaterial color="#8a5a2e" roughness={0.92} metalness={0.0} side={FrontSide} />
        </mesh>

        {/* 内壁（やや明るい革。開いた口から見える内側。ダイス視認性のため明るめ） */}
        <mesh>
          <cylinderGeometry args={[CUP_R_TOP - 0.07, CUP_R_BOT - 0.07, CUP_HEIGHT - 0.02, 48, 1, true]} />
          <meshStandardMaterial color="#6b4a2a" roughness={1.0} metalness={0.0} side={BackSide} />
        </mesh>

        {/* 上端の巻き革（リム） */}
        <mesh position={[0, CUP_HEIGHT / 2, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <torusGeometry args={[CUP_R_TOP, 0.18, 16, 56]} />
          <meshStandardMaterial color="#5c3a1c" roughness={0.85} metalness={0.0} />
        </mesh>

        {/* 底（外側・革） */}
        <mesh position={[0, -CUP_HEIGHT / 2, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <circleGeometry args={[CUP_R_BOT, 48]} />
          <meshStandardMaterial color="#7a4d27" roughness={0.92} metalness={0.0} />
        </mesh>

        {/* 底の縁（巻き革） */}
        <mesh position={[0, -CUP_HEIGHT / 2, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[CUP_R_BOT, 0.13, 14, 48]} />
          <meshStandardMaterial color="#5c3a1c" roughness={0.85} metalness={0.0} />
        </mesh>

        {/* 内側の底（内壁と同素材・同色に統一）。縁のz-fightingによるチラつきを防ぐ。 */}
        <mesh position={[0, -CUP_HEIGHT / 2 + 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[CUP_R_BOT - 0.12, 48]} />
          <meshStandardMaterial color="#6b4a2a" roughness={1.0} metalness={0.0} />
        </mesh>

        {/* ステッチ風の装飾バンド（上下2本） */}
        <mesh position={[0, CUP_HEIGHT / 2 - 0.65, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.73, 0.04, 8, 56]} />
          <meshStandardMaterial color="#caa46a" roughness={0.7} metalness={0.0} />
        </mesh>
        <mesh position={[0, -CUP_HEIGHT / 2 + 0.65, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.46, 0.04, 8, 56]} />
          <meshStandardMaterial color="#caa46a" roughness={0.7} metalness={0.0} />
        </mesh>

        {INNER_BASE.map((base, i) => (
          <group key={i} ref={innerRefs[i]} position={base} visible={true}>
            <mesh castShadow>
              <boxGeometry args={[1.0, 1.0, 1.0]} />
              {diceTextures.map((tex, j) => (
                <meshStandardMaterial
                  key={j}
                  attach={`material-${j}`}
                  map={tex}
                  roughness={0.85}
                  metalness={0.0}
                />
              ))}
            </mesh>
          </group>
        ))}
      </group>
      </>
    )
  }
)
