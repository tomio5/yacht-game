/**
 * GameScene.tsx — Stage 6+: CPU バトル + キープ欄
 *
 * ■ ダイスの居場所 (location)
 *   'field': フィールド上で転がる / 止まっている (FieldDie として描画)
 *   'kept' : キープ欄 (画面奥上部) に静止している (KeepDie として描画)
 *
 * ■ window.__ グローバル変数は使わない。cupIndicesRef / dieRefsRef に統一。
 * ■ カップから物理でこぼす実装は禁止。演出投入のまま。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 物理演出ポリシー（派手演出は物理を積極的に使う／ただし以下を契約とする）
 * ────────────────────────────────────────────────────────────────────────────
 * 1. 目は演出の最後に強制セット
 *    物理で出た目は採用しない。演出の終了時、対象ダイスに対して finalValue を
 *    強制的にセットする（既存の着地誘導の機構を流用する）。これにより、設計
 *    思想①「finalValue は先に確定、演出は見せ方」を物理演出でも維持する。
 *
 * 2. 物理ステップ中に body の add/remove をしない
 *    既存方針どおり。常設5個のダイスを使い回す。物理操作は beforeStep/afterStep
 *    で行う。違反は Rapier の recursive use フリーズを誘発する。
 *
 * 3. 動く kinematic と dynamic ダイスを衝突させない
 *    過去の爆発事故の機構（動くカップ×中ダイス）を繰り返さない。
 *    ・dynamic ダイスに impulse/torque をかけて吹き飛ばすのは可（壁・床との衝突は可）。
 *    ・演出物体（カップ、その他可動オブジェクト）と dynamic ダイスを物理的に
 *      当てない。どうしても重なる演出は、演出物体の collider を無効化する／
 *      ダイス側を kinematic にするなどで「物理衝突しない」を保証する。
 *
 * 4. 演出後の静止保証
 *    派手な物理演出のあとは、keep_select に渡す前に必ず「読める姿勢で静止」させる。
 *    ・既存の onSleep による settle 検出を一次の合図にする。
 *    ・それに加えて演出ごとに timeout を設定し、所定時間で静止しなければ
 *      force-restore する：dynamic→kinematic に切り替え、姿勢と位置を所定の
 *      集約位置／所定の姿勢に補間で戻し、上面が finalValue になるよう強制
 *      セットする。
 *    ・timeout は演出ごとの想定尺＋安全マージンで決める（雷など派手なものほど長めに）。
 *
 * 5. フェイズと演出の境界
 *    物理演出を再生中は操作不可フェイズに入れる（gathering / staging / 新フェイズ等）。
 *    演出が終わるまで keep_select / 入力フェイズに戻さない。
 *
 * 6. 既存安全パス（cupHide・flip）の不変
 *    cupHide（pre_gather_cover）と flip（staging）は物理シミュを使わない既存設計
 *    のまま。このポリシーは新規の物理演出と、今後の物理感強化に適用する。
 * ════════════════════════════════════════════════════════════════════════════
 */

import { useState, useCallback, useRef, createRef, useEffect, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Physics, RigidBody, CuboidCollider, interactionGroups } from '@react-three/rapier'
import { Group, AdditiveBlending, BackSide, Vector3, Quaternion, Euler, MeshBasicMaterial, BufferGeometry, BufferAttribute } from 'three'
import type { PointLight } from 'three'
import { createFlameTexture } from './fireTexture'
import { FieldDie } from './FieldDie'
import type { FieldDieHandle, FieldDieProps } from './FieldDie'
import { CupAnim } from './CupAnim'
import type { CupAnimHandle } from './CupAnim'
import { FractureSystem } from './FractureSystem'
import type { FractureSystemHandle, FractureExplodeOpts } from './FractureSystem'
import { YachtEffect } from './YachtEffect'
import { SlashEffect } from './SlashEffect'
import { SlashDieEffect } from './SlashDieEffect'
import type { SlashDieEffectHandle, SlashAssemblePattern } from './SlashDieEffect'
import { DebugPanel } from './DebugPanel'
import { ScoreSheet } from './ScoreSheet'
import { computeShowDice } from '../game/showDice'
import { calcCategoryScore, calcTotalScore, getDisplayRank } from '../game/scoring'
import { selectEffectFromTable, drawIndependentCupHide } from '../game/effectTable'
import type { EffectId } from '../game/effectTable'
import { cpuKeepDice, cpuChooseCategory } from '../game/cpuAI'
import { SE, resumeAudio, playDiceHit, playThunderA1SE, playThunderV2SE, playFlipSE, playConfidenceSE, playFireSE, playZangekiSE } from '../game/audio'
import * as bgm from '../audio/bgm'
import type { DieValue, EffectMode, Category, ScoreSheet as ScoreSheetType } from '../game/types'
import { createFaceTexture, MATERIAL_FACE_VALUES } from './diceTexture'
import { createWoodTexture } from './woodTexture'

// ── 型 ─────────────────────────────────────────────
// フェイズは常に rolling → gathering → staging → keep_select で一定遷移
//  gathering : 中央集約の移動アニメ中（操作不可）
//  staging   : 集約後の演出フェイズ（カップ隠し等を再生。無ければ即通過。操作不可）
//  keep_select: キープ/戻す/再振り/記入を受け付ける（操作可）
export type GamePhase =
  | 'idle' | 'cup_ready' | 'rolling'
  | 'pre_gather_cover'   // 集約前 cupHide（4キープ再振り限定の独立 cover）
  | 'gathering' | 'staging' | 'keep_select'
type Turn = 'player' | 'cpu'

// staging で再生する cover の識別子（'none'＝演出なし）。effectTable の EffectId に揃える。
export type CoverId = EffectId | 'none'
// DEBUG「cover 強制」: auto＝表で抽選 / それ以外＝その cover を強制（success 扱い）
export type CoverForce = 'auto' | EffectId

interface DieState {
  id:           number
  displayValue: DieValue
  finalValue:   DieValue
  worldPos:     [number, number, number] | null
  worldRot:     [number, number, number] | null
  /** 居場所。'cup' は後続ステップ用予約 */
  location:     'field' | 'kept'
  /** キープした順 (KeepSlot のインデックス割り当て用)。未キープ = -1 */
  keepOrder:    number
  /** アンキープ後に FieldDie を強制リマウントするためのカウンタ */
  mountKey:     number
}

interface DieConfig extends Omit<FieldDieProps, 'onSettle' | 'onToggleKeep' | 'kept'> {
  ref:      React.RefObject<FieldDieHandle | null>
  mountKey: number
}

// ── 定数 ─────────────────────────────────────────────
const TOTAL_CATEGORIES = 13

const EMPTY_SHEET: ScoreSheetType = {
  ones: null, twos: null, threes: null, fours: null, fives: null, sixes: null,
  choice: null, fourOfAKind: null, fullHouse: null,
  smallStraight: null, largeStraight: null, yacht: null,
}

/** キープ欄 5マス。緑フィールド(z≤-9)の少し奥＝茶色い床の上。
 *  見下ろしカメラでは「奥ほど画面上方」に映るため、y は低めにして画面内に収める。 */
const KEEP_SLOTS: [number, number, number][] = [
  [-8,  1, -9],
  [-4,  1, -9],
  [ 0,  1, -9],
  [ 4,  1, -9],
  [ 8,  1, -9],
]

// ── 中央集約: 5円エリア（フィールド中央を囲む五角形配置。[x,z]） ──
// 円同士は十分離す（ダイス1個をカップが覆っても隣に当たらない間隔＝演出の土台）。
// カップ(右下 x7,z5)・キープ欄(奥 z-10)と干渉しない範囲。実機で要微調整。
// 案A: 旧スキャター座標を一律 k=0.332 で原点へ寄せ（形・順序は完全維持）。
// 制約: 最小スポット中心間距離 4.826*k ≥ L(1.0) + 0.10*L(隙間) + 2*GATHER_RADIUS(両ジッター=0.25) = 1.60
// → k=0.332 で軸並行AABB最悪の表面間距離 ≈ 0.10*L を確保（ジッター 0.25）
//   ※ステップ4-2(隙間0.05L,k=0.321)で危うさが出たため1段戻し。隙間係数だけ 0.05→0.10 に戻した。
const GATHER_CENTERS: [number, number][] = [
  [  0.000, -1.381 ],   // 上（奥）
  [ -1.942, -0.129 ],   // 中段 左
  [  1.942, -0.129 ],   // 中段 右
  [ -1.208,  1.295 ],   // 下段（手前）左
  [  1.208,  1.295 ],   // 下段（手前）右
]
const GATHER_RADIUS = 0.25  // 各円の半径（円内ランダム位置の散らばり量。小さいほどダイスが離れる）
const GATHER_Y      = 0.5   // 着地後の静止高さ（床上のダイス中心）
const GATHER_MS     = 470   // 集約アニメ後 keep_select へ移るまでの待ち（FieldDie GATHER_DUR=0.45s に余裕）
const ZIGZAG_SEGS      = 4                               // 打点数
// zangeki.wav の打点タイミング（秒）+ 最終着地。FieldDie.zigzagTo の segStarts に渡す。
const SLASH_SEG_STARTS = [0.02, 0.46, 0.90, 1.37, 1.81] // 4区間: 0→1, 1→2, 2→3, 3→goal

function generateZigzagWaypoints(
  start: [number, number, number],
  goal:  [number, number, number],
): [number, number, number][] {
  // 軌跡の基準軸: start→goal に直交する水平方向
  const dx = goal[0] - start[0], dz = goal[2] - start[2]
  const perpLen = Math.hypot(dx, dz) || 1
  const perpX = -dz / perpLen, perpZ = dx / perpLen   // 90° 回転

  // 各打点を左右交互に大きく振る（打点1:+方向 / 打点2:-方向 / 打点3:+方向）
  const SWING   = 5.5 + Math.random() * 2.5   // 横振れ幅 5.5〜8.0
  const SWING_Y = 1.0 + Math.random() * 9.0   // 上昇量 1.0〜10

  return Array.from({ length: ZIGZAG_SEGS }, (_, i) => {
    const t = (i + 1) / ZIGZAG_SEGS
    const isLast = i === ZIGZAG_SEGS - 1
    const sign = (i % 2 === 0) ? 1 : -1       // 奇数打点は逆方向
    const sway = isLast ? 0 : sign * (SWING * (1 - t * 0.4))  // 終点に近づくほど絞る
    return [
      start[0] + (goal[0] - start[0]) * t + perpX * sway,
      start[1] + (goal[1] - start[1]) * t + (isLast ? 0 : SWING_Y),
      start[2] + (goal[2] - start[2]) * t + perpZ * sway,
    ] as [number, number, number]
  })
}
const CPU_READ_MS       = 1000  // CPU が集約後「盤面を読む時間」。経過後に自動で staging を起動（観戦用の間）
const SLASH_B_TIMEOUT_MS = 6000  // B系統演出のタイムアウト（zigzag 未完了時の force-restore 安全策）

// ── カップ投入時の信頼度演出音（30点以上の役が成立しうるとき確率で鳴らす） ──
const CONFIDENCE_MIN_SCORE = 30    // この点以上の役が finalValue で成立するなら対象
const CONFIDENCE_PROB      = 0.5   // 対象時に鳴る確率（実機調整可）
const ALL_CATEGORIES: Category[] = [
  'ones', 'twos', 'threes', 'fours', 'fives', 'sixes',
  'choice', 'fourOfAKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yacht',
]
// finalValue で成立する役の最高点が 30 以上なら、確率で信頼度音を1回鳴らす（判定は投入の瞬間に1回）。
function maybePlayConfidenceSE(finals: DieValue[]): void {
  const dice = finals.map((value, id) => ({ id, value, kept: false }))
  const maxScore = Math.max(...ALL_CATEGORIES.map(c => calcCategoryScore(c, dice)))
  if (maxScore >= CONFIDENCE_MIN_SCORE && Math.random() < CONFIDENCE_PROB) playConfidenceSE()
}

// ── ダイス各面の法線（local）。値 V を上面にしたとき +Y を向く向き ──
const TARGET_NORMALS: Record<DieValue, [number, number, number]> = {
  1: [ 0,  1,  0],  6: [ 0, -1,  0],
  2: [ 0,  0,  1],  5: [ 0,  0, -1],
  3: [ 1,  0,  0],  4: [-1,  0,  0],
}
// キープ時の「面の向き先」: 上＋手前(カメラ)へ少し傾けて出目を読みやすく
const KEEP_FACE_DIR = new Vector3(0, 0.8, 0.6).normalize()
function computeKeptQuat(v: DieValue): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(...TARGET_NORMALS[v]), KEEP_FACE_DIR)
}

// ── 移動アニメ定数 ──
const KEEP_MOVE_DUR    = 0.5            // 移動時間(秒)
const KEEP_ARC_HEIGHT  = 1.6            // 弧の高さ（画面上端を越えない控えめさ）
const KEEP_SPIN        = Math.PI * 2.5  // 1.25回転ぶんのスピン(終点で0に解ける)

// ── キープ済みダイス (物理なし・上空にフワフワ浮遊＋オーラ) ──
// fromPos からキープ位置(slotPos)へ「弧＋スピン」で移動して、キープ面正面で静止する。
const AURA1_BASE = 0.30
const AURA2_BASE = 0.14
interface KeepDieProps {
  displayValue: DieValue
  worldRot:     [number, number, number]   // 着地時の姿勢（移動アニメの開始姿勢）
  slotPos:      [number, number, number]
  fromPos:      [number, number, number]   // フィールド上の元位置（移動アニメの開始位置）
  canUnkeep:    boolean
  onUnkeep:     () => void
  /** オーラ色（将来 演出で変更できるようパラメータ化。デフォルト白） */
  auraColor?:   string
  /** フワフワの位相ずらし（ダイスごとに揺れをずらす） */
  bobOffset?:   number
}

function KeepDie({
  displayValue, worldRot, slotPos, fromPos, canUnkeep, onUnkeep,
  auraColor = '#ffffff', bobOffset = 0,
}: KeepDieProps) {
  const groupRef = useRef<Group>(null)
  const dieRef   = useRef<Group>(null)
  const auraRef  = useRef<Group>(null)
  const auraMat1 = useRef<MeshBasicMaterial>(null)
  const auraMat2 = useRef<MeshBasicMaterial>(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const textures = useMemo(() => MATERIAL_FACE_VALUES.map(createFaceTexture), [])

  // 開始姿勢(着地時)→終了姿勢(キープ面正面)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const startQuat = useMemo(() => new Quaternion().setFromEuler(new Euler(worldRot[0], worldRot[1], worldRot[2], 'XYZ')), [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const endQuat   = useMemo(() => computeKeptQuat(displayValue), [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const spinAxis  = useMemo(() => new Vector3(0.2, 1, 0.1).normalize(), [])
  const qa = useMemo(() => new Quaternion(), [])
  const qb = useMemo(() => new Quaternion(), [])

  const enterT   = useRef(0)
  const entering = useRef(true)

  useFrame((state, dt) => {
    const g = groupRef.current, d = dieRef.current, a = auraRef.current
    if (!g || !d) return

    if (entering.current) {
      enterT.current = Math.min(1, enterT.current + dt / KEEP_MOVE_DUR)
      const t = enterT.current
      const e = t * t * (3 - 2 * t)   // smoothstep
      // 位置: 直線補間 ＋ 放物線の弧
      g.position.x = fromPos[0] + (slotPos[0] - fromPos[0]) * e
      g.position.y = fromPos[1] + (slotPos[1] - fromPos[1]) * e + Math.sin(t * Math.PI) * KEEP_ARC_HEIGHT
      g.position.z = fromPos[2] + (slotPos[2] - fromPos[2]) * e
      // 姿勢: 開始→終了へ slerp、その上に終点で0へ解けるスピンを重ねる
      // （回転中は出目がブレる＝将来 display→final 書き換えを乗せる土台）
      qa.copy(startQuat).slerp(endQuat, e)
      qb.setFromAxisAngle(spinAxis, KEEP_SPIN * (1 - e))
      d.quaternion.copy(qb).multiply(qa)
      // オーラ: 移動中だけ強調（中盤で最大→終点で通常）
      const boost = Math.sin(t * Math.PI)
      if (a) a.scale.setScalar(1 + boost * 0.6)
      if (auraMat1.current) auraMat1.current.opacity = AURA1_BASE + boost * 0.45
      if (auraMat2.current) auraMat2.current.opacity = AURA2_BASE + boost * 0.30
      if (t >= 1) { entering.current = false; d.quaternion.copy(endQuat) }
    } else {
      // 静止: フワフワ浮遊 ＋ キープ面正面で固定
      const tt = state.clock.elapsedTime
      g.position.x = slotPos[0]
      g.position.z = slotPos[2]
      g.position.y = slotPos[1] + Math.sin(tt * 1.5 + bobOffset) * 0.22
      d.quaternion.copy(endQuat)
      if (a) a.scale.setScalar(1)
      if (auraMat1.current) auraMat1.current.opacity = AURA1_BASE
      if (auraMat2.current) auraMat2.current.opacity = AURA2_BASE
    }
  })

  return (
    <group
      ref={groupRef}
      position={fromPos}
      onClick={(e) => { e.stopPropagation(); if (canUnkeep) onUnkeep() }}
    >
      {/* ダイス本体（姿勢は useFrame で制御）。
          キープ面(=displayValue)は白く明るくクッキリ、他の面は暗く薄く見せる */}
      <group ref={dieRef}>
        <mesh castShadow>
          <boxGeometry args={[1, 1, 1]} />
          {textures.map((tex, i) => {
            const isKeptFace = MATERIAL_FACE_VALUES[i] === displayValue
            return (
              <meshStandardMaterial
                key={i}
                attach={`material-${i}`}
                map={tex}
                color={isKeptFace ? '#ffffff' : '#3a3a3a'}
                roughness={0.4}
                metalness={0.0}
              />
            )
          })}
        </mesh>
      </group>

      {/* オーラ（淡い光の膜。球状・加算合成。色はパラメータ化）。
          side=BackSide で「裏面のみ」描画 → ダイス前面の出目に重ならず、周囲のハローだけ光る */}
      <group ref={auraRef}>
        <mesh>
          <sphereGeometry args={[1.05, 24, 24]} />
          <meshBasicMaterial
            ref={auraMat1}
            color={auraColor} transparent opacity={AURA1_BASE}
            depthWrite={false} blending={AdditiveBlending} side={BackSide}
          />
        </mesh>
        <mesh>
          <sphereGeometry args={[1.4, 24, 24]} />
          <meshBasicMaterial
            ref={auraMat2}
            color={auraColor} transparent opacity={AURA2_BASE}
            depthWrite={false} blending={AdditiveBlending} side={BackSide}
          />
        </mesh>
      </group>
    </group>
  )
}

// ── ダイス Config 生成ヘルパー ─────────────────────────
function makeDieConfig(
  id: number,
  displayValue: DieValue,
  opts: {
    initRot?: [number, number, number]
    pos?:     [number, number, number]
    impulse?: { x: number; y: number; z: number }
    torque?:  { x: number; y: number; z: number }
    kinematicSpawn?: boolean
    gatherTarget?:   [number, number, number]
  } = {},
  spawnOrigin?: [number, number, number],
  mountKey = 0,
): DieConfig {
  const angle = (id / 5) * Math.PI * 2 + Math.PI / 5
  const r = 1.0
  const [ox, oy, oz] = spawnOrigin ?? [0, 3.5, 0]

  // 投入口(spawnOrigin)からフィールド中央へ向かう水平ベクトル
  const toLen = Math.hypot(ox, oz) || 1
  const dirX  = -ox / toLen
  const dirZ  = -oz / toLen
  // ダイスごとに射出方向を扇状にばらす
  const fan = (id - 2) * 0.16
  const cf  = Math.cos(fan), sf = Math.sin(fan)
  const ejX = dirX * cf - dirZ * sf
  const ejZ = dirX * sf + dirZ * cf
  const speed = 10.0 + Math.random() * 1.0   // 中央へ向かう勢い（少し転がる程度）

  return {
    id,
    displayValue,
    initRot:       opts.initRot,
    ref:           createRef<FieldDieHandle | null>(),
    launchPos:     opts.pos ?? [
      ox + Math.cos(angle) * r,
      Math.max(0.8, oy),
      oz + Math.sin(angle) * r,
    ],
    launchImpulse: opts.impulse ?? {
      x: ejX * speed + (Math.random() - 0.5) * 0.4,
      y: -0.3,                                   // 軽く下向き → 斜め射出
      z: ejZ * speed + (Math.random() - 0.5) * 0.4,
    },
    launchTorque: opts.torque ?? {
      x: (Math.random() - 0.5) * 5.0,
      y: (Math.random() - 0.5) * 5.0,
      z: (Math.random() - 0.5) * 5.0,
    },
    kinematicSpawn: opts.kinematicSpawn,
    gatherTarget:   opts.gatherTarget,
    mountKey,
  }
}

function randomFinals(): DieValue[] {
  return Array.from({ length: 5 }, () => Math.ceil(Math.random() * 6)) as DieValue[]
}

// フィールド側物理は group0（カップ内ラトル group1 と隔離して誤衝突を防ぐ）。
const FIELD_GROUP = interactionGroups(0, [0])

// ── 雷 cover の物理パラメータ（実機調整用。FieldDie.thunder に渡す。gravity=-20 を考慮） ──
const THUNDER_IMP_UP = 11   // 上向き impulse（最高点の高さに効く。h≈impUp²/(2*20)）
const THUNDER_IMP_H  = 4    // 水平 impulse の振れ幅(±)
const THUNDER_TORQUE = 3    // トルク impulse の振れ幅(±)

// ── 雷v2（分解→再集合）の物理パラメータ（実機調整可。A1 とは独立） ──
const THUNDER_V2_COUNT = 128  // 使用する欠片数（FractureSystem プール上限と一致）
const THUNDER_V2_OPTS: FractureExplodeOpts = {
  hSpeed: 4,        // 水平初速の振れ幅(±)。弾けあって乗っかる勢い
  vSpeed: 5,        // 垂直初速（上向き中心）
  torque: 7,        // 角速度の振れ幅(±)
  spread: 0.15,     // 爆散開始 teleport の半径
  explodeDur: 0.05, // 爆散初速付与の猶予
  scatterDur: 0.6,  // 物理任せ期間
  lingerDur: 1.0,   // 散らばり終わったあとの余韻（1秒）
  assembleDur: 0.3, // origin へ収束する期間（旧0.6の2倍速）
  totalTimeout: 3.5,// 全体の安全 timeout（linger ぶん延長）
}

// ── 雷ビジュアル A1（発火点の稲妻＋着弾フラッシュ。すべて実機調整可。物理に非干渉） ──
const BOLT_TOP_Y      = 12      // 稲妻の発火点（上空）の高さ
const BOLT_SEG_MIN    = 3       // 稲妻セグメント数の下限
const BOLT_SEG_MAX    = 5       // 稲妻セグメント数の上限
const BOLT_JITTER     = 0.7     // 中継点の水平ランダムオフセット幅
const BOLT_RADIUS     = 0.09    // 稲妻の太さ
const BOLT_COLOR      = '#bfe0ff'
const BOLT_DUR        = 0.15    // 稲妻の表示時間（秒）
const IMPACT_DUR      = 0.10    // 着弾フラッシュの表示時間（秒）
const IMPACT_INTENSITY = 9      // 着弾フラッシュ点光源の強度（ピーク）

// ── フロアー（緑フェルト＝フィールド面。色・形は変更しない） ──
function Floor() {
  return (
    <RigidBody type="fixed" colliders="cuboid" collisionGroups={FIELD_GROUP}>
      <mesh receiveShadow position={[0, -0.5, 0]}>
        <boxGeometry args={[20, 1, 18]} />
        <meshStandardMaterial color="#2d6a2d" roughness={0.95} metalness={0.0} />
      </mesh>
    </RigidBody>
  )
}

// ── 背景の床（ダークウォルナットの木目）。フィールドの外側に広がる地面。物理なし・見た目のみ ──
function WoodFloor() {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tex = useMemo(() => createWoodTexture(), [])
  return (
    <mesh position={[0, -0.06, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[140, 140]} />
      <meshStandardMaterial map={tex} color="#ffffff" roughness={0.9} metalness={0.0} />
    </mesh>
  )
}

// ── 雷ビジュアル: 発火点（上空）→対象ダイス の稲妻ジグザグ＋着弾フラッシュ ──
// key で発火ごとに remount＝ジグザグ形状を再生成。物理なし・見た目のみ。短時間で自動フェード。
// power: 派手さ倍率（A1=1 / 雷v2=3）。本数・太さ・光量をスケール。
function ThunderStrikeFx({ x, z, power = 1 }: { x: number; z: number; power?: number }) {
  const boltRef  = useRef<Group>(null)
  const lightRef = useRef<PointLight>(null)
  const tRef     = useRef(0)

  const radius = BOLT_RADIUS                              // 太さは A1 基準で固定（power で変えない）
  const jitter = BOLT_JITTER * (1 + 0.3 * (power - 1))
  const boltCount = power >= 3 ? 3 : 1                    // 派手版は枝を複数本（太さでなく本数で派手に）

  // 折れ線（上空→対象、中継点を水平ランダムオフセット）を boltCount 本ぶん
  const bolts = useMemo(() => {
    const up = new Vector3(0, 1, 0)
    return Array.from({ length: boltCount }).map(() => {
      const n = BOLT_SEG_MIN + Math.floor(Math.random() * (BOLT_SEG_MAX - BOLT_SEG_MIN + 1))
      const top = new Vector3(x + (Math.random() * 2 - 1) * jitter, BOLT_TOP_Y, z + (Math.random() * 2 - 1) * jitter)
      const bot = new Vector3(x, 0.5, z)
      const pts: Vector3[] = []
      for (let i = 0; i <= n; i++) {
        const p = top.clone().lerp(bot, i / n)
        if (i !== 0 && i !== n) {
          p.x += (Math.random() * 2 - 1) * jitter
          p.z += (Math.random() * 2 - 1) * jitter
        }
        pts.push(p)
      }
      return pts.slice(0, -1).map((a, i) => {
        const b = pts[i + 1]
        const dir = b.clone().sub(a)
        const len = dir.length()
        const mid = a.clone().add(b).multiplyScalar(0.5)
        const q = new Quaternion().setFromUnitVectors(up, dir.clone().normalize())
        return { pos: [mid.x, mid.y, mid.z] as [number, number, number],
                 quat: [q.x, q.y, q.z, q.w] as [number, number, number, number], len }
      })
    })
  }, [x, z, jitter, boltCount])

  useFrame((_, dt) => {
    tRef.current += dt
    const t = tRef.current
    if (boltRef.current)  boltRef.current.visible = t < BOLT_DUR
    if (lightRef.current) lightRef.current.intensity = t < IMPACT_DUR ? IMPACT_INTENSITY * power * (1 - t / IMPACT_DUR) : 0
  })

  return (
    <group>
      <group ref={boltRef}>
        {bolts.map((segs, bi) => segs.map((s, i) => (
          <mesh key={`${bi}-${i}`} position={s.pos} quaternion={s.quat}>
            <cylinderGeometry args={[radius, radius, s.len, 6]} />
            <meshBasicMaterial color={BOLT_COLOR} transparent opacity={0.9}
              blending={AdditiveBlending} depthWrite={false} />
          </mesh>
        )))}
      </group>
      <pointLight ref={lightRef} position={[x, 1.0, z]} intensity={0} distance={9 * (1 + 0.5 * (power - 1))} color={BOLT_COLOR} />
    </group>
  )
}

// ── 炎 cover（GPU パーティクル＋コアスプライト。発生→拡大して隠す→消える の3段階） ──
// 火炎放射器イメージ：全方向バースト射出＋乱流うねり。フェイズ時間・定数はすべて実機調整可。
const FIRE_PHASE1_DUR = 1.5    // 発生（小さく成長）
const FIRE_PHASE2_DUR = 3.0    // 拡大して完全に隠す
const FIRE_PHASE3_DUR = 1.2    // 縮小して消える
const FIRE_COVER_AT   = 0.5    // 段階2のこの割合で「完全に隠れた」とみなし swap を1回だけ実行
const FIRE_TIMEOUT    = FIRE_PHASE1_DUR + FIRE_PHASE2_DUR + FIRE_PHASE3_DUR + 0.5

// GPU パーティクル定数（火炎放射器チューニング）
const FIRE_P_COUNT    = 150    // 常設スロット数
const FIRE_P_LIFE_MIN = 0.6    // 柱状炎：寿命長め
const FIRE_P_LIFE_MAX = 1.5
const FIRE_EMIT_RATE  = 80     // particles/sec
const FIRE_TURB_FREQ  = 7.0    // 乱流の周波数
const FIRE_TURB_AMP   = 0.5    // 乱流の振幅（方向感を壊さない程度に抑える）

const FIRE_VERT = /* glsl */`
  attribute float life;
  attribute float maxLife;
  attribute float psize;
  varying float vAge;
  void main() {
    float lr = clamp(life / max(maxLife, 0.001), 0.0, 1.0);
    vAge = 1.0 - lr;   // 0=生まれたて, 1=老
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    // 若い粒子ほど大きく（爆炎の勢い）
    float sizeMod = lr < 0.3 ? (lr / 0.3) : 1.0;
    gl_PointSize = psize * sizeMod * (580.0 / -mvPos.z);
    gl_Position = projectionMatrix * mvPos;
  }
`

const FIRE_FRAG = /* glsl */`
  uniform sampler2D map;
  varying float vAge;
  void main() {
    vec4 tex = texture2D(map, gl_PointCoord);
    // 生まれたて=白熱(白/黄), 中盤=橙, 老い=暗赤
    vec3 hotCol  = vec3(1.0,  0.95, 0.55);
    vec3 midCol  = vec3(1.0,  0.38, 0.04);
    vec3 coolCol = vec3(0.65, 0.03, 0.0);
    vec3 col = vAge < 0.45
      ? mix(hotCol, midCol, vAge / 0.45)
      : mix(midCol, coolCol, (vAge - 0.45) / 0.55);
    float a = tex.a * (1.0 - vAge) * 0.95;
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, a);
  }
`

// パーティクル1個を空きスロットへ配置（全方向バースト射出）
function spawnFireParticle(
  active: Uint8Array, px: Float32Array, py: Float32Array, pz: Float32Array,
  vx: Float32Array, vy: Float32Array, vz: Float32Array,
  life: Float32Array, maxLife: Float32Array, psize: Float32Array,
  masterScale: number,
) {
  for (let i = 0; i < FIRE_P_COUNT; i++) {
    if (active[i]) continue
    // カメラ視点の「画面上」方向 = world [0, +0.316, -0.949] に向けた円錐射出
    // camera=[0,18,6] → lookAt=[0,0,0] から導出した screenUp ベクトル
    const spd = (4.0 + Math.random() * 4.0) * masterScale   // 速くしてコアスプライト外へ出す
    const spreadX  = (Math.random() - 0.5) * 0.5
    const spreadSU = (Math.random() - 0.5) * 0.25
    vx[i] = spreadX * spd
    vy[i] = (0.316 + spreadSU) * spd
    vz[i] = (-0.949 - Math.abs(spreadX) * 0.1) * spd
    // 原点近傍から射出（わずかなばらけ）
    px[i] = (Math.random() - 0.5) * 0.15 * masterScale
    py[i] = (Math.random() - 0.5) * 0.15 * masterScale
    pz[i] = (Math.random() - 0.5) * 0.15 * masterScale
    const ml = FIRE_P_LIFE_MIN + Math.random() * (FIRE_P_LIFE_MAX - FIRE_P_LIFE_MIN)
    life[i] = ml; maxLife[i] = ml
    psize[i] = (5.25 + Math.random() * 8.25) * masterScale
    active[i] = 1
    return
  }
}

function FireFx({ x, y, z, onPhase, onCover, onDone }: {
  x: number; y: number; z: number
  onPhase: (n: 1 | 2 | 3) => void
  onCover: () => void
  onDone: () => void
}) {
  const tex = useMemo(() => createFlameTexture(), [])

  // CPU-side particle arrays + GPU ジオメトリを命令型で一括生成
  // （<bufferAttribute> JSX は props 設定順不定で初期化失敗するため使わない）
  const { pa, geo } = useMemo(() => {
    const pos3    = new Float32Array(FIRE_P_COUNT * 3).fill(1e4)
    const lifeArr = new Float32Array(FIRE_P_COUNT)
    const mlArr   = new Float32Array(FIRE_P_COUNT).fill(1)
    const szArr   = new Float32Array(FIRE_P_COUNT)
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos3,    3))
    g.setAttribute('life',     new BufferAttribute(lifeArr, 1))
    g.setAttribute('maxLife',  new BufferAttribute(mlArr,   1))
    g.setAttribute('psize',    new BufferAttribute(szArr,   1))
    return {
      pa: {
        active:  new Uint8Array(FIRE_P_COUNT),
        px: new Float32Array(FIRE_P_COUNT), py: new Float32Array(FIRE_P_COUNT), pz: new Float32Array(FIRE_P_COUNT),
        vx: new Float32Array(FIRE_P_COUNT), vy: new Float32Array(FIRE_P_COUNT), vz: new Float32Array(FIRE_P_COUNT),
        life: new Float32Array(FIRE_P_COUNT), maxLife: new Float32Array(FIRE_P_COUNT),
        psize: new Float32Array(FIRE_P_COUNT),
        pos3, lifeArr, mlArr, szArr,
      },
      geo: g,
    }
  }, [])

  const tRef       = useRef(0)
  const phaseRef   = useRef(0)
  const coveredRef = useRef(false)
  const doneRef    = useRef(false)
  const emitAcc    = useRef(0)

  useFrame((_, dt) => {
    if (doneRef.current) return
    tRef.current += dt
    const t = tRef.current
    let masterScale = 0, emitting = true

    if (t < FIRE_PHASE1_DUR) {
      if (phaseRef.current < 1) { phaseRef.current = 1; onPhase(1) }
      masterScale = t / FIRE_PHASE1_DUR
    } else if (t < FIRE_PHASE1_DUR + FIRE_PHASE2_DUR) {
      if (phaseRef.current < 2) { phaseRef.current = 2; onPhase(2) }
      const k = (t - FIRE_PHASE1_DUR) / FIRE_PHASE2_DUR
      masterScale = 1
      if (!coveredRef.current && k >= FIRE_COVER_AT) { coveredRef.current = true; onCover() }
    } else if (t < FIRE_PHASE1_DUR + FIRE_PHASE2_DUR + FIRE_PHASE3_DUR) {
      if (phaseRef.current < 3) { phaseRef.current = 3; onPhase(3) }
      const k = (t - FIRE_PHASE1_DUR - FIRE_PHASE2_DUR) / FIRE_PHASE3_DUR
      masterScale = 1 - k; emitting = false
    } else {
      if (!coveredRef.current) { coveredRef.current = true; onCover() }
      doneRef.current = true; onDone(); return
    }
    if (t >= FIRE_TIMEOUT) {
      if (!coveredRef.current) { coveredRef.current = true; onCover() }
      doneRef.current = true; onDone(); return
    }

    // パーティクル射出
    if (emitting && masterScale > 0.05) {
      emitAcc.current += dt * FIRE_EMIT_RATE
      while (emitAcc.current >= 1) {
        emitAcc.current -= 1
        spawnFireParticle(
          pa.active, pa.px, pa.py, pa.pz, pa.vx, pa.vy, pa.vz,
          pa.life, pa.maxLife, pa.psize, masterScale,
        )
      }
    }

    // パーティクル物理更新（CPU）― 乱流うねりで流体感を出す
    for (let i = 0; i < FIRE_P_COUNT; i++) {
      if (!pa.active[i]) {
        pa.pos3[i * 3] = 1e4; pa.pos3[i * 3 + 1] = 1e4; pa.pos3[i * 3 + 2] = 1e4
        pa.lifeArr[i] = 0; pa.mlArr[i] = 1; pa.szArr[i] = 0
        continue
      }
      pa.life[i] -= dt
      if (pa.life[i] <= 0) {
        pa.active[i] = 0
        pa.pos3[i * 3] = 1e4; pa.pos3[i * 3 + 1] = 1e4; pa.pos3[i * 3 + 2] = 1e4
        pa.lifeArr[i] = 0; pa.mlArr[i] = 1; pa.szArr[i] = 0
        continue
      }
      // 乱流は画面左右（world X）のみ。screenUp 軸(Y/Z)は乱さない＝柱を維持
      const ph = i * 2.399
      const turbScale = FIRE_TURB_AMP * masterScale
      pa.vx[i] += Math.sin(t * FIRE_TURB_FREQ + ph) * turbScale * dt
      // 弱い重力
      pa.vy[i] -= 0.8 * dt
      // 速度減衰（空気抵抗）― コアスプライト外まで届くよう弱め
      const drag = 1 - dt * 0.7
      pa.vx[i] *= drag; pa.vy[i] *= drag; pa.vz[i] *= drag
      // 積分
      pa.px[i] += pa.vx[i] * dt
      pa.py[i] += pa.vy[i] * dt
      pa.pz[i] += pa.vz[i] * dt
      pa.pos3[i * 3]     = pa.px[i]
      pa.pos3[i * 3 + 1] = pa.py[i]
      pa.pos3[i * 3 + 2] = pa.pz[i]
      pa.lifeArr[i] = pa.life[i]
      pa.mlArr[i]   = pa.maxLife[i]
      pa.szArr[i]   = pa.psize[i]
    }

    // GPU アップロード（命令型で作成した BufferAttribute に直接 needsUpdate）
    geo.getAttribute('position').needsUpdate = true
    geo.getAttribute('life').needsUpdate     = true
    geo.getAttribute('maxLife').needsUpdate  = true
    geo.getAttribute('psize').needsUpdate    = true
  })

  return (
    <group position={[x, y + 0.1, z]}>
      {/* GPU パーティクル（命令型 BufferGeometry・加算ブレンド） */}
      <points renderOrder={11} geometry={geo} frustumCulled={false}>
        <shaderMaterial
          vertexShader={FIRE_VERT}
          fragmentShader={FIRE_FRAG}
          uniforms={{ map: { value: tex } }}
          blending={AdditiveBlending}
          transparent
          depthTest={false}
          depthWrite={false}
        />
      </points>
      {/* コアスプライト・グロー削除済み（パーティクルのみで表現） */}
    </group>
  )
}

// ── フィールド外周の見えない壁（場外飛び出し防止） ────────
// 床: x∈[-10,10], z∈[-9,9]。内側の面が境界に来るよう外側へ配置。
function Walls() {
  return (
    <RigidBody type="fixed" colliders={false} collisionGroups={FIELD_GROUP}>
      <CuboidCollider args={[10.5, 5, 0.5]} position={[0, 4,  9.5]} />
      <CuboidCollider args={[10.5, 5, 0.5]} position={[0, 4, -9.5]} />
      <CuboidCollider args={[0.5, 5, 9.5]} position={[ 10.5, 4, 0]} />
      <CuboidCollider args={[0.5, 5, 9.5]} position={[-10.5, 4, 0]} />
    </RigidBody>
  )
}

// ── 斬撃演出パターン抽選 ─────────────────────────────────
function selectSlashPattern(isSuccess: boolean): SlashAssemblePattern {
  if (!isSuccess) return Math.random() < 0.7 ? 'missA' : 'missB'
  return Math.random() < 0.4 ? 'successA' : 'successB'
}

// ── GameScene ───────────────────────────────────────
import type { NetMode } from '../net/useNetMode'

export function GameScene({ netMode }: { netMode?: NetMode } = {}) {
  const [phase,       setPhase]       = useState<GamePhase>('idle')
  const [turn,        setTurn]        = useState<Turn>('player')
  const [rollsLeft,   setRollsLeft]   = useState(3)
  const [dieStates,   setDieStates]   = useState<DieState[]>([])
  const [dieConfigs,  setDieConfigs]  = useState<DieConfig[]>([])
  const [rollKey,     setRollKey]     = useState(0)
  const [lastResult,  setLastResult]  = useState<{
    displayValues: DieValue[]; finalValues: DieValue[]; mode: EffectMode; effectId: CoverId
  } | undefined>()
  const [playerSheet, setPlayerSheet] = useState<ScoreSheetType>({ ...EMPTY_SHEET })
  const [cpuSheet,    setCpuSheet]    = useState<ScoreSheetType>({ ...EMPTY_SHEET })
  const [cpuThinking, setCpuThinking] = useState(false)
  const [gameOver,    setGameOver]    = useState(false)
  const [lastCpuCat,  setLastCpuCat]  = useState<string | null>(null)
  // 雷の発火点ビジュアル（稲妻＋着弾フラッシュ）。対象 die の XZ＋発火 key。null=非表示。
  const [thunderStrike, setThunderStrike] = useState<{ x: number; z: number; key: number; power: number } | null>(null)
  const thunderFireRef = useRef(0)
  // 炎 cover の視覚＋コールバック（key で発火ごとに remount）。
  const [fireFx, setFireFx] = useState<
    { x: number; y: number; z: number; key: number;
      onPhase: (n: 1 | 2 | 3) => void; onCover: () => void; onDone: () => void } | null
  >(null)
  const fireFxKeyRef = useRef(0)
  // Yacht 演出
  const [yachtActive, setYachtActive] = useState(false)
  const yachtKeyRef   = useRef(0)
  const [slashActive, setSlashActive] = useState(false)
  const slashKeyRef      = useRef(0)
  const slashDieRef      = useRef<SlashDieEffectHandle>(null)
  // DEBUG: 割れ演出の success/miss モード
  const [slashDieMode,   setSlashDieMode]   = useState<'success' | 'miss'>('success')
  const [slashBArmedUI,  setSlashBArmedUI]  = useState(false)   // DEBUGパネル表示用（ref と同期）
  const darkOverlayRef  = useRef<HTMLDivElement>(null)
  const flashOverlayRef = useRef<HTMLDivElement>(null)
  const onDark  = useCallback((v: number) => { if (darkOverlayRef.current)  darkOverlayRef.current.style.opacity  = String(v) }, [])
  const onFlash = useCallback((v: number) => { if (flashOverlayRef.current) flashOverlayRef.current.style.opacity = String(v) }, [])

  // ── Refs ─────────────────────────────────────────
  const cupRef          = useRef<CupAnimHandle>(null)
  const fractureRef     = useRef<FractureSystemHandle>(null)   // 雷v2 の分解システム
  const pendingSpawnRef = useRef<{
    states:      DieState[]
    cupIndices:  number[]
    swapIndices: number[]
  } | null>(null)
  const settleNeededRef = useRef(0)
  const settleCountRef  = useRef(0)
  const diceSettledRef  = useRef(false)   // settled フェーズ到達後のスプリアス onSettle を抑制
  // staging（flip/thunder）を「プレイヤーの最初の操作」で起動するための装填フラグ。
  // 集約完了時に cover ありなら true、staging を1回再生（消費）すると false。集約ごとに1回。
  const stagingArmedRef  = useRef(false)
  const pendingStagingRef = useRef(false)         // onStaging が gather 完了前に届いた場合のキュー（観戦側）
  const slashBArmedRef   = useRef(false)         // B系統演出: gathering をスキップするフラグ
  const slashBTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)  // B系統 force-restore 用

  // ── プレイログ ──────────────────────────────────
  type LogEntry =
    | { type: 'roll';   turn: 'player'|'cpu'; rollNo: number; finalValues: number[]; displayValues: number[]; effectId: string; displayRank: string }
    | { type: 'record'; turn: 'player'|'cpu'; roundNo: number; category: string; points: number }
  const gameLogRef      = useRef<LogEntry[]>([])
  const gameStartedAtRef = useRef(new Date().toISOString())
  const rollNoRef       = useRef(0)   // ターン内のロール番号（1〜3）
  const roundNoRef      = useRef(0)   // ゲーム全体のラウンド番号（1〜13）
  const slashBTargetIdRef = useRef<number | null>(null) // B系統演出: 対象ダイスID
  const swapIndicesRef  = useRef<number[]>([])
  const dieStatesRef    = useRef<DieState[]>([])
  /** window.__ グローバルの代替: スポーン時に設定 */
  const cupIndicesRef   = useRef<number[]>([])
  const dieRefsRef      = useRef<React.RefObject<FieldDieHandle | null>[]>([])
  const dieConfigsRef   = useRef<DieConfig[]>([])
  const keepCounterRef  = useRef(0)
  /** 直近のロール結果（再振りでデバッグ指定値を振り直し分へ反映するため参照） */
  const lastResultRef   = useRef<{ displayValues: DieValue[]; finalValues: DieValue[]; mode: EffectMode; effectId: CoverId } | null>(null)
  // DEBUG パネルの mode/cover 強制（1投目で受け取り、再振りにも引き継ぐ）。auto/auto＝通常抽選。
  const debugModeRef    = useRef<EffectMode>('auto')
  const debugCoverRef   = useRef<CoverForce>('auto')

  // ── 音: 勝利ファンファーレ（SE.win は SE OFF 時は自動で無音） ──
  useEffect(() => { if (gameOver) SE.win() }, [gameOver])

  // ── BGM: mount 時に healing15 をループ開始（autoplay 制約時は初回操作で開始） ──
  useEffect(() => { bgm.playDefault() }, [])

  // ── ゲームオーバー判定 ────────────────────────────
  function checkGameOver(pSheet: ScoreSheetType, cSheet: ScoreSheetType) {
    const pFilled = Object.values(pSheet).filter(v => v !== null).length
    const cFilled = Object.values(cSheet).filter(v => v !== null).length
    return pFilled === TOTAL_CATEGORIES && cFilled === TOTAL_CATEGORIES
  }

  // ── spawnDice: ダイスをフィールドに出現させる ────────
  function spawnDice(
    states:      DieState[],
    cupIndices:  number[],
    swapIndices: number[],
    spawnOrigin?: [number, number, number]
  ) {
    const configs = states.map(s => {
      if (s.location === 'kept' && s.worldPos && s.worldRot) {
        // キープ済みは FieldDie として描画しないが、
        // dieRefsRef の index alignment のためにダミー config を作る
        return makeDieConfig(
          s.id, s.displayValue,
          { initRot: s.worldRot, pos: [...s.worldPos],
            impulse: { x: 0, y: 0, z: 0 }, torque: { x: 0, y: 0, z: 0 } },
          undefined, s.mountKey,
        )
      }
      return makeDieConfig(s.id, s.displayValue, {}, spawnOrigin, s.mountKey)
    })

    dieStatesRef.current   = states
    swapIndicesRef.current = swapIndices
    cupIndicesRef.current  = cupIndices
    dieRefsRef.current     = configs.map(c => c.ref)
    dieConfigsRef.current  = configs

    const fieldCount        = states.filter(s => s.location === 'field').length
    settleNeededRef.current = fieldCount || 1
    settleCountRef.current  = 0
    diceSettledRef.current  = false

    setDieStates(states)
    setDieConfigs(configs)
    setRollKey(k => k + 1)
    setPhase('rolling')
    // カップ投入音（旧「パンッ」）は廃止。代わりに finalValue で成立する役の最高点が 30 以上のとき、
    // CONFIDENCE_PROB の確率で信頼度演出音（gako / gakokyuin 50/50）を鳴らす。判定は1回だけ。
    maybePlayConfidenceSE(states.map(s => s.finalValue))
  }

  // ── 今回の cover（effectId）と swap 有無（mode）を1箇所で解決する ──
  // 抽選結果を effectId に潰さず { effectId, mode } で保持し、staging or pre_gather_cover まで運ぶ。
  // ★computeShowDice より前に解決することで、success の見せ札（display→final 書き換え）を
  //   投入時に仕込める（cupHide/flip の success は同じ見せ札パイプラインを共有）。
  //   mode==='none' は常に演出なし。cover 強制(cupHide/flip)はデバッグ用（flip は success 専用）。
  //
  // cupHide は「4キープ再振り（fieldCount===1）」限定の独立抽選で発火する。テーブルからは外れている。
  //   ・auto モード×fieldCount===1: drawIndependentCupHide で 35/15/50 抽選。none ならテーブルへフォールスルー。
  //   ・cover='cupHide' 強制: fieldCount===1 のときだけ発火。条件外なら無視（cover='auto' と同じ扱い）。
  const resolveEffect = useCallback(
    (finals: DieValue[], mode: EffectMode, cover: CoverForce, fieldCount: number)
      : { effectId: CoverId; mode: EffectMode } => {
      if (mode === 'none') return { effectId: 'none', mode: 'none' }            // 演出なしが最優先
      if (cover === 'flip')       return { effectId: 'flip',       mode: 'success' }  // flip は success 専用
      if (cover === 'thunder')    return { effectId: 'thunder',    mode: 'success' }  // 雷A1 も success 専用
      if (cover === 'thunder_v2') return { effectId: 'thunder_v2', mode: 'success' }  // 雷v2 も success 専用
      if (cover === 'fire')       return { effectId: 'fire', mode: mode === 'miss' ? 'miss' : 'success' }  // 炎は success/miss 両対応

      // cover='cupHide' 強制：4キープ再振り条件を満たすときだけ。満たさなければ cover='auto' に降格。
      if (cover === 'cupHide') {
        if (fieldCount === 1) return { effectId: 'cupHide', mode: mode === 'miss' ? 'miss' : 'success' }
        cover = 'auto'
      }

      // デバッグ強制 success/miss（cover='auto'）：
      //   ・4キープ再振り（fieldCount===1）→ cupHide で強制
      //   ・条件外：success → flip(success) で代替（cupHide が使えないため）／miss は cover なし
      if (mode === 'success' || mode === 'miss') {
        if (fieldCount === 1) return { effectId: 'cupHide', mode }
        return mode === 'success'
          ? { effectId: 'flip', mode: 'success' }
          : { effectId: 'none', mode: 'none' }
      }

      // mode === 'auto'（通常プレイ/CPU）
      // 4キープ再振り条件成立時、まず独立 cupHide 抽選（success/miss/none）。
      if (fieldCount === 1) {
        const d = drawIndependentCupHide()
        if (d.effectId === 'cupHide') return { effectId: 'cupHide', mode: d.variant ?? 'miss' }
        // d.effectId === 'none' → テーブル抽選へフォールスルー（flip / none）
      }

      // 役ランク → テーブル抽選（cupHide は入っていない）
      // 化けるダイス（現在表示≠新final）が存在すれば slashB 重みを 1.5 倍にブースト
      const hasDiffDie = dieStatesRef.current
        .filter(s => s.location === 'field')
        .some(s => finals[s.id] !== undefined && finals[s.id] !== s.displayValue)
      const draw = selectEffectFromTable(getDisplayRank(finals), Math.random, hasDiffDie ? 1.5 : 1.0)
      if (draw.effectId === 'none') return { effectId: 'none', mode: 'none' }
      return { effectId: draw.effectId, mode: draw.variant ?? 'miss' }
    },
    [],
  )

  // ── 1投目: カップにセット ─────────────────────────
  const preparePendingRoll = useCallback((
    finals: DieValue[], mode: EffectMode, cover: CoverForce = 'auto',
    netInject?: { displayValues: DieValue[]; effectId: CoverId; effectVariant: EffectMode },
  ) => {
    debugModeRef.current = mode; debugCoverRef.current = cover   // 再振りへ引き継ぐため保持
    let eff: { effectId: CoverId; mode: EffectMode }
    let showValues: DieValue[]
    let cupIndices: number[], swapIndices: number[]
    if (netInject) {
      // ネット観戦側: ホストが決定した値をそのまま使う（ローカルで再抽選しない）
      eff = { effectId: netInject.effectId, mode: netInject.effectVariant }
      showValues = netInject.displayValues
      cupIndices = []
      // displayValue≠finalValue のダイスを swap 対象として復元（炎・フリップ等の演出ターゲット特定に必要）
      swapIndices = finals.map((f, i) => showValues[i] !== f ? i : -1).filter(i => i >= 0)
    } else {
      // 1投目は5個すべて field → fieldCount=5（cupHide 条件外）
      eff = resolveEffect(finals, mode, cover, 5)
      // デバッグパネルで slashB を手動装填している場合は effectId を上書き（ゲストへ正しく伝播させるため）
      if (slashBArmedRef.current) eff = { ...eff, effectId: 'slashB' }
      // ヨット成立時: 前段演出（slashB/cupHide 等）を抑制し、光の柱 staging のみに集中させる
      const isYacht1 = finals.length === 5 && finals.every(v => v === finals[0])
      if (isYacht1) {
        eff = { effectId: 'none', mode: 'none' }
        slashBArmedRef.current = false
        // ヨット: 全ダイスがfield（1投目）→ field から1個ランダムにデコイを仕込む（光の柱で書き換えを見せる）
        ;({ showValues, cupIndices, swapIndices } = computeShowDice(finals, 'success', []))
      } else {
        ;({ showValues, cupIndices, swapIndices } = computeShowDice(finals, eff.mode))
      }
    }
    const effMode = eff.mode
    const states: DieState[] = finals.map((finalValue, id) => ({
      id,
      displayValue: showValues[id],
      finalValue,
      worldPos:  null,
      worldRot:  null,
      location:  'field' as const,
      keepOrder: -1,
      mountKey:  0,
    }))
    keepCounterRef.current = 0
    const res = { displayValues: showValues, finalValues: finals, mode: effMode, effectId: eff.effectId }
    lastResultRef.current = res        // 再振りで指定値を反映するため保持
    setLastResult(res)
    rollNoRef.current = 1
    gameLogRef.current.push({ type: 'roll', turn, rollNo: 1, finalValues: finals, displayValues: showValues, effectId: eff.effectId, displayRank: getDisplayRank(finals) })
    setRollsLeft(2)
    // ネットモード（ホスト）: ロール結果をゲストへ送信 → 両者ともカップ自動投入
    // inject 側（観戦）は notifyRoll しない（ループ防止）
    if (!netInject) netMode?.notifyRoll(finals, showValues, eff.effectId, effMode, [], 2)
    // 観戦側は onCupThrown 受信時に triggerAutoRoll するため、ここでは何もしない
    pendingSpawnRef.current = { states, cupIndices, swapIndices }
    // (A) ターン開始の最初の投入用にカップへ5個用意（setRollReady が中身を表示） */
    cupRef.current?.setRollReady(showValues, 5)
    setPhase('cup_ready')
  }, [resolveEffect, netMode])

  // ── カップ反転時に呼ばれる → 実際にスポーン ──────────
  const handleCupSpawn = useCallback((pourOrigin: [number, number, number]) => {
    const pending = pendingSpawnRef.current
    if (!pending) return
    pendingSpawnRef.current = null
    spawnDice(pending.states, pending.cupIndices, pending.swapIndices, pourOrigin)
  }, [])

  // ── 再振り（ワープ方式） ───────────────────────────
  // 非キープ(field)ダイスを即フィールドから消し、その数だけカップの中身として出現させる。
  // ・キープ(kept)の finalValue は固定（再抽選しない）。
  // ・振り直す分の finalValue を新規抽選。auto=false(プレイヤー)はデバッグ指定値を反映する。
  // ・カップ内が1〜5個のいずれでもフリーズしないよう「実際に振る数(count)」で処理する。
  // auto=true(CPU) は続けて自動でカップを振る。
  const handleReRoll = useCallback((auto = false, skipNotify = false) => {
    const cur = dieStatesRef.current
    const count = cur.filter(s => s.location === 'field').length
    if (count === 0) return   // 振り直す対象なし（全キープ）→ 何もしない

    const specified = lastResultRef.current?.finalValues   // デバッグ/前回の確定目
    const newStates: DieState[] = cur.map(s => {
      if (s.location === 'kept') return { ...s }   // キープ分は固定（不変）
      // 振り直し分: CPU/ネットホストは新規ランダム、ソロプレイヤーはデバッグ指定値（無ければランダム）
      const v = (auto || (netMode?.role === 'host')
        ? Math.ceil(Math.random() * 6)
        : (specified?.[s.id] ?? Math.ceil(Math.random() * 6))) as DieValue
      return {
        ...s,
        displayValue: v,
        finalValue:   v,
        worldPos:     null,
        worldRot:     null,
        mountKey:     s.mountKey + 1,
      }
    })
    // 再振りも「通常プレイ」扱い＝確率テーブルで具体 mode に解決（デバッグ強制は1投目のみ）。
    // success の見せ札（display→final）は computeShowDice で組み立てる。ただし見せ札の差し替えは
    // 再振り対象(field)のみ反映する（キープ分は既に表示済み＝固定）。
    const finalsAll = newStates.map(s => s.finalValue) as DieValue[]
    // 再振りにも DEBUG の mode/cover を引き継ぐ（auto/auto＝通常抽選）。cupHide は count===1 のみ成立。
    let eff = resolveEffect(finalsAll, debugModeRef.current, debugCoverRef.current, count)
    // デバッグパネルで slashB 手動装填時は effectId を上書き（ゲストへ正しく伝播させるため）
    if (slashBArmedRef.current) eff = { ...eff, effectId: 'slashB' }
    // ヨット成立時: 前段演出（slashB/cupHide 等）を抑制し、光の柱 staging のみに集中させる
    const isYacht2 = finalsAll.length === 5 && finalsAll.every(v => v === finalsAll[0])
    if (isYacht2) {
      eff = { effectId: 'none', mode: 'none' }
      slashBArmedRef.current = false
    }
    // ヨット時: キープ外ダイスのみからデコイを選ぶ（光の柱で書き換えが見えるように）
    const keptIdsForDecoy = newStates.filter(s => s.location === 'kept').map(s => s.id)
    const { showValues, cupIndices, swapIndices } = computeShowDice(
      finalsAll,
      isYacht2 ? 'success' : eff.mode,
      keptIdsForDecoy,
    )
    const shownStates = newStates.map(s =>
      s.location === 'field' ? { ...s, displayValue: showValues[s.id] } : s
    )
    const sv = shownStates.map(s => s.displayValue) as DieValue[]
    pendingSpawnRef.current = { states: shownStates, cupIndices, swapIndices }
    lastResultRef.current = { displayValues: sv, finalValues: finalsAll, mode: eff.mode, effectId: eff.effectId }
    rollNoRef.current += 1
    gameLogRef.current.push({ type: 'roll', turn, rollNo: rollNoRef.current, finalValues: finalsAll, displayValues: sv, effectId: eff.effectId, displayRank: getDisplayRank(finalsAll) })
    // ネットモード（ホスト）: 再振り結果をゲストへ送信
    // skipNotify=true の場合はホストが観戦中（onRollResult 経由）= hostProcessGuestRoll が既に送信済み
    const keptIdsAfterReroll = newStates.filter(s => s.location === 'kept').map(s => s.id)
    if (!skipNotify) netMode?.notifyRoll(finalsAll, sv, eff.effectId, eff.mode, keptIdsAfterReroll, Math.max(0, rollNoRef.current - 1))
    // ワープ: 非キープは即フィールドから消え、カップ内(count個)の中身として出現
    dieStatesRef.current = shownStates
    setDieStates(shownStates)
    setDieConfigs([])
    cupRef.current?.setRollReady(sv, count)
    setRollsLeft(r => r - 1)
    setPhase('cup_ready')
    // CPU自動・観戦側のみ自動投入。アクティブプレイヤー（再振り）は手動クリック。
    if (auto) cupRef.current?.triggerAutoRoll()
  }, [resolveEffect])

  // ── ダイス静止コールバック ────────────────────────
  // ── 中央集約: 静止後、全ダイス(キープ欄含む)を5円へシャッフル配置 ──
  // ・field ダイス: 既存 FieldDie を gatherTo で移動（姿勢維持）
  // ・kept ダイス: キープ欄から中央へ戻す（kinematic 出現→集約）。location を field に戻し keep をリセット
  // → 毎投入後、5個すべてが中央に集まり、改めてキープを選び直す形になる
  const gatherFieldDice = useCallback(() => {
    const states = dieStatesRef.current
    if (states.length === 0) return

    // ネットモード: シャッフルなし・ジッターなし → ホスト/ゲストで集約位置を完全一致させる
    // ソロ/CPU: ランダムシャッフル＋ジッターあり
    const idxs = [0, 1, 2, 3, 4]
    if (!netMode) {
      for (let i = idxs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[idxs[i], idxs[j]] = [idxs[j], idxs[i]]
      }
    }
    const keptSorted = states.filter(s => s.location === 'kept').sort((a, b) => a.keepOrder - b.keepOrder)

    // 各ダイスの集約先
    const targets = new Map<number, [number, number, number]>()
    states.forEach((s, k) => {
      // ネットモード: s.id(0〜4固定)でスロット決定 → 両クライアントで完全一致
      const slotIdx = netMode ? s.id : idxs[k % 5]
      const [cx, cz] = GATHER_CENTERS[slotIdx]
      // ネットモード: ジッターなし（中心に揃える）
      const rr  = netMode ? 0 : Math.sqrt(Math.random()) * GATHER_RADIUS
      const ang = netMode ? 0 : Math.random() * Math.PI * 2
      targets.set(s.id, [cx + Math.cos(ang) * rr, GATHER_Y, cz + Math.sin(ang) * rr])
    })

    // field ダイスは既存 FieldDie を即 gatherTo
    states.filter(s => s.location === 'field').forEach(s => {
      const cfgIdx = dieConfigsRef.current.findIndex(c => c.id === s.id)
      dieRefsRef.current[cfgIdx]?.current?.gatherTo(targets.get(s.id)!)
    })

    // kept ダイスは kinematic 出現で中央へ戻す config に差し替え
    const newConfigs = dieConfigsRef.current.map(c => {
      const s = states.find(x => x.id === c.id)
      if (s && s.location === 'kept') {
        const rank = keptSorted.indexOf(s)
        const from = KEEP_SLOTS[rank] ?? (s.worldPos as [number, number, number])
        return makeDieConfig(
          s.id, s.displayValue,
          { initRot: s.worldRot ?? undefined, pos: [...from],
            kinematicSpawn: true, gatherTarget: targets.get(s.id) },
          undefined, s.mountKey + 1,
        )
      }
      return c
    })

    // 全ダイスを location='field'・keepReset・worldPos=集約先 に
    dieStatesRef.current = states.map(s => ({
      ...s, location: 'field' as const, keepOrder: -1, worldPos: targets.get(s.id)!,
      mountKey: s.location === 'kept' ? s.mountKey + 1 : s.mountKey,
    }))
    dieConfigsRef.current = newConfigs
    dieRefsRef.current    = newConfigs.map(c => c.ref)
    keepCounterRef.current = 0
    setDieStates([...dieStatesRef.current])
    setDieConfigs([...newConfigs])
  }, [])

  // ── keep_select 入り: 操作受付開始 ────────────────────
  const enterKeepSelect = useCallback(() => {
    setPhase('keep_select')
    setDieStates([...dieStatesRef.current])
  }, [])

  // ── 演出: カップ隠し再生（4キープ再振り限定。集約「前」、振った1個に被せる） ──
  // 対象は常に field（=再振りで投げた1個）。kept は上空にあるので絶対に対象にしない。
  // success のとき、カップで完全に隠れた瞬間に対象を「final の面が真上」へ回転スナップ（不可視＝やりたい放題）。
  const playCupHide = useCallback((onDone: () => void) => {
    const states = dieStatesRef.current
    const finals = states.map(s => s.finalValue)
    const field  = states.find(s => s.location === 'field')   // 4キープ再振り＝field は1個のみ
    if (!field || !field.worldPos) { onDone(); return }       // 保険
    const refs = dieRefsRef.current
    cupRef.current?.animate(
      field.worldPos[0], field.worldPos[2],
      () => { for (const i of swapIndicesRef.current) refs[i]?.current?.orientTo(finals[i]) },  // 隠れた間に回転
      onDone,
    )
  }, [])

  // ── 演出: フリップ cover（success 専用。対象1個を跳ね上げ回転して final の面を真上に） ──
  // cup を使わず回転そのもので出目を入れ替える。対象以外は動かさない・値も変えない。
  const playFlip = useCallback((onDone: () => void) => {
    const finals = dieStatesRef.current.map(s => s.finalValue)
    const swap   = swapIndicesRef.current
    const refs   = dieRefsRef.current
    const target = swap[0]                       // success の差し替え対象（1個）
    const dieRef = target != null ? refs[target]?.current : null
    if (!dieRef) { onDone(); return }            // 対象なし（保険）→ 素通し
    playFlipSE()                                 // 跳ね上げ初動で jump.wav
    dieRef.flip(finals[target], onDone)          // final の面が真上に来るよう回転
  }, [])

  // ── 演出: 雷 cover（物理演出ポリシーの参照実装。success 専用） ──
  // 対象 = swapIndices[0] の1個だけ。FieldDie.thunder が dynamic 飛散→静止/timeout で
  // 集約スポット・「final の面が真上」へ回転復帰（テクスチャは塗り替えない）。他4個は kinematic で不動。
  const playThunder = useCallback((onDone: () => void) => {
    const states = dieStatesRef.current
    const finals = states.map(s => s.finalValue)
    const swap   = swapIndicesRef.current
    const refs   = dieRefsRef.current
    const target = swap[0]
    const dieRef = target != null ? refs[target]?.current : null
    if (!dieRef || target == null) { onDone(); return }   // 対象なし（保険）→ 素通し
    let firstStrike = true                                // 雷SEは演出中1回だけ（初回着弾で）
    dieRef.thunder(
      { impUp: THUNDER_IMP_UP, impH: THUNDER_IMP_H, torque: THUNDER_TORQUE },
      finals[target],                                   // 自然に上へ出したい目（=final）。誘導＆判定基準
      (x: number, z: number) => {                         // 雷を1発撃つ視覚（初回＋再雷ごと、現在位置に）
        thunderFireRef.current += 1
        setThunderStrike({ x, z, key: thunderFireRef.current, power: 1 })
        if (firstStrike) { firstStrike = false; playThunderA1SE() }   // 着弾と同期（1回だけ）
      },
      () => { setThunderStrike(null); onDone() },        // 終了で発火点ビジュアルを消す
    )
  }, [])

  // ── 演出: 雷v2（分解→再集合→再生→swap）。FractureSystem を利用。success 専用 ──
  // 不動契約: 対象1個以外の field/kept・カップは集約完了後 kinematic 静止のまま（本演出は触らない）。
  // 本体ダイスは着弾点で隠して静止 → 欠片が爆散→飛散→集約点へ再集合 → 終端手前で本体を final 面で再表示。
  const playThunderV2 = useCallback((onDone: () => void) => {
    const states = dieStatesRef.current
    const finals = states.map(s => s.finalValue)
    const swap   = swapIndicesRef.current
    const refs   = dieRefsRef.current
    const target = swap[0]
    const dieRef = target != null ? refs[target]?.current : null
    const pos    = target != null ? states.find(s => s.id === target)?.worldPos : undefined
    if (!dieRef || target == null || !pos) { onDone(); return }   // 保険
    // 着弾視覚（A1 と同じ稲妻＋着弾フラッシュを共有）＋着弾音（thunder4）
    thunderFireRef.current += 1
    setThunderStrike({ x: pos[0], z: pos[2], key: thunderFireRef.current, power: 3 })   // 雷v2 は3倍派手
    playThunderV2SE()
    // 本体ダイスを非表示（コライダーも無効化）＋隠れている間に先に final 面へ回しておく
    // （onAssembled で回すと回転反映前の1フレームに decoy 面が見えるラグが出るため、先回りする）。
    dieRef.setHidden(true)
    dieRef.orientTo(finals[target])
    fractureRef.current?.fracture(
      [pos[0], pos[1], pos[2]], THUNDER_V2_COUNT, THUNDER_V2_OPTS,
      () => { dieRef.setHidden(false) },             // onAssembled: 既に final 面 → 表示するだけ
      () => { setThunderStrike(null); onDone() },    // onComplete: 欠片退避完了 → staging 終了
    )
  }, [])

  // ── 演出: 炎 cover（局所・物理なし。success/miss 両対応）。発生→拡大して隠す→消える ──
  // 対象＝swapIndices[0]（success）／cupIndices[0]（miss）／無ければ field 先頭。covers 中に
  // success のみ orientTo(final) で書き換え（隠れて回転）。他ダイス・カップには触れない。
  const playFire = useCallback((onDone: () => void) => {
    const states = dieStatesRef.current
    const finals = states.map(s => s.finalValue)
    const swap   = swapIndicesRef.current
    const cup    = cupIndicesRef.current
    const refs   = dieRefsRef.current
    const fieldIds = states.filter(s => s.location === 'field').map(s => s.id)
    const target = swap[0] ?? cup[0] ?? fieldIds[0]
    const pos    = target != null ? states.find(s => s.id === target)?.worldPos : undefined
    if (target == null || !pos) { onDone(); return }   // 保険
    fireFxKeyRef.current += 1
    setFireFx({
      x: pos[0], y: pos[1], z: pos[2], key: fireFxKeyRef.current,
      onPhase: (n) => playFireSE(n),                                  // 段階SE fire1/2/3
      onCover: () => { for (const i of swap) refs[i]?.current?.orientTo(finals[i]) },  // 隠れて swap（miss は空）
      onDone:  () => { setFireFx(null); onDone() },
    })
  }, [])

  // ── 演出の登録（器・staging 専用）: cupHide は staging から外れている（pre_gather_cover で消費）。
  // 将来の staging 系演出は EffectId 追加＋ここに登録＋テーブル行追加だけで足せる。
  type StagingEffect = 'none' | 'flip' | 'thunder' | 'thunder_v2' | 'fire' | 'slashB'
  const stagingPlayers = useRef<Record<StagingEffect, (onDone: () => void) => void>>({
    none:       (onDone) => onDone(),                  // 演出なし＝即通過
    fire:       (onDone) => playFire(onDone),
    flip:       (onDone) => playFlip(onDone),
    thunder:    (onDone) => playThunder(onDone),
    thunder_v2: (onDone) => playThunderV2(onDone),
    slashB:     (onDone) => onDone(),                  // gathering 時点で発動済み → staging では即通過
  })

  // ── 演出セレクタ: 今回 staging で再生する cover を返す ──
  // cupHide は pre_gather_cover で消費済みなので staging では none 扱い。flip / thunder / thunder_v2 を routing。
  const selectStagingEffect = useCallback((): StagingEffect => {
    const r = lastResultRef.current
    if (!r || r.mode === 'none') return 'none'
    const effect = (r.effectId === 'flip' || r.effectId === 'thunder' || r.effectId === 'thunder_v2' || r.effectId === 'fire' || r.effectId === 'slashB')
      ? r.effectId : 'none'
    // 見せ目(decoy)がある場合は必ず演出して final を開示する。none 抽選でも flip に引き上げ。
    if (effect === 'none' && swapIndicesRef.current.length > 0) return 'flip'
    return effect
  }, [])

  // ── cover 後の確定: swap 対象の dieStates を「現在の見た目＝final」に書き戻す ──
  // cover は回転で final 面を上に向けるが displayValue/worldRot は decoy のまま残るため、
  // ここで displayValue=final＋現在姿勢を反映しておく（キープ/アンキープが final 面で表示・操作できる）。
  const commitReveal = useCallback(() => {
    const swap = swapIndicesRef.current
    if (swap.length === 0) return
    const finals = dieStatesRef.current.map(s => s.finalValue)
    const refs = dieRefsRef.current
    dieStatesRef.current = dieStatesRef.current.map(s => {
      if (!swap.includes(s.id)) return s
      const pose = refs[s.id]?.current?.readPose()
      return {
        ...s,
        displayValue: finals[s.id],
        worldPos: pose?.pos ?? s.worldPos,
        worldRot: pose?.rot ?? s.worldRot,
      }
    })
  }, [])

  // ── staging 再生本体: phase=staging → cover 再生 → keep_select に戻す ──
  // （トリガは「プレイヤー/CPU の操作」。抽選自体は集約直後に済んでおり lastResultRef に保持済み）
  const playStaging = useCallback(() => {
    // ヨット成立 → staging テーブル抽選をスキップして光の柱演出を起動
    const finals = dieStatesRef.current.map(s => s.finalValue) as DieValue[]
    const isYacht = finals.length === 5 && finals.every(v => v === finals[0])
    if (isYacht) {
      setPhase('staging')
      bgm.playGrace()
      yachtKeyRef.current += 1
      setYachtActive(true)
      return
    }
    // 通常 staging
    setPhase('staging')
    const effect = selectStagingEffect()
    stagingPlayers.current[effect](() => {
      commitReveal()   // swap 対象を final で確定（キープ/アンキープが final 面に）
      setPhase('keep_select')
      setDieStates([...dieStatesRef.current])
    })
  }, [selectStagingEffect, commitReveal])

  // ── 集約完了 → staging を「装填」して keep_select へ直行（自動再生はしない） ──
  // cover あり（flip/thunder）なら armed=true にし、最初の操作で playStaging される。
  const finishGatherToKeepSelect = useCallback(() => {
    const finals = dieStatesRef.current.map(s => s.finalValue) as DieValue[]
    const isYacht = finals.length === 5 && finals.every(v => v === finals[0])
    // ヨット成立時は必ず staging を装填（テーブル抽選が none でも強制起動）
    const shouldArm = isYacht || selectStagingEffect() !== 'none'
    stagingArmedRef.current = shouldArm
    enterKeepSelect()
    // 観戦側: onStaging が gather 完了前に届いていた場合、ここで消化する
    if (pendingStagingRef.current && shouldArm) {
      pendingStagingRef.current = false
      stagingArmedRef.current = false
      playStaging()
    } else {
      pendingStagingRef.current = false
    }
  }, [selectStagingEffect, enterKeepSelect, playStaging])

  // ── B系統 force-restore: タイムアウト時に対象ダイスを現在位置で finalValue に確定 → keep_select へ ──
  const forceRestoreSlashB = useCallback(() => {
    slashBTimeoutRef.current = null
    const targetId = slashBTargetIdRef.current
    if (targetId !== null) {
      const ci = dieConfigsRef.current.findIndex(c => c.id === targetId)
      const dieRef = dieRefsRef.current[ci]?.current
      const state  = dieStatesRef.current.find(s => s.id === targetId)
      if (dieRef && state?.worldPos) {
        dieRef.gatherTo(state.worldPos)
        dieConfigsRef.current[ci] = { ...dieConfigsRef.current[ci], displayValue: state.finalValue }
        dieRefsRef.current = dieConfigsRef.current.map(c => c.ref)
        dieStatesRef.current = dieStatesRef.current.map(s =>
          s.id === targetId ? { ...s, displayValue: s.finalValue } : s
        )
      }
    }
    enterKeepSelect()
  }, [enterKeepSelect])

  // ── プレイヤー操作トリガ: 装填済みなら staging を起動し true を返す（呼び出し元は元操作を中断） ──
  // 演出後は改めて操作を待つ＝トリガとなった操作は実行しない（書き換えた目を読み直す時間）。
  const maybeTriggerStaging = useCallback((): boolean => {
    if (!stagingArmedRef.current) return false
    stagingArmedRef.current = false   // 消費（同じ集約では2回目以降走らない）
    playStaging()
    netMode?.notifyStaging()   // 相手側でも同時再生
    return true
  }, [playStaging, netMode])

  // ── pre_gather_cover 入り: カップが HOME idle なのを確認 → cupHide 再生 → gathering ──
  // cupHide シーケンスは既存 CupAnim.animate（conceal_going→covering→returning）を流用。
  // カップは空のまま動かす（ラトル不発・中身ダイスなし）。動くカップ×dynamic ダイスの組合せを作らない。
  const enterPreGatherCover = useCallback(() => {
    setPhase('pre_gather_cover')
    const start = () => {
      if (!cupRef.current?.isIdle()) {
        // 通常はここで待たない（着地までに帰還済み）。保険として 50ms 後にリトライ。
        window.setTimeout(start, 50)
        return
      }
      playCupHide(() => {
        commitReveal()   // cupHide の swap（orientTo 後の final 姿勢）を dieStates に確定
        // 集約に合流（cupHide は消費済みなので staging は none＝装填されない → keep_select 直行）
        setPhase('gathering')
        gatherFieldDice()
        setDieStates([...dieStatesRef.current])
        window.setTimeout(() => finishGatherToKeepSelect(), GATHER_MS)
      })
    }
    start()
  }, [playCupHide, gatherFieldDice, finishGatherToKeepSelect, commitReveal])

  const handleSettle = useCallback((
    id:       number,
    worldPos: [number, number, number],
    worldRot: [number, number, number]
  ) => {
    // worldPos/worldRot は常に更新 (アンキープ後の再静止も含む)
    dieStatesRef.current = dieStatesRef.current.map(s =>
      s.id === id ? { ...s, worldPos, worldRot } : s
    )
    // 集約フェーズ到達後のスプリアス呼び出しは無視
    if (diceSettledRef.current) {
      setDieStates([...dieStatesRef.current])
      return
    }
    settleCountRef.current += 1
    if (settleCountRef.current < settleNeededRef.current) return

    // 全数静止 → 集約。ただし 4キープ再振りで cupHide が抽選/強制されているときは、
    // 集約「前」に pre_gather_cover で振った1個に cup を被せてから gathering へ進む。
    diceSettledRef.current = true
    SE.land()
    if (lastResultRef.current?.effectId === 'cupHide') {
      enterPreGatherCover()                  // → 完了内部で gathering → staging へ自動連結
      setDieStates([...dieStatesRef.current])
      return
    }
    // B系統演出が装填されていれば中央集約をスキップ（ダイスは静止したまま）
    // DEBUG トグル OR テーブル抽選で slashB が選ばれた場合に発動
    if (slashBArmedRef.current || lastResultRef.current?.effectId === 'slashB') {
      slashBArmedRef.current = false
      setPhase('gathering')

      // B系統 force-restore タイムアウトを起動（zigzag 完了 or onDone で clearTimeout）
      if (slashBTimeoutRef.current) clearTimeout(slashBTimeoutRef.current)
      slashBTimeoutRef.current = setTimeout(forceRestoreSlashB, SLASH_B_TIMEOUT_MS)

      // zangeki.wav 再生 + SlashEffect マウント（ジグザグ移動と同期）
      playZangekiSE()
      slashKeyRef.current += 1
      setSlashActive(true)

      // 対象ダイスを決定: displayValue≠finalValue の非キープダイス、なければランダムな非キープ
      const states = dieStatesRef.current
      const candidates = states.filter(s => s.location === 'field')
      const diffDie = candidates.find(s => s.displayValue !== s.finalValue)
      const targetDie = diffDie ?? candidates[Math.floor(Math.random() * candidates.length)]
      slashBTargetIdRef.current = targetDie?.id ?? null

      // 対象ダイス以外は通常通り集約（スロットをシャッフルして各ダイスに割り当て）
      const nonTargets = candidates.filter(s => s.id !== slashBTargetIdRef.current)
      const slotIdxs = [0, 1, 2, 3, 4]
      for (let i = slotIdxs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[slotIdxs[i], slotIdxs[j]] = [slotIdxs[j], slotIdxs[i]]
      }
      nonTargets.forEach((s, k) => {
        const [cx, cz] = GATHER_CENTERS[slotIdxs[k % 5]]
        const ang = Math.random() * Math.PI * 2
        const rr  = Math.sqrt(Math.random()) * GATHER_RADIUS
        const gatherTarget: [number, number, number] = [cx + Math.cos(ang) * rr, GATHER_Y, cz + Math.sin(ang) * rr]
        const cfgIdx = dieConfigsRef.current.findIndex(c => c.id === s.id)
        dieRefsRef.current[cfgIdx]?.current?.gatherTo(gatherTarget)
        dieStatesRef.current = dieStatesRef.current.map(ds =>
          ds.id === s.id ? { ...ds, worldPos: gatherTarget } : ds
        )
      })

      // 対象ダイスをジグザグ移動させて集約スロットへ着地
      if (targetDie) {
        const cfgIdx = dieConfigsRef.current.findIndex(c => c.id === targetDie.id)
        const dieRef = dieRefsRef.current[cfgIdx]?.current
        const pose   = dieRef?.readPose()
        if (dieRef && pose) {
          // 集約先スロットを決定（非対象が使っていないスロットから1つ）
          const usedSlots = nonTargets.length
          const targetSlotIdx = slotIdxs[usedSlots % 5]
          const [cx, cz] = GATHER_CENTERS[targetSlotIdx]
          const ang = Math.random() * Math.PI * 2
          const rr  = Math.sqrt(Math.random()) * GATHER_RADIUS
          const goalPos: [number, number, number] = [cx + Math.cos(ang) * rr, GATHER_Y, cz + Math.sin(ang) * rr]
          dieStatesRef.current = dieStatesRef.current.map(ds =>
            ds.id === targetDie.id ? { ...ds, worldPos: goalPos } : ds
          )

          const waypoints = generateZigzagWaypoints(pose.pos, goalPos)
          const pts: [number, number, number][] = [pose.pos, ...waypoints]

          dieRef.zigzagTo(pts, targetDie.finalValue, () => {
            // timeout クリア（正常完了）
            if (slashBTimeoutRef.current) { clearTimeout(slashBTimeoutRef.current); slashBTimeoutRef.current = null }
            // B-4: displayValue を finalValue に同期（物理回転は zigzag の z.toQuat で確定済み。orientTo 不可）
            const ci = dieConfigsRef.current.findIndex(c => c.id === slashBTargetIdRef.current)
            if (ci >= 0) {
              dieConfigsRef.current[ci] = { ...dieConfigsRef.current[ci], displayValue: targetDie.finalValue }
              dieRefsRef.current = dieConfigsRef.current.map(c => c.ref)
            }
            dieStatesRef.current = dieStatesRef.current.map(s =>
              s.id === slashBTargetIdRef.current ? { ...s, displayValue: s.finalValue } : s
            )
            // B系統: staging を装填せずに直接 keep_select へ
            enterKeepSelect()
          }, SLASH_SEG_STARTS)
        } else {
          window.setTimeout(() => finishGatherToKeepSelect(), GATHER_MS)
        }
      } else {
        window.setTimeout(() => finishGatherToKeepSelect(), GATHER_MS)
      }

      setDieStates([...dieStatesRef.current])
      return
    }
    setPhase('gathering')
    gatherFieldDice()
    setDieStates([...dieStatesRef.current])
    window.setTimeout(() => finishGatherToKeepSelect(), GATHER_MS)
  }, [gatherFieldDice, finishGatherToKeepSelect, enterPreGatherCover, forceRestoreSlashB])

  // ── キープ: field → kept ─────────────────────────
  const handleKeep = useCallback((id: number) => {
    if (phase !== 'keep_select' || turn !== 'player') return
    if (netMode && !netMode.isMyTurn()) return
    if (maybeTriggerStaging()) return   // 最初の操作なら staging を再生（このキープは保留）
    const s = dieStatesRef.current.find(ds => ds.id === id)
    if (!s || s.location !== 'field') return
    // キープスロットが埋まっている場合は何もしない
    const keptCount = dieStatesRef.current.filter(ds => ds.location === 'kept').length
    if (keptCount >= KEEP_SLOTS.length) return
    const order = keepCounterRef.current++
    dieStatesRef.current = dieStatesRef.current.map(ds =>
      ds.id === id ? { ...ds, location: 'kept' as const, keepOrder: order } : ds
    )
    setDieStates([...dieStatesRef.current])
    SE.keep()
    // ネットモード: キープ変化を送信
    const keptIds = dieStatesRef.current.filter(s => s.location === 'kept').map(s => s.id)
    if (netMode?.role === 'host') netMode.notifyKeep(keptIds)
    else netMode?.requestKeep(id, true)
  }, [phase, turn, maybeTriggerStaging, netMode])

  // ── アンキープ: kept → field ─────────────────────
  const handleUnkeep = useCallback((id: number) => {
    if (phase !== 'keep_select' || turn !== 'player') return
    if (netMode && !netMode.isMyTurn()) return
    if (maybeTriggerStaging()) return   // 最初の操作なら staging を再生（この解除は保留）
    const s = dieStatesRef.current.find(ds => ds.id === id)
    if (!s || s.location !== 'kept') return
    const newMountKey = s.mountKey + 1
    dieStatesRef.current = dieStatesRef.current.map(ds =>
      ds.id === id
        ? { ...ds, location: 'field' as const, keepOrder: -1, mountKey: newMountKey }
        : ds
    )
    setDieStates([...dieStatesRef.current])
    SE.unkeep()
    // ネットモード: アンキープ変化を送信
    const keptIdsAfterUnkeep = dieStatesRef.current.filter(s => s.location === 'kept').map(s => s.id)
    if (netMode?.role === 'host') netMode.notifyKeep(keptIdsAfterUnkeep)
    else netMode?.requestKeep(id, false)
    // 着地音（kinematic 降下なので物理イベントが出ない→直接鳴らす）。
    window.setTimeout(() => playDiceHit('land', 0.5), 200)
    // フィールドへ戻す: 元位置の少し上から kinematic で降ろす。kinematicSpawn は即 settled=true なので
    // 物理静止を待たずに「戻った瞬間からクリック可」。出目=displayValue（commitReveal 済なら final）保持。
    if (s.worldPos && s.worldRot) {
      const newConfig = makeDieConfig(
        id, s.displayValue,
        {
          initRot:        s.worldRot,
          pos:            [s.worldPos[0], s.worldPos[1] + 0.6, s.worldPos[2]],
          kinematicSpawn: true,
          gatherTarget:   [s.worldPos[0], s.worldPos[1], s.worldPos[2]],
        },
        undefined,
        newMountKey,
      )
      dieConfigsRef.current = dieConfigsRef.current.map(c => c.id === id ? newConfig : c)
      dieRefsRef.current    = dieConfigsRef.current.map(c => c.ref)
      setDieConfigs([...dieConfigsRef.current])
    }
  }, [phase, turn, maybeTriggerStaging])

  // ── スコア記入 (プレイヤー) ──────────────────────
  const handleRecord = useCallback((cat: Category) => {
    if (netMode && !netMode.isMyTurn()) return
    if (maybeTriggerStaging()) return   // 最終投目の最初の操作なら staging を先に再生（記入は保留）
    const finals   = dieStatesRef.current.map(s => s.finalValue)
    const fakeDice = finals.map((value, id) => ({ id, value, kept: false }))
    const pts      = calcCategoryScore(cat, fakeDice)
    SE.record()

    roundNoRef.current += 1
    gameLogRef.current.push({ type: 'record', turn: 'player', roundNo: roundNoRef.current, category: cat, points: pts })
    setPlayerSheet(prev => {
      const next = { ...prev, [cat]: pts }
      setCpuSheet(cSheet => {
        if (checkGameOver(next, cSheet)) setTimeout(() => setGameOver(true), 100)
        return cSheet
      })
      return next
    })

    // 記入確定の瞬間に全ダイスを即カップへ収める（ワープ＝即時クリア）→ 相手ターンへ
    resetForNextTurn()
    if (netMode) {
      // ネットモード: 記入通知。ターン切り替えは onTurnChange で受ける
      if (netMode.role === 'host') {
        setPlayerSheet(prev => {
          const next = { ...prev, [cat]: pts }
          setCpuSheet(cSheet => {
            netMode.notifyRecord(cat, pts, next, cSheet)
            if (checkGameOver(next, cSheet)) {
              netMode.notifyGameOver(calcTotalScore(next), calcTotalScore(cSheet))
              setTimeout(() => setGameOver(true), 100)
            }
            return cSheet
          })
          return next
        })
      } else {
        netMode.requestRecord(cat)
      }
    } else {
      setTurn('cpu')
    }
  }, [maybeTriggerStaging, netMode])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── ターンリセット ─────────────────────────────────
  const resetForNextTurn = useCallback(() => {
    setPhase('idle')
    setRollsLeft(3)
    setDieStates([])
    setDieConfigs([])
    setLastResult(undefined)
    dieStatesRef.current   = []
    dieConfigsRef.current  = []
    keepCounterRef.current = 0
    diceSettledRef.current = false
    stagingArmedRef.current = false
    pendingStagingRef.current = false
    setCpuThinking(false)
    setLastCpuCat(null)
  }, [])

  // ── ネットモード サブスクリプション ──────────────────
  useEffect(() => {
    if (!netMode) return
    const unsubs: (() => void)[] = []

    // ターン切り替え受信
    unsubs.push(netMode.onTurnChange(isMyTurn => {
      if (isMyTurn) {
        resetForNextTurn()
        setTurn('player')
      } else {
        resetForNextTurn()
        setTurn('cpu')   // cpu = 相手ターン（CPU ロジックは netMode で上書き）
      }
    }))

    // ロール結果受信
    unsubs.push(netMode.onRollResult(r => {
      const finals = r.finals as import('../game/types').DieValue[]
      // ロール結果受信時は必ずフィールドのダイスをクリア（再振り時に旧ダイスが残るのを防ぐ）
      dieConfigsRef.current = []
      setDieConfigs([])
      // ホストが決定した表示値・演出IDを inject として受け取る（自/観戦ともに共通）
      const inject: { displayValues: DieValue[]; effectId: CoverId; effectVariant: EffectMode } = {
        displayValues: r.displayValues as DieValue[],
        effectId:      r.effectId as CoverId,
        effectVariant: r.effectVariant as EffectMode,
      }
      if (r.keptIds.length === 0) {
        // 1投目: inject を渡してローカル抽選をスキップ
        preparePendingRoll(finals, 'auto', 'auto', inject)
        // triggerAutoRoll は preparePendingRoll 内の netMode ガードで発火済み
        // 観戦側（相手ターン）の場合は重複呼び出しを避けるため何もしない
      } else {
        // 再振り: finals + effectId を注入してから handleReRoll
        // skipNotify=true: hostProcessGuestRoll が既にゲストへ roll_result を送信済みのため二重送信を防ぐ
        if (lastResultRef.current) {
          lastResultRef.current = { ...lastResultRef.current, finalValues: finals, displayValues: finals }
        }
        handleReRoll(false, true)
        // handleReRoll が lastResultRef を上書きするので、その後に inject の effectId を反映
        if (lastResultRef.current) {
          lastResultRef.current = { ...lastResultRef.current, effectId: inject.effectId, mode: inject.effectVariant }
        }
        // handleReRoll はローカル抽選で swapIndices を決めるが、ホスト送信の displayValues から正しく再計算する
        if (pendingSpawnRef.current) {
          const hostDisplays = inject.displayValues
          pendingSpawnRef.current = {
            ...pendingSpawnRef.current,
            swapIndices: finals.map((f, i) => hostDisplays[i] !== f ? i : -1).filter(i => i >= 0),
          }
        }
        // 観戦側は onCupThrown 受信時に triggerAutoRoll するため、ここでは何もしない
      }
    }))

    // キープ更新受信: ダイスの location を更新（再振り時に正しいダイスを振り直すため）
    unsubs.push(netMode.onKeepUpdate(keptIds => {
      if (netMode.isMyTurn()) return   // 自ターンはローカルで既に処理済み
      const prev = dieStatesRef.current
      dieStatesRef.current = prev.map(s => {
        const nowKept = keptIds.includes(s.id)
        const wasKept = s.location === 'kept'
        return { ...s, location: nowKept ? 'kept' as const : 'field' as const,
          // アンキープ時: mountKey を上げて FieldDie を強制リマウント（古い物理 config が使われないよう）
          mountKey: (!nowKept && wasKept) ? s.mountKey + 1 : s.mountKey,
        }
      })
      setDieStates([...dieStatesRef.current])

      // アンキープされたダイスのconfig を kinematicSpawn に差し替え（物理投入を防ぐ）
      const unkeepedIds = prev
        .filter(s => s.location === 'kept' && !keptIds.includes(s.id))
        .map(s => s.id)
      if (unkeepedIds.length > 0) {
        dieConfigsRef.current = dieConfigsRef.current.map(c => {
          if (!unkeepedIds.includes(c.id)) return c
          const s = dieStatesRef.current.find(x => x.id === c.id)
          const wp = s?.worldPos ?? [0, GATHER_Y, 0] as [number, number, number]
          return makeDieConfig(
            c.id, c.displayValue,
            { initRot: s?.worldRot ?? undefined,
              pos: [wp[0], wp[1] + 0.6, wp[2]],
              kinematicSpawn: true,
              gatherTarget: wp,
            },
            undefined, s?.mountKey ?? c.mountKey,
          )
        })
        dieRefsRef.current = dieConfigsRef.current.map(c => c.ref)
        setDieConfigs([...dieConfigsRef.current])
      }
    }))

    // スコア記入受信
    unsubs.push(netMode.onScoreUpdate((_by, _cat, _pts, mySheet, oppSheet) => {
      setPlayerSheet({ ...mySheet })
      setCpuSheet({ ...oppSheet })
    }))

    // ゲーム終了受信
    unsubs.push(netMode.onGameOver((_my, _opp, _winner) => {
      setGameOver(true)
    }))

    // ホストがゲームリセットしたときゲスト側で自動リセット
    unsubs.push(netMode.onGameReset(() => {
      handleGameReset(true)
    }))

    return () => unsubs.forEach(u => u())
  }, [netMode, resetForNextTurn, preparePendingRoll, handleGameReset])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── ゲームリセット ──────────────────────────────
  const downloadLog = useCallback(() => {
    const effectCounts: Record<string, number> = {}
    gameLogRef.current.filter(e => e.type === 'roll').forEach(e => {
      const eid = (e as Extract<typeof e, { type: 'roll' }>).effectId
      effectCounts[eid] = (effectCounts[eid] ?? 0) + 1
    })
    const data = {
      startedAt: gameStartedAtRef.current,
      endedAt:   new Date().toISOString(),
      entries:   gameLogRef.current,
      summary: {
        playerTotal: calcTotalScore(playerSheet),
        cpuTotal:    calcTotalScore(cpuSheet),
        winner:      calcTotalScore(playerSheet) > calcTotalScore(cpuSheet) ? 'player' :
                     calcTotalScore(playerSheet) < calcTotalScore(cpuSheet) ? 'cpu' : 'draw',
        playerSheet,
        cpuSheet,
        effectCounts,
      },
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `yacht-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [playerSheet, cpuSheet])

  const handleGameReset = useCallback((fromNet = false) => {
    setPlayerSheet({ ...EMPTY_SHEET })
    setCpuSheet({ ...EMPTY_SHEET })
    setGameOver(false)
    resetForNextTurn()
    bgm.stopAll(); bgm.playDefault()   // リセット時に BGM を停止→デフォルト再開
    setYachtActive(false)
    onDark(0); onFlash(0)
    gameLogRef.current     = []
    gameStartedAtRef.current = new Date().toISOString()
    rollNoRef.current      = 0
    roundNoRef.current     = 0

    if (netMode) {
      if (netMode.role === 'host' && !fromNet) {
        // ホストがボタンを押した → ネット状態リセット＋ゲストへ通知
        netMode.notifyGameReset()
        setTurn('player')   // ホスト先攻
      } else {
        // ゲストがボタンを押した、またはホストのリセット通知を受けた側
        setTurn('cpu')   // 相手（ホスト）のターンを待機
      }
    } else {
      setTurn('player')
    }
  }, [resetForNextTurn, netMode])

  // ── ネット対戦: 相手からの staging シグナルを受信したとき演出を再生 ──
  useEffect(() => {
    if (!netMode) return
    return netMode.onStaging(() => {
      if (!stagingArmedRef.current) {
        // gather がまだ完了していない（armedが立っていない）→ キューに積んで gather 完了時に消化
        pendingStagingRef.current = true
        return
      }
      stagingArmedRef.current = false
      playStaging()
    })
  }, [netMode, playStaging])

  // ── ネット対戦: 相手がカップを投入/解放した瞬間に観戦側カップを連動させる ──
  useEffect(() => {
    if (!netMode) return
    const u1 = netMode.onCupThrown(() => {
      cupRef.current?.triggerSyncRoll()   // autoRoll=false で開始。releaseThrow() 待ち
    })
    const u2 = netMode.onCupReleased(() => {
      cupRef.current?.releaseThrow()      // アクティブ側の pointerup に合わせて解放
    })
    return () => { u1(); u2() }
  }, [netMode])

  // ── CPU 自動進行 ─────────────────────────────────
  useEffect(() => {
    if (netMode) return           // ネットモード時は CPU AI を無効化
    if (turn !== 'cpu' || gameOver) return

    if (phase === 'idle') {
      setCpuThinking(true)
      const t = setTimeout(() => {
        const finals = randomFinals()
        preparePendingRoll(finals, 'auto')   // CPUは通常プレイ＝staging で確率抽選
        cupRef.current?.triggerAutoRoll()
      }, 1200)
      return () => clearTimeout(t)
    }

    // CPU も「集約後の最初の操作で staging」に乗せる：読む時間を置いて自動トリガ。
    // staging 再生→keep_select に戻ると armed=false になり、下の通常ロジックが走る。
    if (phase === 'keep_select' && stagingArmedRef.current) {
      const t = setTimeout(() => {
        stagingArmedRef.current = false
        playStaging()
      }, CPU_READ_MS)
      return () => clearTimeout(t)
    }

    if (phase === 'keep_select' && rollsLeft > 0) {
      const t = setTimeout(() => {
        const vals  = dieStatesRef.current.map(s => s.finalValue)
        const flags = cpuKeepDice(vals)
        // キープフラグを location に反映
        let cpuKeepOrder = 0
        dieStatesRef.current = dieStatesRef.current.map((s, i) => ({
          ...s,
          location:  flags[i] ? ('kept' as const) : ('field' as const),
          keepOrder: flags[i] ? cpuKeepOrder++ : -1,
        }))
        setDieStates([...dieStatesRef.current])
        // 全キープ（振り直す対象なし）→ 再振りせずスコア記入へ直行
        const fieldCount = flags.filter(f => !f).length
        if (fieldCount === 0) {
          setRollsLeft(0)
          return
        }
        setTimeout(() => {
          handleReRoll(true)   // 非キープを飛び込ませてから自動で振る
        }, 600)
      }, 1000)
      return () => clearTimeout(t)
    }

    if (phase === 'keep_select' && rollsLeft === 0) {
      const t = setTimeout(() => {
        const vals     = dieStatesRef.current.map(s => s.finalValue)
        const cat      = cpuChooseCategory(vals, cpuSheet)
        const fakeDice = vals.map((value, id) => ({ id, value, kept: false }))
        const pts      = calcCategoryScore(cat, fakeDice)
        SE.record()
        roundNoRef.current += 1
        gameLogRef.current.push({ type: 'record', turn: 'cpu', roundNo: roundNoRef.current, category: cat, points: pts })

        setCpuSheet(prev => {
          const next = { ...prev, [cat]: pts }
          setPlayerSheet(pSheet => {
            if (checkGameOver(pSheet, next)) setTimeout(() => setGameOver(true), 100)
            return pSheet
          })
          return next
        })

        setLastCpuCat(`${cat} → ${pts}点`)
        // 全ダイスを即カップへ収める（ワープ＝即時クリア）→ プレイヤーへ
        resetForNextTurn()
        setTurn('player')
      }, 1400)
      return () => clearTimeout(t)
    }
  }, [turn, phase, rollsLeft, gameOver, cpuSheet, preparePendingRoll, handleReRoll, resetForNextTurn, playStaging])

  // ── 派生値 ───────────────────────────────────────
  // gathering(集約移動中) / staging(演出中) は操作不可
  const isDisabled = phase === 'rolling' || phase === 'pre_gather_cover' || phase === 'gathering' || phase === 'staging'
  const canRecord  = phase === 'keep_select' && rollsLeft === 0 && turn === 'player'
  const allFinals  = dieStatesRef.current.map(s => s.finalValue) as DieValue[]

  const pFilled = Object.values(playerSheet).filter(v => v !== null).length
  const cFilled = Object.values(cpuSheet).filter(v => v !== null).length
  const turnNo  = pFilled + cFilled + 1

  // キープ欄表示用: keepOrder 順にソート
  const keptStates = [...dieStates]
    .filter(s => s.location === 'kept')
    .sort((a, b) => a.keepOrder - b.keepOrder)

  // スコアシートのプレビュー参照値：
  //   keep_select かつ staging 未消費（cover 再生前）＝「偽の盤面を読ませる」間は display（見せ札）を使う。
  //   staging 消費後／その他は final（本物）。記入処理は常に final を使う（ここは表示プレビューのみ）。
  const currentFinals = phase === 'keep_select'
    ? (stagingArmedRef.current
        ? (dieStates.map(s => s.displayValue) as DieValue[])   // 演出前：盤面の偽の目と一致
        : (dieStates.map(s => s.finalValue)   as DieValue[]))  // 演出後：本物の目と一致
    : null

  return (
    <div
      style={{ width: '100vw', height: '100vh', background: '#180f07' }}
      onPointerDown={() => { resumeAudio(); bgm.resumeBgm() }}
    >
      <Canvas shadows camera={{ position: [0, 18, 6], fov: 52 }} gl={{ antialias: true }}>
        {/* 影が右上に伸びるよう光源を -x 側へ。ambient を上げて影を少し薄く */}
        <ambientLight intensity={0.68} />
        <directionalLight
          position={[-4, 12, 6]} intensity={1.12} castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-14} shadow-camera-right={14}
          shadow-camera-top={10}   shadow-camera-bottom={-18}
        />
        <pointLight position={[-8, 6, 0]} intensity={0.55} color="#fff8f0" />

        {/* 背景の床（ダークウォルナット）。物理なし・見た目のみ */}
        <WoodFloor />

        <Physics gravity={[0, -20, 0]}>
          <Floor />
          <Walls />
          <CupAnim ref={cupRef} onSpawn={handleCupSpawn}
            onThrowStart={netMode ? () => netMode.notifyCupThrown() : undefined}
            onThrowRelease={netMode ? () => netMode.notifyCupReleased() : undefined}
          />
          <FractureSystem ref={fractureRef} />   {/* 雷v2 の欠片プール（32個常設・退避） */}
          {/* 斬撃割れ用・半割れ破片2個常設 */}
          <SlashDieEffect
            ref={slashDieRef}
            onHide={(id) => { dieRefsRef.current[id]?.current?.setHidden(true) }}
          />

          {/* 雷ビジュアル A1: 発火点の稲妻ジグザグ＋着弾フラッシュ（key で発火ごとに再生成） */}
          {thunderStrike && (
            <ThunderStrikeFx key={thunderStrike.key} x={thunderStrike.x} z={thunderStrike.z} power={thunderStrike.power} />
          )}
          {/* 炎 cover（局所スプライト・物理なし） */}
          {fireFx && (
            <FireFx key={fireFx.key} x={fireFx.x} y={fireFx.y} z={fireFx.z}
              onPhase={fireFx.onPhase} onCover={fireFx.onCover} onDone={fireFx.onDone} />
          )}
          {/* Yacht 光の柱演出（staging テーブル外・ヨット成立時のみ） */}
          {yachtActive && (
            <YachtEffect
              key={yachtKeyRef.current}
              onDark={onDark}
              onFlash={onFlash}
              onCover={() => {
                // ヨット演出: 白フラッシュで隠れている間に全ダイスを finalValue へ向ける
                const refs = dieRefsRef.current
                dieStatesRef.current = dieStatesRef.current.map(s => {
                  refs[s.id]?.current?.orientTo(s.finalValue)
                  return { ...s, displayValue: s.finalValue }
                })
              }}
              onDone={() => {
                setYachtActive(false)
                setPhase('keep_select')
                setDieStates([...dieStatesRef.current])
              }}
            />
          )}

          {/* 斬撃エフェクト（DEBUG 試聴・将来 staging 連携） */}
          {slashActive && (
            <SlashEffect
              key={slashKeyRef.current}
              onDone={() => setSlashActive(false)}
              getDiePos={() => {
                const targetId = slashBTargetIdRef.current
                if (targetId == null) return [0, 0.5, 0]
                const cfgIdx = dieConfigsRef.current.findIndex(c => c.id === targetId)
                return dieRefsRef.current[cfgIdx]?.current?.readPose()?.pos ?? [0, 0.5, 0]
              }}
            />
          )}

          {/* ── キープ済みダイス (浮遊＋オーラ。空き枠は無し) ── */}
          {keptStates.map((s, slotIndex) =>
            s.worldRot ? (
              <KeepDie
                key={`kept-${s.id}`}
                displayValue={s.displayValue}
                worldRot={s.worldRot}
                slotPos={KEEP_SLOTS[slotIndex]}
                fromPos={s.worldPos ?? KEEP_SLOTS[slotIndex]}
                canUnkeep={phase === 'keep_select' && turn === 'player'}
                onUnkeep={() => handleUnkeep(s.id)}
                auraColor="#ffffff"
                bobOffset={slotIndex * 1.3}
              />
            ) : null
          )}

          {/* ── フィールドのダイス (FieldDie) ── */}
          {dieConfigs.map(cfg => {
            const state = dieStates.find(s => s.id === cfg.id)
            if (!state || state.location === 'kept') return null
            return (
              <FieldDie
                key={`die-${rollKey}-${cfg.id}-${cfg.mountKey}`}
                ref={cfg.ref}
                id={cfg.id}
                displayValue={cfg.displayValue}
                initRot={cfg.initRot}
                kept={false}
                launchPos={cfg.launchPos}
                launchImpulse={cfg.launchImpulse}
                launchTorque={cfg.launchTorque}
                kinematicSpawn={cfg.kinematicSpawn}
                gatherTarget={cfg.gatherTarget}
                onSettle={handleSettle}
                onToggleKeep={handleKeep}
              />
            )
          })}
        </Physics>

      </Canvas>

      {/* 暗転オーバーレイ（黒・Yacht 演出 0〜13s） */}
      <div ref={darkOverlayRef}  style={{ position: 'absolute', inset: 0, background: 'black', opacity: 0, pointerEvents: 'none', zIndex: 10 }} />
      {/* 白フラッシュオーバーレイ（Yacht 演出 8〜18s。白ピーク時に onCover で finalValue 書き換え） */}
      <div ref={flashOverlayRef} style={{ position: 'absolute', inset: 0, background: 'white', opacity: 0, pointerEvents: 'none', zIndex: 11 }} />

      {/* ── スコアシート ── */}
      <ScoreSheet
        playerSheet={playerSheet}
        cpuSheet={cpuSheet}
        currentFinals={turn === 'player' ? currentFinals : null}
        canRecord={canRecord}
        onRecord={handleRecord}
        turn={turn}
        cpuThinking={
          cpuThinking &&
          (phase === 'rolling' || phase === 'pre_gather_cover' || phase === 'gathering' || phase === 'staging' ||
           phase === 'idle'    || phase === 'cup_ready')
        }
        playerLabel={netMode ? (netMode.role === 'host' ? '1P' : '2P') : undefined}
        cpuLabel={netMode ? (netMode.role === 'host' ? '2P' : '1P') : undefined}
        swapColumns={netMode?.role === 'guest'}
      />

      {/* ── 振るボタンパネル（dev環境のみ表示） ── */}
      {import.meta.env.DEV && <div style={{
        position: 'absolute', top: 60, left: 262,
        display: 'flex', flexDirection: 'column', gap: 6,
        background: 'rgba(0,0,0,0.72)', borderRadius: 8,
        padding: '10px 12px', minWidth: 180,
        fontFamily: 'monospace', fontSize: 11, color: '#ccc',
        pointerEvents: 'none',
      }}>
        {/* 現在のダイス値表示（常時） */}
        {lastResult && (
          <div style={{ fontSize: 10, lineHeight: 1.6, borderBottom: '1px solid #444', paddingBottom: 6, marginBottom: 2 }}>
            <div style={{ color: '#888' }}>見せ値: <span style={{ color: '#ffa' }}>{lastResult.displayValues.join(' ')}</span></div>
            <div style={{ color: '#888' }}>内部値: <span style={{ color: '#aff' }}>{lastResult.finalValues.join(' ')}</span></div>
            <div style={{ color: '#888' }}>演出: <span style={{ color: '#fca' }}>{lastResult.effectId}</span> / <span style={{ color: '#caf' }}>{lastResult.mode}</span></div>
          </div>
        )}
        {/* 振るボタン群（自分のターン・idle時のみ操作可） */}
        {phase === 'idle' && (turn === 'player' || (netMode && netMode.isMyTurn())) && (
          <>
            <div style={{ fontSize: 10, color: '#888' }}>振る（1投目）</div>
            {([
              { label: '🎲 乱数',                        finals: null,                         cover: 'auto'     },
              { label: '4,4,4,1,1',                      finals: [4,4,4,1,1] as DieValue[],    cover: 'auto'     },
              { label: '5,5,5,5,5 (ヨット)',             finals: [5,5,5,5,5] as DieValue[],    cover: 'auto'     },
              { label: '1,2,3,4,5 (Bスト)',              finals: [1,2,3,4,5] as DieValue[],    cover: 'auto'     },
              { label: '1,1,1,1,2 (4ダイス)',            finals: [1,1,1,1,2] as DieValue[],    cover: 'auto'     },
              { label: '3,3,3,2,2 (フルハウス)',         finals: [3,3,3,2,2] as DieValue[],    cover: 'auto'     },
              { label: '🎩 4,4,4,4,1 → カップ隠し強制', finals: [4,4,4,4,1] as DieValue[],    cover: 'cupHide'  },
            ] as { label: string; finals: DieValue[] | null; cover: CoverForce }[]).map(({ label, finals, cover }) => (
              <button
                key={label}
                style={{
                  background: cover === 'cupHide' ? '#3a1a5a' : '#1a3a5a',
                  color: '#eee',
                  border: `1px solid ${cover === 'cupHide' ? '#8a4a9a' : '#3a6a9a'}`,
                  borderRadius: 5, padding: '4px 8px', cursor: 'pointer', fontSize: 10,
                  pointerEvents: 'all',
                }}
                onClick={() => {
                  if (netMode?.role === 'guest') {
                    netMode.requestRoll()
                  } else {
                    const f = finals ?? randomFinals()
                    preparePendingRoll(f, 'auto', cover)
                  }
                }}
              >
                {label}
              </button>
            ))}
          </>
        )}
      </div>}

      {/* ── ターン表示 (中央上) ── */}
      <div style={{
        position: 'absolute', top: 10,
        left: '50%', transform: 'translateX(-50%)',
        color: '#c8b48a', fontFamily: 'monospace', fontSize: 11,
        background: 'rgba(0,0,0,0.55)', padding: '4px 14px',
        borderRadius: 12, textAlign: 'center',
      }}>
        ターン {Math.min(turnNo, 26)} / 26
        {lastCpuCat && turn === 'player' && (
          <span style={{ marginLeft: 12, color: '#7af', fontSize: 10 }}>
            CPU: {lastCpuCat}
          </span>
        )}
      </div>

      {/* ── デバッグパネル（dev環境のみ表示） ── */}
      {import.meta.env.DEV && <DebugPanel
        disabled={isDisabled || phase !== 'idle' || turn !== 'player'}
        result={lastResult}
        onRoll={netMode?.role === 'guest'
          ? (_finals, _mode) => { netMode.requestRoll() }
          : preparePendingRoll}
        rollsLeft={rollsLeft}
        phase={phase}
        onSlashTest={() => {
          playZangekiSE()
          slashKeyRef.current += 1
          setSlashActive(true)
        }}
        onSlashDieTest={() => {
          const dieRef = dieRefsRef.current[0]?.current
          if (!dieRef) return
          const pose = dieRef.readPose()
          if (!pose) return
          const pos      = new Vector3(...pose.pos)
          const finalVal = dieStatesRef.current.find(s => s.id === 0)?.finalValue ?? 6
          const origVal  = dieStatesRef.current.find(s => s.id === 0)?.displayValue ?? finalVal
          const isSuccess = slashDieMode === 'success'
          const pattern   = selectSlashPattern(isSuccess)
          // 破片を待機位置に準備（ダイスはまだ見えたまま）
          slashDieRef.current?.activate(pos, 0, pose.rot)
          // 4打点目（1.37s）で割れる
          setTimeout(() => {
            slashDieRef.current?.triggerFall(45)
          }, 1370)
          // 2s 静止後に assemble 開始
          setTimeout(() => {
            slashDieRef.current?.assemble(pattern, finalVal, () => {
              // onAssembled: 元ダイスを正しい向きで再表示
              const orientVal = isSuccess ? finalVal : origVal
              dieRef.orientTo(orientVal)
              dieRef.setHidden(false)
              dieStatesRef.current = dieStatesRef.current.map(s =>
                s.id === 0 ? { ...s, displayValue: orientVal } : s
              )
              setDieStates([...dieStatesRef.current])
              // successA のみ flip を続けて起動
              if (pattern === 'successA') {
                playFlipSE()
                dieRef.flip(finalVal, () => {})
              }
            })
          }, 1370 + 2000)
        }}
        slashDieMode={slashDieMode}
        onSlashDieModeChange={setSlashDieMode}
        slashBArmed={slashBArmedUI}
        onSlashBArmedChange={(v) => {
          slashBArmedRef.current = v
          setSlashBArmedUI(v)
        }}
      />}

      {/* ── ターンチェンジバナー（ターン開始・未投入のときだけ中央表示） ── */}
      {turn === 'player' && phase === 'idle' && rollsLeft === 3 && !gameOver && (
        <div style={{
          position: 'absolute',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
          animation: 'turnBannerIn 0.4s ease-out',
        }}>
          <div style={{
            background: 'rgba(0,0,0,0.55)',
            border: '2px solid rgba(212,180,131,0.6)',
            borderRadius: 12,
            padding: '14px 32px',
            color: '#f0d9a8',
            fontFamily: 'serif',
            fontSize: 22,
            fontWeight: 'bold',
            letterSpacing: 3,
            textShadow: '0 0 12px rgba(255,220,120,0.8)',
            whiteSpace: 'nowrap',
          }}>
            🎲 あなたのターンです
          </div>
        </div>
      )}

      {/* ── メインUI ── */}
      <div style={{
        position: 'absolute', bottom: 24,
        left: '50%', transform: 'translateX(-50%)',
        color: '#d4b483', fontFamily: 'sans-serif',
        fontSize: 13, textAlign: 'center',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      }}>
        {turn === 'cpu' && (
          <span style={{ opacity: 0.7, fontSize: 12 }}>
            {phase === 'idle'        ? (netMode ? '⏳ 相手のターンです...' : '⏳ CPU が考えています...') :
             phase === 'cup_ready'   ? '🎲 振っています...' :
             phase === 'rolling'     ? '🎲 振っています...' :
             phase === 'pre_gather_cover' ? '✨ カップが被せています...' :
             phase === 'gathering'   ? '✨ まとめています...' :
             phase === 'staging'     ? '✨ 演出中...' :
             phase === 'keep_select' ? (netMode ? '⏳ 相手が選んでいます...' : '⏳ CPU が選んでいます...') : ''}
          </span>
        )}

        {turn === 'player' && (
          <>
            {phase === 'idle' && (
              <button
                style={{
                  background: '#2a5a2a', color: '#fff',
                  border: '2px solid #4a9a4a', borderRadius: 8,
                  padding: '10px 32px', cursor: 'pointer',
                  fontFamily: 'sans-serif', fontSize: 16, fontWeight: 'bold',
                }}
                onClick={() => {
                  SE.button()
                  if (netMode?.role === 'guest') netMode.requestRoll()
                  else preparePendingRoll(randomFinals(), 'auto', 'auto')
                }}
              >
                🎲 振る
              </button>
            )}
            {import.meta.env.DEV && phase === 'rolling' && (
              <span style={{ opacity: 0.6 }}>サイコロが転がり中...</span>
            )}
            {phase === 'cup_ready' && (
              <span style={{ color: '#ffd700', fontSize: 13 }}>
                カップをホールドして振る！
              </span>
            )}
            {import.meta.env.DEV && phase === 'pre_gather_cover' && (
              <span>✨ カップが被せています...</span>
            )}
            {import.meta.env.DEV && phase === 'gathering' && (
              <span>✨ ダイスをまとめています...</span>
            )}
            {import.meta.env.DEV && phase === 'staging' && (
              <span>✨ カップ演出中...</span>
            )}
            {phase === 'keep_select' && (
              <>
                {import.meta.env.DEV && (
                  <div style={{ fontSize: 13, color: '#ddd' }}>
                    確定目: {allFinals.join(' · ')}
                  </div>
                )}
                {netMode && !netMode.isMyTurn() ? (
                  <div style={{ fontSize: 12, color: '#888' }}>相手のターン（観戦中）</div>
                ) : rollsLeft > 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span style={{ opacity: 0.65, fontSize: 12 }}>
                      ダイスをクリックでキープ / キープ欄をクリックで戻す / 残り {rollsLeft} 回
                    </span>
                    <button
                      style={{
                        background: '#1a3a7a', color: '#fff',
                        border: 'none', borderRadius: 6,
                        padding: '6px 20px', cursor: 'pointer',
                        fontFamily: 'sans-serif', fontSize: 13,
                      }}
                      onClick={() => {
                        if (maybeTriggerStaging()) return
                        SE.button()
                        if (netMode?.role === 'guest') netMode.requestRoll()
                        else handleReRoll()
                      }}
                    >
                      🎲 再振り ({rollsLeft})
                    </button>
                    <button
                      style={{
                        background: '#5a3a14', color: '#fff',
                        border: '1px solid #8a5a2e', borderRadius: 6,
                        padding: '6px 16px', cursor: 'pointer',
                        fontFamily: 'sans-serif', fontSize: 13,
                      }}
                      onClick={() => { if (maybeTriggerStaging()) return; SE.button(); setRollsLeft(0) }}
                      title="残り回数を使わず、今の出目で記入する"
                    >
                      ✓ 振らずに確定
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: '#aaa' }}>
                    ← 左のシートのカテゴリをクリックして記入
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* ── ゲームオーバー画面 ── */}
      {gameOver && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'rgba(0,0,0,0.82)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontFamily: 'sans-serif',
        }}>
          {(() => {
            // ネットモード: 左=1P(ホスト) / 右=2P(ゲスト) 固定
            // ホスト視点: playerSheet=1P, cpuSheet=2P / ゲスト視点: cpuSheet=1P, playerSheet=2P
            const score1P  = netMode?.role === 'guest' ? calcTotalScore(cpuSheet)    : calcTotalScore(playerSheet)
            const score2P  = netMode?.role === 'guest' ? calcTotalScore(playerSheet) : calcTotalScore(cpuSheet)
            const label1   = netMode ? '1P' : 'あなた'
            const label2   = netMode ? '2P' : 'CPU'
            const winText  = score1P > score2P ? `🏆 ${label1} の勝ち！` :
                             score2P > score1P ? `🏆 ${label2} の勝ち！` : '🤝 引き分け！'
            return (<>
              <div style={{ fontSize: 28, marginBottom: 16 }}>🎉 ゲーム終了！</div>
              <div style={{ display: 'flex', gap: 48, marginBottom: 24 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: '#aaa', marginBottom: 4 }}>{label1}</div>
                  <div style={{ fontSize: 36, color: '#ffd700', fontWeight: 'bold' }}>{score1P} 点</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: '#aaa', marginBottom: 4 }}>{label2}</div>
                  <div style={{ fontSize: 36, color: '#7af', fontWeight: 'bold' }}>{score2P} 点</div>
                </div>
              </div>
              <div style={{ fontSize: 22, marginBottom: 24, color: '#ffd700' }}>{winText}</div>
            </>)
          })()}
          <button
            style={{
              background: '#2d6a2d', color: '#fff',
              border: 'none', borderRadius: 8,
              padding: '10px 32px', cursor: 'pointer',
              fontFamily: 'sans-serif', fontSize: 16,
            }}
            onClick={() => { SE.button(); handleGameReset() }}
          >
            もう一度プレイ
          </button>
          <button
            style={{
              background: '#1a3a5c', color: '#fff',
              border: 'none', borderRadius: 8,
              padding: '10px 28px', cursor: 'pointer',
              fontFamily: 'sans-serif', fontSize: 14,
              marginTop: 8,
            }}
            onClick={downloadLog}
          >
            ログをダウンロード
          </button>
        </div>
      )}
    </div>
  )
}
