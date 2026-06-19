/**
 * FieldDie.tsx
 * フィールド上の1個のダイス。
 *
 * - displayValue: A方式でこの目が上に着地する
 * - initRot     : 省略時は displayValue から計算。キープ再スポーン時に前回の姿勢を渡す
 * - kept        : true → 金枠を表示。クリックでキープ解除
 * - onSettle    : 静止時に worldPos + worldRot(Euler) を報告
 * - onToggleKeep: クリック時（静止後のみ）に呼ばれる
 * - 出目の書き換えはテクスチャ塗替えでなく「回転で final の面を真上に向ける」方式（orientTo/flip/thunder）
 */

import { useRef, useMemo, forwardRef, useImperativeHandle } from 'react'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { RigidBody, interactionGroups } from '@react-three/rapier'
import type { RapierRigidBody, CollisionEnterPayload } from '@react-three/rapier'
import { RigidBodyType } from '@dimforge/rapier3d-compat'
import { Quaternion as ThreeQuat, Vector3, Euler, MeshStandardMaterial, BackSide, AdditiveBlending } from 'three'
import type { Group, PointLight, Mesh } from 'three'
import { createFaceTexture, MATERIAL_FACE_VALUES } from './diceTexture'
import { playDiceHit } from '../game/audio'
import type { DieValue } from '../game/types'

const TARGET_NORMALS: Record<DieValue, [number, number, number]> = {
  1: [ 0,  1,  0],  6: [ 0, -1,  0],
  2: [ 0,  0,  1],  5: [ 0,  0, -1],
  3: [ 1,  0,  0],  4: [-1,  0,  0],
}

// ── 衝突音チューニング定数（実機で詰める） ───────────────
// onCollisionEnter（接触の開始時のみ発火）を使う。連続接触では鳴らないので連打しない。
const HIT_SPEED_MIN = 1.0   // 衝突時の速度がこれ未満なら鳴らさない（弱い接触・微振動を無視）
const HIT_SPEED_REF = 5.0   // この速度で音量ほぼ最大（強度スケールの基準）
const HIT_COOLDOWN  = 0.05  // 秒。ダイスごと、この間隔内の再発火は無視（バウンド連発を抑制）

// ── 着地誘導（方法C）チューニング定数 ───────────────────
const GUIDE_LIN_MAX  = 3.0   // 線速度がこれ以下になったら誘導開始（勢いが残る間は自由に転がす）
const GUIDE_Y_MAX    = 2.0   // この高さ以下（接地付近）で誘導
const GUIDE_GAIN     = 7.0   // 誤差角→補正角速度のゲイン
const GUIDE_MAX_SPIN = 9.0   // 補正角速度の上限
const GUIDE_BLEND    = 0.14  // 補正を現在の回転へ溶け込ませる最大割合（回転が遅いほどこの値へ）
const GUIDE_ANG_REF  = 6.0   // 角速度の基準。これ以上速く回っている間は補正しない（逆回転防止）
const GUIDE_YAW_KEEP = 0.90  // 縦軸回転(yaw)の残存率（自然な余韻。which-face-up に無影響）
const GUIDE_DEADZONE = 0.03  // 誤差角がこれ以下なら補正停止（≈1.7°）→ そのまま sleep
const GATHER_DUR     = 0.45  // 中央集約の移動時間（秒。キープ移動と同程度）
const FLIP_DUR       = 0.6   // フリップ cover の1回転にかける時間（秒。v1 仮値）

// ── 衝突グループ ───────────────────────────────────────
// 通常: group0（床/壁 group0・他ダイス group0 と衝突）。雷の演出ダイスもこのまま使う
// （他4個は集約後 kinematic で動かないので、衝突させても安全＝融合せず弾かれるだけ）。
const DIE_GROUP     = interactionGroups(0, [0])

// ── 雷演出（物理演出ポリシー準拠）チューニング定数 ──────────
const T_THUNDER_TIMEOUT   = 2.5   // 秒。これを過ぎて onSleep が来なければ force-restore（静止保証）
const THUNDER_ROT_DUR     = 0.22  // 着地位置で「正規目を真上に向ける」回転の所要（秒。これが終わってから移動）
const THUNDER_HOLD_DUR    = 1.0   // 正規目で静止してから集約へ移るまでの確認時間（秒）
const THUNDER_RESTORE_DUR = 0.45  // 着地位置→集約スポットへ移動する補間時間（秒。姿勢は固定）
const THUNDER_RISE_VY     = 1.0   // この上向き速度を一度超えてから「最高点通過(=落下転換)」を検出
// 着地検知（onSleep/timeout を待たず、止まった瞬間に righting を始めるため）
const THUNDER_LAND_Y      = 0.9   // この高さ以下で
const THUNDER_LAND_SPEED  = 1.2   // この速度（全方向）以下が
const THUNDER_LAND_HOLD   = 0.16  // この秒数続いたら「着地静止」とみなして判定
const THUNDER_MAX_STRIKES = 3     // 雷の最大回数（自然に正規目が出なければ再雷。超えたら強制整列＝安全策）

// ── 雷ビジュアル A1（対象ダイスに追従する分。すべて実機調整可。物理には一切影響しない） ──
const THUNDER_GLOW_COLOR     = '#9fd0ff'  // リム発光の色
const THUNDER_GLOW_SCALE     = 1.08       // リム発光メッシュの拡大率（ダイス輪郭の少し外）
const THUNDER_GLOW_OPACITY   = 0.4        // リム発光の不透明度
const THUNDER_RESTRIKE_DUR   = 0.10       // 打ち直し閃光の表示時間（秒）
const THUNDER_RESTRIKE_INTENSITY = 8      // 打ち直し閃光の点光源強度（ピーク）

function computeInitRot(target: DieValue): [number, number, number] {
  const localNormal = new Vector3(...TARGET_NORMALS[target])
  const dir = new Vector3(0, 1, 0)
  const q   = new ThreeQuat().setFromUnitVectors(localNormal, dir)
  const yRot = new ThreeQuat().setFromAxisAngle(new Vector3(0, 1, 0), Math.random() * Math.PI * 2)
  const e = new Euler().setFromQuaternion(new ThreeQuat().multiplyQuaternions(yRot, q), 'XYZ')
  return [e.x, e.y, e.z]
}
// value の面が真上を向く姿勢のクォータニオン（テクスチャ固定・回転で出目を出すための共通関数）
function quatForValue(value: DieValue): ThreeQuat {
  return new ThreeQuat().setFromEuler(new Euler(...computeInitRot(value)))
}

// 着地誘導（方法C）: target の面が world +Y を向くよう補正角速度をブレンドする。
// 通常投入は target=displayValue、雷は target=finalValue で共有する。空中/高速時は何もしない。
function steerFaceUp(rb: RapierRigidBody, target: DieValue): void {
  const t = rb.translation()
  const lin = rb.linvel()
  if (t.y > GUIDE_Y_MAX || Math.hypot(lin.x, lin.y, lin.z) > GUIDE_LIN_MAX) return
  const r = rb.rotation()
  const quat = new ThreeQuat(r.x, r.y, r.z, r.w)
  const worldN = new Vector3(...TARGET_NORMALS[target]).applyQuaternion(quat)
  let axisX = -worldN.z
  let axisZ =  worldN.x
  let sinErr = Math.hypot(axisX, axisZ)
  const errAngle = Math.atan2(sinErr, worldN.y)
  const ang = rb.angvel()
  if (errAngle <= GUIDE_DEADZONE) return
  if (sinErr < 1e-4) { axisX = 1; axisZ = 0; sinErr = 1 }
  const inv = 1 / sinErr
  const mag = Math.min(errAngle * GUIDE_GAIN, GUIDE_MAX_SPIN)
  const corrX = axisX * inv * mag
  const corrZ = axisZ * inv * mag
  const angMag = Math.hypot(ang.x, ang.y, ang.z)
  const blend = GUIDE_BLEND * Math.max(0, 1 - angMag / GUIDE_ANG_REF)
  if (blend <= 0) return
  rb.setAngvel({
    x: ang.x * (1 - blend) + corrX * blend,
    y: ang.y * GUIDE_YAW_KEEP,
    z: ang.z * (1 - blend) + corrZ * blend,
  }, true)
}

// 現在の姿勢で最も上を向いている面の値と、その整列度（aligned=ほぼ真上）を返す。
function topFaceValue(rb: RapierRigidBody): { value: DieValue; aligned: boolean } {
  const r = rb.rotation()
  const quat = new ThreeQuat(r.x, r.y, r.z, r.w)
  let best: DieValue = 1, bestY = -Infinity
  for (const v of [1, 2, 3, 4, 5, 6] as DieValue[]) {
    const y = new Vector3(...TARGET_NORMALS[v]).applyQuaternion(quat).y
    if (y > bestY) { bestY = y; best = v }
  }
  return { value: best, aligned: bestY > 0.90 }   // ~25°以内なら整列とみなす
}

// ── 出目の書き換え方針（重要・全演出共通） ──────────────────────────
// テクスチャは6面固定（各面は自分の値を表示）。display→final の「書き換え」は
// テクスチャを塗り替えるのではなく、ダイスを「final の面が真上に来る姿勢」へ実際に回転して行う。
// （塗り替え方式は同じ数字の面が2つ出来て違和感が出るため廃止）。
// 各 cover が回転の出し方を担う：雷=吹き飛びの衝撃／フリップ=跳ね上げ回転／カップ隠し=内部で回転(不可視)。
const FLIP_HOP = 2.6   // フリップ cover の跳ね上げ高さ（実機調整可）

export interface FieldDieHandle {
  /** 中央集約: 物理を切り、姿勢は変えず位置だけ target へ滑らかに移動 */
  gatherTo(target: [number, number, number]): void
  /** カップ隠し用: 不可視の間に value の面を真上へ瞬時に向ける（回転スナップ。物理は kinematic 固定） */
  orientTo(value: DieValue): void
  /**
   * 雷v2 用: 本体メッシュの表示/非表示を切替。hidden=true の間はコライダーも無効化し、
   * 着弾点に常設した欠片が「見えない本体」に弾かれないようにする（kinematic は維持）。
   */
  setHidden(hidden: boolean): void
  /** フリップ cover: 空中に跳ね上げつつ value の面が真上に来るよう回転して着地。終わったら onDone。 */
  flip(value: DieValue, onDone: () => void): void
  /**
   * 雷 cover（物理演出ポリシー準拠）: このダイスだけ dynamic で吹き飛ばし、転がり静止 or timeout で
   * 「元の集約スポット・value の面が真上」へ kinematic 補間で戻して onDone。目は物理任せにせず
   * 最後に回転で強制セット（finalValue は先に確定の原則を維持）。
   */
  thunder(opts: { impUp: number; impH: number; torque: number }, value: DieValue, onDone: () => void): void
  /** 現在の位置・姿勢(Euler)を読む。cover 後に dieStates へ確定値を書き戻すため。 */
  readPose(): { pos: [number, number, number]; rot: [number, number, number] } | null
  /** B系統演出: 4打点ジグザグ移動。pts = [start, wp0..wp3] の5点。segStarts = SE打点タイミング（秒）の5要素配列。省略時は0.44s固定。 */
  zigzagTo(pts: [number, number, number][], finalValue: DieValue, onDone: () => void, segStarts?: number[]): void
}

export interface FieldDieProps {
  id:             number
  displayValue:   DieValue
  initRot?:       [number, number, number]   // Euler。省略時は displayValue から計算
  kept?:          boolean
  launchPos:      [number, number, number]
  launchImpulse:  { x: number; y: number; z: number }
  launchTorque:   { x: number; y: number; z: number }
  /** true: 射出せず launchPos に kinematic で出現（キープ欄からの中央集約復帰用） */
  kinematicSpawn?: boolean
  /** 出現直後に中央集約する移動先（kinematicSpawn と併用） */
  gatherTarget?:  [number, number, number]
  onSettle?:      (
    id:       number,
    worldPos: [number, number, number],
    worldRot: [number, number, number]   // Euler XYZ
  ) => void
  onToggleKeep?:  (id: number) => void
}

export const FieldDie = forwardRef<FieldDieHandle, FieldDieProps>(
  function FieldDie(
    { id, displayValue, initRot: initRotProp, kept = false,
      launchPos, launchImpulse, launchTorque,
      kinematicSpawn = false, gatherTarget,
      onSettle, onToggleKeep },
    ref
  ) {
    const rbRef    = useRef<RapierRigidBody>(null)
    const launched = useRef(false)
    const settled  = useRef(false)
    const matsRef  = useRef<(MeshStandardMaterial | null)[]>([])
    const bodyMeshRef = useRef<Mesh>(null)   // 本体メッシュ（雷v2 の visible 切替用）
    // 中央集約アニメ（物理を kinematic に切替え、位置だけ補間）
    const gatherRef = useRef<{ from: [number, number, number]; target: [number, number, number]; t: number } | null>(null)
    // B系統: ジグザグ移動アニメ（kinematic 位置補間＋全行程 slerp）
    const zigzagRef = useRef<{
      pts:        [number, number, number][]  // [start, wp0, wp1, wp2, goal] の5点
      finalValue: DieValue
      segIdx:     number       // 現在区間 0〜3
      t:          number       // 区間内 0〜1
      elapsed:    number       // zigzagTo 呼び出しからの経過時間（秒）
      segStarts:  number[] | null  // SE同期タイミング。null = 0.44s 固定
      fromQuat:   ThreeQuat    // 打ち上げ時の初期姿勢
      toQuat:     ThreeQuat    // finalValue の面が真上になる姿勢（打ち上げ時に確定）
      onDone:     () => void
    } | null>(null)
    // フリップ cover アニメ（跳ね上げ＋ fromQ→toQ(value 上面) へ回転して着地）
    const flipRef = useRef<{
      basePos: [number, number, number]
      fromQ: ThreeQuat; toQ: ThreeQuat
      t: number; onDone: () => void
    } | null>(null)
    // 雷 cover（dynamic 飛散フェーズ）
    const thunderRef = useRef<{
      home: [number, number, number]   // 集約スポット（最終的に移動する先）
      opts: { impUp: number; impH: number; torque: number }
      value: DieValue                  // 自然に出したい目（=finalValue）。誘導の目標＆判定基準
      onStrike: (x: number, z: number) => void   // 雷の視覚を出す（初回＋再雷ごと）
      onDone: () => void
      launched: boolean                // dynamic 化後の最初のフレームで初回投げを済ませたか
      struck: boolean; rose: boolean; t: number   // struck=最高点通過で打ち直し閃光を出したか
      lowT: number                     // 床付近＆低速が続いた時間（着地検知用）
      strikes: number                  // これまでの雷回数（初回含む）
    } | null>(null)
    // 雷 cover（飛散後の kinematic 復帰）。2段階：
    //   'rotate' = 着地位置でその場回転して final 面を真上へ（＝静止時点で正規目が出ている）
    //   'move'   = その姿勢を保ったまま集約スポットへ移動
    const thunderRestoreRef = useRef<{
      phase: 'rotate' | 'hold' | 'move'   // rotate=強制整列 / hold=正規目で確認待機 / move=集約へ
      pos: Vector3            // 着地位置（rotate/hold 中は固定／move の始点）
      toPos: Vector3          // 集約スポット
      fromQ: ThreeQuat; toQ: ThreeQuat
      t: number; onDone: () => void
    } | null>(null)
    // 雷ビジュアル A1: 対象ダイスに追従する発光群（RigidBody の外＝コライダー生成に影響しない）
    const fxRef        = useRef<Group>(null)        // リム発光＋打ち直し閃光をまとめた group
    const restrikeRef  = useRef<PointLight>(null)   // 打ち直し閃光の点光源
    const fxActiveRef  = useRef(false)              // リム発光 表示中か
    const restrikeT    = useRef(-1)                 // 打ち直し閃光のフェード経過（>=0 で再生中）

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const initRot  = useMemo(() => initRotProp ?? computeInitRot(displayValue), [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const textures = useMemo(() => MATERIAL_FACE_VALUES.map(createFaceTexture), [])

    useImperativeHandle(ref, () => ({
      gatherTo(target) {
        const rb = rbRef.current
        if (!rb) return
        const t = rb.translation()
        // 物理を切る（kinematic）: 重力/衝突を受けず、後からアニメ制御できる。姿勢は保つ
        rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
        rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
        rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
        gatherRef.current = { from: [t.x, t.y, t.z], target, t: 0 }
      },
      orientTo(value) {
        // カップ隠し用: 不可視の間に value の面を真上へスナップ（回転で出目を出す）。
        const rb = rbRef.current
        if (!rb) return
        rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
        rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
        rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
        const q = quatForValue(value)
        rb.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
      },
      setHidden(hidden) {
        if (bodyMeshRef.current) bodyMeshRef.current.visible = !hidden
        // hidden 中はコライダーを「何とも当たらない」グループに（欠片が見えない本体に弾かれない）
        rbRef.current?.collider(0)?.setCollisionGroups(hidden ? interactionGroups(0, []) : DIE_GROUP)
      },
      readPose() {
        const rb = rbRef.current
        if (!rb) return null
        const t = rb.translation()
        const r = rb.rotation()
        const e = new Euler().setFromQuaternion(new ThreeQuat(r.x, r.y, r.z, r.w), 'XYZ')
        return { pos: [t.x, t.y, t.z], rot: [e.x, e.y, e.z] }
      },
      zigzagTo(pts, finalValue, onDone, segStarts) {
        const rb = rbRef.current
        if (!rb) { onDone(); return }
        rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
        rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
        rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
        const r = rb.rotation()
        zigzagRef.current = {
          pts,
          finalValue,
          segIdx: 0, t: 0, elapsed: 0,
          segStarts: segStarts ?? null,
          fromQuat: new ThreeQuat(r.x, r.y, r.z, r.w),
          toQuat:   quatForValue(finalValue),   // 打ち上げ時に確定
          onDone,
        }
      },
      flip(value, onDone) {
        const rb = rbRef.current
        if (!rb) { onDone(); return }
        // staging 時点で集約済み＝kinematic のはず。念のため kinematic に固定。
        rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
        rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
        rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
        const t0 = rb.translation()
        const r  = rb.rotation()
        flipRef.current = {
          basePos: [t0.x, t0.y, t0.z],
          fromQ: new ThreeQuat(r.x, r.y, r.z, r.w),
          toQ:   quatForValue(value),   // value の面が真上に来る姿勢へ回転
          t: 0, onDone,
        }
      },
      thunder(opts, value, onStrike, onDone) {
        const rb = rbRef.current
        if (!rb) { onDone(); return }
        // 最終的に戻る集約スポット（飛ばす直前の位置）
        const t0 = rb.translation()
        const home: [number, number, number] = [t0.x, t0.y, t0.z]
        // 衝突グループは通常(DIE_GROUP)のまま：他4個は集約後 kinematic（静止・無限質量）なので
        //   ぶつかっても動かない＝「他は不動」を保ちつつ、演出ダイスは弾かれて融合しない（物理感）。
        // dynamic 化（add/remove はしない＝型切替のみ）。
        // ★速度付与は useFrame で行う（kinematic→dynamic 直後は実効 invMass が未復元のため、
        //   invMass に依存しない setLinvel/setAngvel を使う）。
        rb.setBodyType(RigidBodyType.Dynamic, true)
        rb.wakeUp()
        settled.current = false
        thunderRef.current = {
          home, opts, value, onStrike, onDone,
          launched: false, struck: false, rose: false, t: 0, lowT: 0, strikes: 0,
        }
        // ビジュアル: リム発光 ON（成立まで継続）。fx group を対象の位置＋姿勢へ。
        fxActiveRef.current = true
        restrikeT.current = -1
        if (fxRef.current) {
          const r0 = rb.rotation()
          fxRef.current.position.set(t0.x, t0.y, t0.z)
          fxRef.current.quaternion.set(r0.x, r0.y, r0.z, r0.w)
          fxRef.current.visible = true
        }
        if (restrikeRef.current) restrikeRef.current.intensity = 0
      },
    }))

    // 雷を1発撃つ（初回＆再雷で共用）：中央を避けて外向き＋上向きに飛ばし、高い角速度で転がす。
    // 速度直接指定（invMass 非依存）。視覚は onStrike(現在位置) で都度出す。
    const thunderThrow = () => {
      const rb = rbRef.current
      const th = thunderRef.current
      if (!rb || !th) return
      const p = rb.translation()
      // 中央(原点)から外向きの水平方向（他ダイスの集まる中央へ着地しないように）
      let ox = p.x, oz = p.z
      const len = Math.hypot(ox, oz)
      if (len < 0.5) { const a = Math.random() * Math.PI * 2; ox = Math.cos(a); oz = Math.sin(a) }
      else { ox /= len; oz /= len }
      const jitter = 0.4
      rb.setLinvel({
        x: ox * th.opts.impH + (Math.random() * 2 - 1) * jitter,
        y: th.opts.impUp,
        z: oz * th.opts.impH + (Math.random() * 2 - 1) * jitter,
      }, true)
      rb.setAngvel({
        x: (Math.random() * 2 - 1) * th.opts.torque * 6,
        y: (Math.random() * 2 - 1) * th.opts.torque * 6,
        z: (Math.random() * 2 - 1) * th.opts.torque * 6,
      }, true)
      th.rose = false; th.struck = false; th.lowT = 0; th.t = 0; th.strikes += 1
      // リム発光を継続表示＆閃光リセット
      fxActiveRef.current = true
      restrikeT.current = -1
      if (fxRef.current) fxRef.current.visible = true
      if (restrikeRef.current) restrikeRef.current.intensity = 0
      th.onStrike(p.x, p.z)   // 視覚の落雷を現在位置に
    }

    // 雷の着地判定：自然に正規目(value)が出ていれば集約へ移動、出ていなければ再雷、
    // 上限超過 or force なら強制整列（その場で value 面へ回転 → 移動）＝安全策。
    const resolveThunderLanding = (force: boolean) => {
      const rb = rbRef.current
      const th = thunderRef.current
      if (!rb || !th) return
      const top = topFaceValue(rb)
      const success = !force && top.value === th.value && top.aligned

      // 失敗かつ余力あり → もう一度雷（無理に回転させない）
      if (!success && !force && th.strikes < THUNDER_MAX_STRIKES) {
        thunderThrow()
        return
      }

      // 成立 or 強制 → 確定処理。リム発光・閃光を消す。
      restrikeT.current = -1
      fxActiveRef.current = false
      if (restrikeRef.current) restrikeRef.current.intensity = 0
      if (fxRef.current) fxRef.current.visible = false
      const tr = rb.translation()
      const rr = rb.rotation()
      rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
      settled.current = true   // 演出後はクリック可（keep_select で keep できるように）
      thunderRestoreRef.current = {
        // success: 自然に正規目で静止済み → そのまま hold(確認待機) → move
        // 強制: その場で value 面へ回転(rotate) → hold(確認待機) → move
        phase: success ? 'hold' : 'rotate',
        pos:   new Vector3(tr.x, tr.y, tr.z),
        toPos: new Vector3(th.home[0], th.home[1], th.home[2]),
        fromQ: new ThreeQuat(rr.x, rr.y, rr.z, rr.w),
        toQ:   success ? new ThreeQuat(rr.x, rr.y, rr.z, rr.w) : quatForValue(th.value),
        t: 0, onDone: th.onDone,
      }
      thunderRef.current = null
    }

    useFrame((_, dt) => {
      const rb = rbRef.current
      if (!rb) return

      // ── 雷ビジュアル A1: 発光群を対象ダイスへ追従＋打ち直し閃光のフェード（物理に非干渉） ──
      // 早期 return より前で毎フレーム更新する（飛散中/復帰中いずれの分岐に入っても追従するため）。
      if (fxActiveRef.current && fxRef.current) {
        const p = rb.translation()
        const r = rb.rotation()
        fxRef.current.position.set(p.x, p.y, p.z)
        fxRef.current.quaternion.set(r.x, r.y, r.z, r.w)   // 姿勢も追従＝リム発光がダイスの回転に乗る
        fxRef.current.visible = true
        if (restrikeT.current >= 0) {
          restrikeT.current += dt
          const k = restrikeT.current / THUNDER_RESTRIKE_DUR
          if (restrikeRef.current) restrikeRef.current.intensity = k >= 1 ? 0 : THUNDER_RESTRIKE_INTENSITY * (1 - k)
          if (k >= 1) {   // 打ち直し閃光終了＝リム発光も終了
            restrikeT.current = -1
            fxActiveRef.current = false
            fxRef.current.visible = false
          }
        }
      }

      // ── kinematic 出現（キープ欄→中央集約の復帰）: 射出せず launchPos に出て集約 ──
      if (kinematicSpawn && !launched.current) {
        launched.current = true
        settled.current  = true
        rb.setBodyType(RigidBodyType.KinematicPositionBased, true)
        rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
        rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
        if (gatherTarget) {
          const t = rb.translation()
          gatherRef.current = { from: [t.x, t.y, t.z], target: gatherTarget, t: 0 }
        }
        return
      }

      // ── 雷: 飛散後の kinematic 復帰。①着地位置でその場回転(final面を真上) → ②集約スポットへ移動 ──
      if (thunderRestoreRef.current) {
        const tr = thunderRestoreRef.current
        if (tr.phase === 'rotate') {
          tr.t = Math.min(1, tr.t + dt / THUNDER_ROT_DUR)
          const e = tr.t * tr.t * (3 - 2 * tr.t)
          const q = tr.fromQ.clone().slerp(tr.toQ, e)
          rb.setNextKinematicTranslation({ x: tr.pos.x, y: tr.pos.y, z: tr.pos.z })   // 位置は着地点で固定
          rb.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          if (tr.t >= 1) { tr.phase = 'hold'; tr.t = 0 }   // 正規目が真上 → 確認待機へ
          return
        }
        if (tr.phase === 'hold') {
          // 着地位置・正規目のまま静止して、プレイヤーが出目を確認する時間を確保
          tr.t += dt
          rb.setNextKinematicTranslation({ x: tr.pos.x, y: tr.pos.y, z: tr.pos.z })
          rb.setNextKinematicRotation({ x: tr.toQ.x, y: tr.toQ.y, z: tr.toQ.z, w: tr.toQ.w })
          if (tr.t >= THUNDER_HOLD_DUR) { tr.phase = 'move'; tr.t = 0 }
          return
        }
        // move: 姿勢は final 面上面で固定したまま、着地位置 → 集約スポットへ
        tr.t = Math.min(1, tr.t + dt / THUNDER_RESTORE_DUR)
        const e = tr.t * tr.t * (3 - 2 * tr.t)
        const p = tr.pos.clone().lerp(tr.toPos, e)
        rb.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z })
        rb.setNextKinematicRotation({ x: tr.toQ.x, y: tr.toQ.y, z: tr.toQ.z, w: tr.toQ.w })
        if (tr.t >= 1) { const d = tr.onDone; thunderRestoreRef.current = null; d() }
        return
      }

      // ── 雷: dynamic 飛散フェーズ。投げ→転がり→着地誘導(value を自然に上へ)→着地判定 ──
      if (thunderRef.current) {
        const th = thunderRef.current
        // dynamic 化後の最初のフレームで初回投げ（invMass 復元待ち不要の速度直接指定）。
        if (!th.launched) {
          th.launched = true
          thunderThrow()   // 中央を避けて外向きに飛ばす＋視覚（初回も）
          return
        }
        th.t += dt
        const v = rb.linvel()
        if (v.y > THUNDER_RISE_VY) th.rose = true                 // 一度しっかり上昇したか
        if (th.rose && !th.struck && v.y <= 0) {                  // 落下に転じた瞬間＝「打ち直し」の閃光
          th.struck = true
          restrikeT.current = 0
        }
        // 着地誘導：落ちて遅くなってきたら value(=finalValue) の面が自然に上へ来るよう寄せる。
        steerFaceUp(rb, th.value)
        // 着地判定: 一度上昇したあと、床付近＆低速が続いたら「自然に正規目が出たか」を判定。
        const tt = rb.translation()
        const speed = Math.hypot(v.x, v.y, v.z)
        if (th.rose && tt.y < THUNDER_LAND_Y && speed < THUNDER_LAND_SPEED) {
          th.lowT += dt
          if (th.lowT >= THUNDER_LAND_HOLD) { resolveThunderLanding(false); return }
        } else {
          th.lowT = 0
        }
        // 1発あたりの安全タイムアウト（転がり続けて判定できない時は強制整列）。
        if (th.t >= T_THUNDER_TIMEOUT) resolveThunderLanding(true)
        return
      }

      // ── フリップ cover: 跳ね上げつつ fromQ→toQ(value 上面) へ回転して着地（テクスチャ非塗替え） ──
      if (flipRef.current) {
        const f = flipRef.current
        f.t = Math.min(1, f.t + dt / FLIP_DUR)
        const e = f.t * f.t * (3 - 2 * f.t)                      // smoothstep
        const hop = Math.sin(f.t * Math.PI) * FLIP_HOP           // 上→下の放物的な跳ね上げ
        rb.setNextKinematicTranslation({ x: f.basePos[0], y: f.basePos[1] + hop, z: f.basePos[2] })
        const q = f.fromQ.clone().slerp(f.toQ, e)                // value の面が真上に来るよう回転
        rb.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        if (f.t >= 1) {
          playDiceHit('land', 0.55)                              // 着地の接触音（物理イベントは無いので直接）
          const done = f.onDone; flipRef.current = null; done()
        }
        return
      }

      // ── B系統: ジグザグ移動（4打点 kinematic 補間＋スピン）──
      if (zigzagRef.current) {
        const z = zigzagRef.current
        const SEG_DUR    = 0.44
        const TOTAL_SEGS = z.pts.length - 1   // 4
        z.elapsed += dt

        // ── タイミング分岐: SE 同期 or 固定 0.44s ──────────────
        if (z.segStarts) {
          const endTime = z.segStarts[TOTAL_SEGS]
          if (z.elapsed >= endTime) {
            const goal = z.pts[z.pts.length - 1]
            const fq = z.toQuat   // 打ち上げ時に確定した向き（再呼び出しで random yaw が変わらないよう）
            rb.setNextKinematicTranslation({ x: goal[0], y: goal[1], z: goal[2] })
            rb.setNextKinematicRotation({ x: fq.x, y: fq.y, z: fq.z, w: fq.w })
            const done = z.onDone; zigzagRef.current = null; done()
            return
          }
          // 1打点目前：開始位置で静止待機
          if (z.elapsed < z.segStarts[0]) {
            rb.setNextKinematicTranslation({ x: z.pts[0][0], y: z.pts[0][1], z: z.pts[0][2] })
            rb.setNextKinematicRotation({ x: z.fromQuat.x, y: z.fromQuat.y, z: z.fromQuat.z, w: z.fromQuat.w })
            return
          }
          // 現在区間を探す
          let seg = TOTAL_SEGS - 1
          for (let i = 0; i < TOTAL_SEGS; i++) {
            if (z.elapsed < z.segStarts[i + 1]) { seg = i; break }
          }
          z.segIdx = seg
          const segStart = z.segStarts[seg]
          const segEnd   = z.segStarts[seg + 1]
          z.t = Math.min(1, (z.elapsed - segStart) / (segEnd - segStart))
        } else {
          // 固定 0.44s フォールバック
          z.t += dt / SEG_DUR
          if (z.t >= 1) {
            z.segIdx++
            z.t = Math.max(0, z.t - 1)
            if (z.segIdx >= TOTAL_SEGS) {
              const goal = z.pts[z.pts.length - 1]
              rb.setNextKinematicTranslation({ x: goal[0], y: goal[1], z: goal[2] })
              const fq = z.toQuat   // 打ち上げ時に確定した向き（再呼び出しで random yaw が変わらないよう）
              rb.setNextKinematicRotation({ x: fq.x, y: fq.y, z: fq.z, w: fq.w })
              const done = z.onDone; zigzagRef.current = null; done()
              return
            }
          }
        }

        // ── 共通: 位置補間＋スピン/slerp ─────────────────────
        const from = z.pts[z.segIdx]
        const to   = z.pts[z.segIdx + 1]
        const isLastSeg = z.segIdx === TOTAL_SEGS - 1
        const e = isLastSeg ? 1 - (1 - z.t) * (1 - z.t) : z.t
        rb.setNextKinematicTranslation({
          x: from[0] + (to[0] - from[0]) * e,
          y: from[1] + (to[1] - from[1]) * e,
          z: from[2] + (to[2] - from[2]) * e,
        })

        // 回転: 打ち上げ時に確定した fromQuat→toQuat を全行程でなめらかに slerp
        const endTime   = z.segStarts ? z.segStarts[TOTAL_SEGS] : SEG_DUR * TOTAL_SEGS
        const startTime = z.segStarts ? z.segStarts[0] : 0
        const globalT   = Math.min(1, (z.elapsed - startTime) / (endTime - startTime))
        const q = z.fromQuat.clone().slerp(z.toQuat, globalT)
        rb.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        return
      }

      // ── 中央集約: 位置だけ補間（姿勢は変えない）─────────
      if (gatherRef.current) {
        const g = gatherRef.current
        g.t = Math.min(1, g.t + dt / GATHER_DUR)
        const e = g.t * g.t * (3 - 2 * g.t)   // smoothstep
        rb.setNextKinematicTranslation({
          x: g.from[0] + (g.target[0] - g.from[0]) * e,
          y: g.from[1] + (g.target[1] - g.from[1]) * e,
          z: g.from[2] + (g.target[2] - g.from[2]) * e,
        })
        if (g.t >= 1) gatherRef.current = null   // 到達後は kinematic のまま target で静止（後の演出で再制御可）
        return
      }

      // ── 射出（mass確定後・1回だけ）─────────────────────
      if (!launched.current) {
        // 質量が確定する前(コライダー未初期化)に impulse を撃つと無視される。
        // mass > 0 になるまで待ってから射出する。
        if (rb.mass() <= 0) return
        launched.current = true
        const { x: ix, y: iy, z: iz } = launchImpulse
        const { x: tx, y: ty, z: tz } = launchTorque
        if (ix || iy || iz) rb.applyImpulse(launchImpulse, true)
        if (tx || ty || tz) rb.applyTorqueImpulse(launchTorque, true)
        return
      }

      // ── 着地誘導（方法C）: displayValue の面を上へ自然整列 ──
      if (settled.current) return
      steerFaceUp(rb, displayValue)
    })

    const handleSleep = () => {
      // 雷の飛散ダイスが自然静止 → 終端処理（集約スポット・finalValue 上面へ復帰）。
      // ただし射出前(launched=false)の sleep は無視（mass 待ち中に終わらせない。次フレームで射出される）。
      if (thunderRef.current) {
        // 射出前(launched=false)の sleep は無視。それ以外は着地判定（自然成功 or 再雷 or 強制）。
        if (thunderRef.current.launched) resolveThunderLanding(false)
        return
      }
      if (settled.current || !rbRef.current) return
      settled.current = true
      const t   = rbRef.current.translation()
      const r   = rbRef.current.rotation()
      const eul = new Euler().setFromQuaternion(new ThreeQuat(r.x, r.y, r.z, r.w), 'XYZ')
      onSettle?.(id, [t.x, t.y, t.z], [eul.x, eul.y, eul.z])
    }

    const handleClick = (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation()
      if (settled.current) onToggleKeep?.(id)
    }

    // 衝突音: 「接触の開始時」だけ鳴らす。速度で強弱、クールダウンで連発抑制
    const lastHitRef = useRef(0)
    const handleCollision = (p: CollisionEnterPayload) => {
      const rb = rbRef.current
      if (!rb) return
      const now = performance.now() / 1000
      if (now - lastHitRef.current < HIT_COOLDOWN) return
      const v = rb.linvel()
      const speed = Math.hypot(v.x, v.y, v.z)
      if (speed < HIT_SPEED_MIN) return   // 弱い接触・微振動は無視
      lastHitRef.current = now
      // 相手がダイスなら clack、床/壁なら land
      const otherKind = (p.other.rigidBodyObject?.userData as { kind?: string } | undefined)?.kind
      const kind = otherKind === 'die' ? 'clack' : 'land'
      const intensity = 0.3 + Math.min(1, speed / HIT_SPEED_REF) * 0.7
      playDiceHit(kind, intensity)
    }

    return (
      <>
      <RigidBody
        ref={rbRef}
        colliders="cuboid"
        collisionGroups={DIE_GROUP}
        userData={{ kind: 'die' }}
        position={launchPos}
        rotation={initRot}
        restitution={0.25}
        friction={0.8}
        linearDamping={0.5}
        angularDamping={0.35}
        ccd={true}
        onSleep={handleSleep}
        onCollisionEnter={handleCollision}
      >
        {/* 本体 */}
        <mesh ref={bodyMeshRef} castShadow onClick={handleClick}>
          <boxGeometry args={[1, 1, 1]} />
          {textures.map((tex, i) => (
            <meshStandardMaterial
              key={i}
              ref={(el) => { matsRef.current[i] = el }}
              attach={`material-${i}`}
              map={tex}
              roughness={0.4}
              metalness={0.0}
            />
          ))}
        </mesh>
        {/* キープ中：金色ワイヤフレーム枠 */}
        {kept && (
          <mesh>
            <boxGeometry args={[1.18, 1.18, 1.18]} />
            <meshBasicMaterial color="#ffd700" wireframe />
          </mesh>
        )}
      </RigidBody>

      {/* 雷ビジュアル A1: リム発光＋打ち直し閃光。RigidBody の外に置き、useFrame で対象ダイスへ追従。
          （RigidBody 内に置くと colliders="cuboid" の自動生成に拾われ物理が変わるため外に出す） */}
      <group ref={fxRef} visible={false}>
        <mesh scale={THUNDER_GLOW_SCALE}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial
            color={THUNDER_GLOW_COLOR}
            transparent opacity={THUNDER_GLOW_OPACITY}
            side={BackSide} blending={AdditiveBlending} depthWrite={false}
          />
        </mesh>
        <pointLight ref={restrikeRef} intensity={0} distance={6} color={THUNDER_GLOW_COLOR} />
      </group>
      </>
    )
  }
)
