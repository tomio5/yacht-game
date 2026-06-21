/**
 * ScoreSheet.tsx — 木目調スコアシート v2
 * ・テーブルボーダーなし → 行背景交互で区別
 * ・YOU/CPU 列に薄い帯色を付ける
 * ・ダイスアイコンを CSS バッジで描画（Unicode依存なし）
 * ・行高を詰めてコンパクトに
 */

import { useState } from 'react'
import { calcCategoryScore, calcUpperSum, calcUpperBonus, calcTotalScore } from '../game/scoring'
import { resumeAudio, setMasterVolume, getMasterVolume } from '../game/audio'
import type { Category, DieValue, ScoreSheet as ScoreSheetType } from '../game/types'

// ── アバター ──
const AVATARS    = ['🐶','🐱','🐰','🐻','🦊','🐯','🐸','🐵','🐼','🐨']
const CPU_AVATAR = '🤖'

// ── カテゴリ ──
const UPPER: Category[] = ['ones','twos','threes','fours','fives','sixes']
const LOWER: Category[] = ['choice','fourOfAKind','fullHouse','smallStraight','largeStraight','yacht']

// 上段: 数字バッジ (1〜6)
const UPPER_NUM: Record<Category, string> = {
  ones:'1', twos:'2', threes:'3', fours:'4', fives:'5', sixes:'6',
  choice:'', fourOfAKind:'', fullHouse:'', smallStraight:'', largeStraight:'', yacht:'',
}
// 下段: シンプルなテキスト記号
const LOWER_ICON: Record<Category, string> = {
  ones:'', twos:'', threes:'', fours:'', fives:'', sixes:'',
  choice:'Σ', fourOfAKind:'4×', fullHouse:'3+2',
  smallStraight:'4→', largeStraight:'5→', yacht:'⛵',
}
const CAT_LABEL: Record<Category, string> = {
  ones:'エース',    twos:'デュース',  threes:'トレイ',
  fours:'フォー',   fives:'ファイブ', sixes:'シックス',
  choice:'チョイス',
  fourOfAKind:'フォーダイス',
  fullHouse:'フルハウス',
  smallStraight:'S.スト',
  largeStraight:'B.スト',
  yacht:'ヨット',
}

// ── カラー ──
const WOOD   = 'linear-gradient(96deg,#3a1c08 0%,#5c2e0f 20%,#452210 40%,#6b3812 58%,#512a10 76%,#3a1c08 100%)'
const CREAM  = '#f5edd9'
const CREAM2 = '#ede4cc'   // 偶数行
const CBROWN = '#2c1a0a'   // テキスト濃
const MBROWN = '#6b4a28'   // テキスト中
const LBROWN = '#a07850'   // テキスト薄
const CBORDER= '#c8b090'   // 罫線
const YOUCOL = 'rgba(30,80,180,0.07)'   // YOU列帯
const CPUCOL = 'rgba(100,50,10,0.06)'   // CPU列帯
const YOUHL  = '#f0e060'   // YOU予定スコア（明るいゴールド。木目背景に対してコントラスト高）
const YOUHLBG= 'rgba(200,160,0,0.18)'
const ZEROC  = '#b0987a'
const LOCKC  = '#3a2a18'
const YACHTC = '#8b1a1a'

// ── Props ──
export interface ScoreSheetProps {
  playerSheet:   ScoreSheetType
  cpuSheet:      ScoreSheetType
  currentFinals: DieValue[] | null
  canRecord:     boolean
  onRecord:      (cat: Category) => void
  turn:          'player' | 'cpu'
  cpuThinking?:  boolean
  playerLabel?:  string    // default "YOU"
  cpuLabel?:     string    // default "CPU"
  swapColumns?:  boolean   // true のとき左=cpuLabel(1P), 右=playerLabel(2P) で表示
}

// ── ダイスバッジ（CSS で描画）──
function DieBadge({ n }: { n: string }) {
  const dotMap: Record<string, [number,number][]> = {
    '1': [[50,50]],
    '2': [[25,25],[75,75]],
    '3': [[25,25],[50,50],[75,75]],
    '4': [[25,25],[75,25],[25,75],[75,75]],
    '5': [[25,25],[75,25],[50,50],[25,75],[75,75]],
    '6': [[25,22],[75,22],[25,50],[75,50],[25,78],[75,78]],
  }
  const dots = dotMap[n] ?? []
  return (
    <div style={{
      width: 18, height: 18, minWidth: 18,
      background: CREAM,
      border: `1.5px solid ${MBROWN}`,
      borderRadius: 3,
      position: 'relative',
      boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
    }}>
      {dots.map(([x,y], i) => (
        <div key={i} style={{
          position: 'absolute',
          left: `${x}%`, top: `${y}%`,
          width: 3, height: 3,
          borderRadius: '50%',
          background: n === '1' ? '#c01010' : CBROWN,
          transform: 'translate(-50%,-50%)',
        }} />
      ))}
    </div>
  )
}

// ── 音設定（スコアシート下段） ──
function AudioControls() {
  // スライダーは知覚に合わせた二乗カーブ: slider(0-100) → gain = (slider/100)^2
  const [vol, setVol] = useState(Math.round(Math.sqrt(getMasterVolume()) * 100))

  return (
    <div style={{
      background: '#2c1a0a', padding: '7px 8px',
      display: 'flex', flexDirection: 'column', gap: 6,
      borderTop: `2px solid ${CBORDER}`,
    }}>
      <div style={{ fontSize: 8, letterSpacing: 1, color: '#a07850', fontWeight: 'bold' }}>♪ サウンド</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12 }}>🔈</span>
        <input
          type="range" min={0} max={100} value={vol}
          onChange={(e) => { resumeAudio(); const n = Number(e.target.value); setVol(n); setMasterVolume((n / 100) ** 2) }}
          style={{ flex: 1, accentColor: '#2d6a2d', cursor: 'pointer' }}
        />
        <span style={{ fontSize: 10, color: '#d8c8b4', minWidth: 30, textAlign: 'right', fontFamily: 'monospace' }}>
          {vol}%
        </span>
      </div>
    </div>
  )
}

// ── メインコンポーネント ──
export function ScoreSheet({
  playerSheet, cpuSheet, currentFinals, canRecord, onRecord,
  turn, cpuThinking = false,
  playerLabel = 'YOU', cpuLabel = 'CPU',
  swapColumns = false,
}: ScoreSheetProps) {
  const [avatar,     setAvatar]     = useState('🐶')
  const [showPicker, setShowPicker] = useState(false)

  const previewDice = currentFinals?.map((value, id) => ({ id, value, kept: false })) ?? null

  function playerPreview(cat: Category): number | null {
    if (!previewDice) return null
    return calcCategoryScore(cat, previewDice)
  }

  const pUpperSum = calcUpperSum(playerSheet)
  const cUpperSum = calcUpperSum(cpuSheet)
  const pBonus    = calcUpperBonus(playerSheet) > 0
  const cBonus    = calcUpperBonus(cpuSheet) > 0
  const pTotal    = calcTotalScore(playerSheet)
  const cTotal    = calcTotalScore(cpuSheet)

  // ── 共通セルスタイル ──
  const baseCell: React.CSSProperties = {
    padding: '0 4px', height: 26,
    verticalAlign: 'middle', border: 'none',
  }

  // ── YOU スコアセル ──
  function YouCell({ cat }: { cat: Category }) {
    const rec       = playerSheet[cat]
    const isLocked  = rec !== null
    const preview   = playerPreview(cat)
    const clickable = canRecord && !isLocked
    const hasScore  = isLocked || (preview !== null)
    const showVal   = isLocked ? rec : preview

    return (
      <td
        onClick={() => clickable && onRecord(cat)}
        style={{
          ...baseCell,
          width: 46, textAlign: 'center',
          background: clickable && preview !== null ? YOUHLBG : YOUCOL,
          cursor: clickable ? 'pointer' : 'default',
          fontWeight: 'bold',
          fontSize: 12,
          color: isLocked ? LOCKC :
                 preview !== null && preview > 0 ? YOUHL :
                 preview === 0 ? ZEROC : LBROWN,
          transition: 'background 0.15s',
        }}
      >
        {hasScore && showVal !== null ? showVal : <span style={{ color: ZEROC, fontWeight: 'normal' }}>·</span>}
      </td>
    )
  }

  // ── CPU スコアセル ──
  function CpuCell({ cat }: { cat: Category }) {
    const rec = cpuSheet[cat]
    return (
      <td style={{
        ...baseCell,
        width: 46, textAlign: 'center',
        background: CPUCOL,
        fontWeight: 'bold', fontSize: 12,
        color: rec !== null ? LOCKC : LBROWN,
      }}>
        {rec !== null ? rec : <span style={{ color: ZEROC, fontWeight: 'normal' }}>·</span>}
      </td>
    )
  }

  // ── 役名セル ──
  function NameCell({ cat, isYacht }: { cat: Category; isYacht?: boolean }) {
    const icon = UPPER.includes(cat) ? UPPER_NUM[cat] : LOWER_ICON[cat]
    return (
      <td style={{
        ...baseCell,
        paddingLeft: 6,
        color: isYacht ? YACHTC : CBROWN,
        fontWeight: isYacht ? 'bold' : 'normal',
        fontSize: 11,
        whiteSpace: 'nowrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {UPPER.includes(cat) ? (
            <DieBadge n={icon} />
          ) : (
            <span style={{
              fontSize: 11, width: 18, textAlign: 'center',
              color: isYacht ? YACHTC : MBROWN,
              lineHeight: '18px',
            }}>
              {icon}
            </span>
          )}
          {CAT_LABEL[cat]}
        </div>
      </td>
    )
  }

  // ── セクションラベル行 ──
  function SectionRow({ label }: { label: string }) {
    return (
      <tr>
        <td colSpan={3} style={{
          ...baseCell,
          height: 20, paddingLeft: 8,
          background: '#ddd0b8',
          fontSize: 9, letterSpacing: 1,
          color: MBROWN, fontWeight: 'bold',
          borderTop: `1px solid ${CBORDER}`,
          borderBottom: `1px solid ${CBORDER}`,
        }}>
          ▸ {label}
        </td>
      </tr>
    )
  }

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0,
      height: '100%', width: 252,
      background: WOOD,
      padding: 4, boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column',
      overflowY: 'auto',
      userSelect: 'none',
      boxShadow: '3px 0 14px rgba(0,0,0,0.55)',
      zIndex: 10,
    }}>
      <div style={{
        background: CREAM, borderRadius: 2,
        flex: 1, display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>

        {/* ── ヘッダー ── */}
        <div style={{
          background: '#3a1c08', color: '#e8d5b0',
          textAlign: 'center', fontSize: 12, fontWeight: 'bold',
          letterSpacing: 2, padding: '6px 0 5px',
          fontFamily: 'serif',
        }}>
          🎲 スコアシート
        </div>

        {/* ── アバター行 ── */}
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '5px 8px',
          background: '#ede4cc',
          borderBottom: `1px solid ${CBORDER}`,
        }}>
          {/* 左列: swapColumns=false→YOU(player), true→CPU(opponent/1P) */}
          {!swapColumns ? (
            <div
              style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
              onClick={() => setShowPicker(v => !v)}
              title="アバターを変更"
            >
              <span style={{ fontSize: 20 }}>{avatar}</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 'bold', color: turn === 'player' ? YOUHL : MBROWN }}>{playerLabel}</div>
                <div style={{ fontSize: 8, color: turn === 'player' ? YOUHL : LBROWN }}>
                  {turn === 'player' ? '● 手番中' : '○ 待機中'}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ fontSize: 20 }}>{CPU_AVATAR}</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 'bold', color: turn === 'cpu' ? '#8b3a10' : MBROWN }}>{cpuLabel}</div>
                <div style={{ fontSize: 8, color: turn === 'cpu' ? '#8b3a10' : LBROWN }}>
                  {turn === 'cpu' ? '● 手番中' : '○ 待機中'}
                </div>
              </div>
            </div>
          )}
          {/* 区切り */}
          <div style={{ width: 1, height: 28, background: CBORDER, margin: '0 4px' }} />
          {/* 右列: swapColumns=false→CPU, true→YOU(player/2P) */}
          {!swapColumns ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, fontWeight: 'bold', color: turn === 'cpu' ? '#8b3a10' : MBROWN }}>{cpuLabel}</div>
                <div style={{ fontSize: 8, color: turn === 'cpu' ? '#8b3a10' : LBROWN }}>
                  {turn === 'cpu' ? (cpuThinking ? '⏳ 考え中' : '● 手番中') : '○ 待機中'}
                </div>
              </div>
              <span style={{ fontSize: 20 }}>{CPU_AVATAR}</span>
            </div>
          ) : (
            <div
              style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end', cursor: 'pointer' }}
              onClick={() => setShowPicker(v => !v)}
              title="アバターを変更"
            >
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, fontWeight: 'bold', color: turn === 'player' ? YOUHL : MBROWN }}>{playerLabel}</div>
                <div style={{ fontSize: 8, color: turn === 'player' ? YOUHL : LBROWN }}>
                  {turn === 'player' ? '● 手番中' : '○ 待機中'}
                </div>
              </div>
              <span style={{ fontSize: 20 }}>{avatar}</span>
            </div>
          )}
        </div>

        {/* アバターピッカー */}
        {showPicker && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 4,
            padding: '5px 8px', background: '#e8dfc8',
            borderBottom: `1px solid ${CBORDER}`,
          }}>
            {AVATARS.map(a => (
              <span key={a} style={{ fontSize: 18, cursor: 'pointer', opacity: a === avatar ? 1 : 0.4 }}
                onClick={() => { setAvatar(a); setShowPicker(false) }}>
                {a}
              </span>
            ))}
          </div>
        )}

        {/* ── テーブル ── */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          <table style={{
            width: '100%', borderCollapse: 'collapse',
            fontFamily: 'monospace',
            tableLayout: 'fixed',
          }}>
            {/* 列幅定義 */}
            <colgroup>
              <col style={{ width: '100%' }} />
              <col style={{ width: 46 }} />
              <col style={{ width: 46 }} />
            </colgroup>

            {/* 列ヘッダー */}
            <thead>
              <tr style={{ background: '#e8dfc8', borderBottom: `1px solid ${CBORDER}` }}>
                <th style={{ ...baseCell, height: 22, textAlign: 'left', paddingLeft: 8, fontSize: 9, color: MBROWN, fontWeight: 'bold' }}>
                  役名
                </th>
                {!swapColumns ? <>
                  <th style={{ ...baseCell, height: 22, textAlign: 'center', fontSize: 10, color: YOUHL, fontWeight: 'bold', background: YOUCOL }}>{playerLabel}</th>
                  <th style={{ ...baseCell, height: 22, textAlign: 'center', fontSize: 10, color: MBROWN, fontWeight: 'bold', background: CPUCOL }}>{cpuLabel}</th>
                </> : <>
                  <th style={{ ...baseCell, height: 22, textAlign: 'center', fontSize: 10, color: MBROWN, fontWeight: 'bold', background: CPUCOL }}>{cpuLabel}</th>
                  <th style={{ ...baseCell, height: 22, textAlign: 'center', fontSize: 10, color: YOUHL, fontWeight: 'bold', background: YOUCOL }}>{playerLabel}</th>
                </>}
              </tr>
            </thead>

            <tbody>
              <SectionRow label="上段" />

              {UPPER.map((cat, i) => (
                <tr key={cat} style={{ background: i % 2 === 0 ? CREAM : CREAM2 }}>
                  <NameCell cat={cat} />
                  {!swapColumns ? <><YouCell cat={cat} /><CpuCell cat={cat} /></> : <><CpuCell cat={cat} /><YouCell cat={cat} /></>}
                </tr>
              ))}

              {/* ボーナスバー */}
              <tr>
                <td colSpan={3} style={{
                  ...baseCell, height: 'auto',
                  padding: '5px 8px',
                  background: '#ddd0b8',
                  borderTop: `1px solid ${CBORDER}`,
                  borderBottom: `1px solid ${CBORDER}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 9, color: MBROWN, fontWeight: 'bold' }}>小計 / ボーナス +35</span>
                    <span style={{ fontSize: 8, color: LBROWN }}>63点以上で+35</span>
                  </div>
                  {/* 左列プログレス */}
                  {[
                    !swapColumns
                      ? { label: playerLabel, sum: pUpperSum, bonus: pBonus, color: YOUHL }
                      : { label: cpuLabel,    sum: cUpperSum, bonus: cBonus, color: MBROWN },
                    !swapColumns
                      ? { label: cpuLabel,    sum: cUpperSum, bonus: cBonus, color: MBROWN }
                      : { label: playerLabel, sum: pUpperSum, bonus: pBonus, color: YOUHL },
                  ].map(({ label, sum, bonus, color }, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: idx === 0 ? 3 : 0 }}>
                      <span style={{ fontSize: 9, color, minWidth: 52 }}>{label} {sum}/63{bonus ? '✦' : ''}</span>
                      <div style={{ flex: 1, height: 5, background: '#c8b098', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${Math.min(1, sum/63)*100}%`, background: bonus ? '#c8a020' : color, borderRadius: 3, transition: 'width 0.4s' }} />
                      </div>
                    </div>
                  ))}
                </td>
              </tr>

              <SectionRow label="下段" />

              {LOWER.map((cat, i) => (
                <tr key={cat} style={{ background: i % 2 === 0 ? CREAM : CREAM2 }}>
                  <NameCell cat={cat} isYacht={cat === 'yacht'} />
                  {!swapColumns ? <><YouCell cat={cat} /><CpuCell cat={cat} /></> : <><CpuCell cat={cat} /><YouCell cat={cat} /></>}
                </tr>
              ))}

              {/* 総合得点 */}
              <tr style={{ background: '#3a1c08' }}>
                <td style={{ ...baseCell, height: 32, paddingLeft: 8, color: '#e8d5b0', fontSize: 10, fontWeight: 'bold', borderTop: `2px solid ${CBORDER}` }}>
                  総合得点
                </td>
                {!swapColumns ? (
                  <>
                    <td style={{ ...baseCell, height: 32, textAlign: 'center', background: YOUCOL, borderTop: `2px solid ${CBORDER}` }}>
                      <span style={{ fontSize: 16, fontWeight: 'bold', color: '#e8d5b0' }}>{pTotal}</span>
                    </td>
                    <td style={{ ...baseCell, height: 32, textAlign: 'center', background: CPUCOL, borderTop: `2px solid ${CBORDER}` }}>
                      <span style={{ fontSize: 16, fontWeight: 'bold', color: '#c8a888' }}>{cTotal}</span>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ ...baseCell, height: 32, textAlign: 'center', background: CPUCOL, borderTop: `2px solid ${CBORDER}` }}>
                      <span style={{ fontSize: 16, fontWeight: 'bold', color: '#c8a888' }}>{cTotal}</span>
                    </td>
                    <td style={{ ...baseCell, height: 32, textAlign: 'center', background: YOUCOL, borderTop: `2px solid ${CBORDER}` }}>
                      <span style={{ fontSize: 16, fontWeight: 'bold', color: '#e8d5b0' }}>{pTotal}</span>
                    </td>
                  </>
                )}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 音設定（下段） ── */}
      <AudioControls />
    </div>
  )
}
