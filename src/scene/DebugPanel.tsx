/**
 * DebugPanel.tsx  — 開発用パネル（本番では DEV_MODE=false で非表示）
 *
 * Stage 4 変更点:
 *   - 1回目の振りのみ finalValue / mode を指定可能
 *   - phase / rollsLeft を受け取り、状態に合わせた表示に切り替える
 */

import { useState } from 'react'
import type { DieValue, EffectMode } from '../game/types'
import type { GamePhase, CoverForce } from '../scene/GameScene'
import {
  resumeAudio, setDiceSoundEnabled, getDiceSoundEnabled, getDiceSoundLabels, playDiceSoundByIndex,
  playFileSEForce,
} from '../game/audio'
import type { DiceHitKind } from '../game/audio'
import { getDisplayRank } from '../game/scoring'
import type { DisplayRank } from '../game/types'

const DEV_MODE = true

interface RollResult {
  displayValues: DieValue[]
  finalValues:   DieValue[]
  mode:          EffectMode
}

interface DebugPanelProps {
  disabled:  boolean         // 振り中・演出中は入力不可
  result?:   RollResult
  rollsLeft: number
  phase:     GamePhase
  onRoll:       (finalValues: DieValue[], mode: EffectMode, cover: CoverForce) => void
  onSlashTest?:     () => void
  onSlashDieTest?:  () => void
  slashDieMode?:    'success' | 'miss'
  onSlashDieModeChange?: (mode: 'success' | 'miss') => void
  slashBArmed?:          boolean
  onSlashBArmedChange?:  (v: boolean) => void
  yachtVariant?:         number
  yachtVariantNames?:    string[]
  onYachtVariantChange?: (v: number) => void
  onYachtTest?:          (v: number) => void
  stagingTests?:         readonly { key: string; label: string }[]
  onStagingTest?:        (key: string) => void
  throwEffects?:         readonly { key: string; label: string }[]
  throwEffect?:          string
  onThrowEffectChange?:  (key: string) => void
}

const DIE_VALUES = [1, 2, 3, 4, 5, 6] as DieValue[]
const MODE_LABELS: Record<EffectMode, string> = {
  success: '成功（書き換え）',
  miss:    'ハズレ（変化なし）',
  none:    '演出なし',
  auto:    '通常（確率抽選）',
}
const COVER_LABELS: Record<CoverForce, string> = {
  auto:       '表で抽選',
  cupHide:    'カップ隠し',
  flip:       'フリップ',
  thunder:    '雷',
  thunder_v2: '雷 v2',
  fire:       '炎',
  slashB:     '斬撃B',
}
const RANK_COLORS: Record<DisplayRank, string> = {
  none:   '#666',
  weak:   '#8a8',
  mid:    '#6ad',
  strong: '#d99',
  max:    '#f5c542',
}

function randomDice(): DieValue[] {
  return Array.from({ length: 5 }, () => Math.ceil(Math.random() * 6) as DieValue)
}

export function DebugPanel({ disabled, result, rollsLeft, phase, onRoll, onSlashTest, onSlashDieTest, slashDieMode = 'success', onSlashDieModeChange, slashBArmed = false, onSlashBArmedChange, yachtVariant = 0, yachtVariantNames = [], onYachtVariantChange, onYachtTest, stagingTests = [], onStagingTest, throwEffects = [], throwEffect = 'none', onThrowEffectChange }: DebugPanelProps) {
  const [finals, setFinals] = useState<DieValue[]>([4, 4, 4, 4, 4])
  const [mode,   setMode]   = useState<EffectMode>('success')
  const [cover,  setCover]  = useState<CoverForce>('auto')
  const [landOn,  setLandOn]  = useState<boolean[]>(() => getDiceSoundEnabled('land'))
  const [clackOn, setClackOn] = useState<boolean[]>(() => getDiceSoundEnabled('clack'))

  function toggleSound(kind: DiceHitKind, i: number) {
    resumeAudio()
    const cur  = kind === 'land' ? landOn : clackOn
    const next = cur.map((v, j) => (j === i ? !v : v))
    setDiceSoundEnabled(kind, i, next[i])
    if (kind === 'land') setLandOn(next)
    else                 setClackOn(next)
  }
  function testSound(kind: DiceHitKind, i: number) {
    resumeAudio()
    playDiceSoundByIndex(kind, i)
  }
  function soundRow(kind: DiceHitKind, on: boolean[]) {
    const labels = getDiceSoundLabels(kind)
    return (
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 9, color: '#888', marginBottom: 2 }}>
          {kind === 'land' ? '着地(床/壁)' : 'ダイス同士'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {on.map((v, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <button
                onClick={() => toggleSound(kind, i)}
                title={`${labels[i]} を使用 ${v ? 'ON' : 'OFF'}`}
                style={{
                  width: 24, fontSize: 9, padding: '2px 0', borderRadius: 3, cursor: 'pointer',
                  border: `1px solid ${v ? '#3a7a3a' : '#444'}`,
                  background: v ? '#2d6a2d' : '#222', color: v ? '#fff' : '#777',
                }}
              >{labels[i]}</button>
              <button
                onClick={() => testSound(kind, i)}
                title={`${labels[i]} を試聴`}
                style={{
                  width: 24, fontSize: 9, padding: '1px 0', borderRadius: 3, cursor: 'pointer',
                  border: '1px solid #555', background: '#1a1a2a', color: '#d4b483',
                }}
              >▶</button>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!DEV_MODE) return null

  const editable = phase === 'idle'   // 1回目の前だけ編集可能

  const panelStyle: React.CSSProperties = {
    position: 'absolute', top: 12, right: 12,
    background: 'rgba(15,15,20,0.88)',
    border: '1px solid rgba(212,180,131,0.35)',
    borderRadius: 10, padding: '12px 14px',
    color: '#d4b483', fontFamily: 'monospace', fontSize: 12,
    minWidth: 226, backdropFilter: 'blur(6px)', userSelect: 'none',
  }

  const labelStyle: React.CSSProperties = { fontSize: 10, color: '#888', marginBottom: 4 }

  const selectStyle = (active: boolean): React.CSSProperties => ({
    background: active ? '#111' : '#1a1a1a',
    color:      active ? '#d4b483' : '#555',
    border:     `1px solid ${active ? '#444' : '#2a2a2a'}`,
    borderRadius: 4, padding: '2px 4px',
    width: 36, textAlign: 'center', fontSize: 13,
    cursor: active ? 'pointer' : 'default',
  })

  const btnBase: React.CSSProperties = {
    border: '1px solid #555', borderRadius: 5,
    padding: '4px 10px', background: '#1a1a2a',
    color: '#d4b483', cursor: 'pointer',
    fontSize: 11, fontFamily: 'monospace',
    opacity: editable ? 1 : 0.4,
  }

  const rollBtnColor = disabled || !editable ? '#222' : '#1a3a7a'
  const rollBtnText  =
    phase === 'idle'      ? '🎲  振る（1回目）' :
    phase === 'rolling'   ? '転がり中...' :
    phase === 'pre_gather_cover' || phase === 'gathering' || phase === 'staging' ? '演出中...' :
    `再振り残り ${rollsLeft} 回`

  return (
    <div style={panelStyle}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 8,
                    borderBottom: '1px solid #333', paddingBottom: 4 }}>
        🛠 DEBUG PANEL
      </div>

      {/* finalValue 設定（1回目のみ） */}
      <div style={labelStyle}>finalValue（確定目）{!editable && <span style={{color:'#555'}}> ロック中</span>}</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {finals.map((v, i) => (
          <select
            key={i} value={v}
            style={selectStyle(editable)}
            disabled={!editable}
            onChange={e => {
              if (!editable) return
              const nv = Number(e.target.value) as DieValue
              setFinals(prev => prev.map((x, j) => j === i ? nv : x))
            }}
          >
            {DIE_VALUES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        ))}
        <button style={btnBase} disabled={!editable} onClick={() => editable && setFinals(randomDice())}>
          乱数
        </button>
      </div>

      {/* 演出モード */}
      <div style={labelStyle}>演出モード{!editable && <span style={{color:'#555'}}> ロック中</span>}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
        {(Object.keys(MODE_LABELS) as EffectMode[]).map(m => (
          <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 6,
                                   cursor: editable ? 'pointer' : 'default', opacity: editable ? 1 : 0.5 }}>
            <input type="radio" name="mode" value={m}
              checked={mode === m} disabled={!editable}
              onChange={() => editable && setMode(m)} />
            <span style={{ fontSize: 11, color: mode === m ? '#d4b483' : '#666' }}>
              {MODE_LABELS[m]}
            </span>
          </label>
        ))}
      </div>

      {/* cover 強制（auto＝表で抽選 / cupHide / flip。cover 強制時は success 扱い） */}
      <div style={labelStyle}>cover 強制{!editable && <span style={{color:'#555'}}> ロック中</span>}</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {(Object.keys(COVER_LABELS) as CoverForce[]).map(c => (
          <button
            key={c} disabled={!editable}
            onClick={() => editable && setCover(c)}
            style={{
              flex: 1, fontSize: 10, padding: '3px 0', borderRadius: 4,
              cursor: editable ? 'pointer' : 'default',
              border: `1px solid ${cover === c ? '#3a6a9a' : '#333'}`,
              background: cover === c ? '#1a3a5a' : '#1a1a1a',
              color: cover === c ? '#bfe' : '#666',
            }}
          >{COVER_LABELS[c]}</button>
        ))}
      </div>

      {/* 投入演出（B系統）強制: 選ぶと見せ目なしで次の投入がスロー/フェイクに */}
      {throwEffects.length > 0 && (
        <>
          <div style={labelStyle}>投入演出（次の投入）</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
            {throwEffects.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => onThrowEffectChange?.(key)}
                style={{
                  flex: '1 0 46%', fontSize: 10, padding: '3px 0', borderRadius: 4, cursor: 'pointer',
                  border: `1px solid ${throwEffect === key ? '#9a7a3a' : '#333'}`,
                  background: throwEffect === key ? '#3a2e12' : '#1a1a1a',
                  color: throwEffect === key ? '#f0d090' : '#666',
                }}
              >{label}</button>
            ))}
          </div>
        </>
      )}

      {/* 振るボタン（1回目のみ） */}
      <button
        disabled={disabled || !editable}
        style={{
          border: '1px solid #555', borderRadius: 5,
          padding: '6px 0', width: '100%', marginBottom: 4,
          background: rollBtnColor, color: disabled || !editable ? '#555' : '#fff',
          cursor: disabled || !editable ? 'not-allowed' : 'pointer',
          fontSize: 13, fontFamily: 'monospace',
        }}
        onClick={() => !disabled && editable && onRoll(finals, mode, cover)}
      >
        {rollBtnText}
      </button>

      {/* 結果表示 */}
      {result && (
        <div style={{ marginTop: 8, borderTop: '1px solid #333', paddingTop: 8, fontSize: 11 }}>
          <div style={{ color: '#888', marginBottom: 3 }}>
            モード: <span style={{ color: '#d4b483' }}>{result.mode}</span>
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 2, alignItems: 'center' }}>
            <span style={{ color: '#888', width: 52 }}>見せ目:</span>
            {result.displayValues.map((v, i) => (
              <span key={i} style={{ background: '#222', borderRadius: 3,
                                      padding: '1px 5px', color: '#aaa' }}>{v}</span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ color: '#888', width: 52 }}>確定目:</span>
            {result.finalValues.map((v, i) => (
              <span key={i} style={{
                background: result.displayValues[i] !== result.finalValues[i] ? '#1a3a7a' : '#222',
                borderRadius: 3, padding: '1px 5px',
                color: result.displayValues[i] !== result.finalValues[i] ? '#7af' : '#aaa',
              }}>{v}</span>
            ))}
          </div>
          {/* 役ランク（確定目から算出。演出選択用の見栄えの強さ） */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
            <span style={{ color: '#888', width: 52 }}>役ランク:</span>
            {(() => {
              const rank = getDisplayRank(result.finalValues)
              return (
                <span style={{
                  background: '#161616', border: `1px solid ${RANK_COLORS[rank]}`,
                  borderRadius: 3, padding: '1px 8px', fontWeight: 'bold',
                  color: RANK_COLORS[rank], letterSpacing: 1,
                }}>{rank.toUpperCase()}</span>
              )
            })()}
          </div>
        </div>
      )}

      {/* 衝突音テスト（番号=使用ON/OFF・▶=試聴） */}
      <div style={{ marginTop: 8, borderTop: '1px solid #333', paddingTop: 8 }}>
        <div style={{ ...labelStyle, marginBottom: 5 }}>
          ♪ 衝突音 <span style={{ color: '#555' }}>（番号=使用 / ▶=試聴）</span>
        </div>
        {soundRow('land',  landOn)}
        {soundRow('clack', clackOn)}
      </div>

      {/* 演出SE 試聴 */}
      <div style={{ marginTop: 8, borderTop: '1px solid #333', paddingTop: 8 }}>
        <div style={{ ...labelStyle, marginBottom: 5 }}>♪ 演出SE 試聴</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {([
            ['雷A1', '/sounds/thunder2.mp3'],
            ['雷v2', '/sounds/thunder4.mp3'],
            ['フリップ', '/sounds/jump.wav'],
            ['炎1', '/sounds/fire1.mp3'],
            ['炎2', '/sounds/fire2.mp3'],
            ['炎3', '/sounds/fire3.mp3'],
          ] as [string, string][]).map(([label, url]) => (
            <button
              key={url}
              onClick={() => { resumeAudio(); playFileSEForce(url) }}
              style={{
                fontSize: 10, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
                border: '1px solid #555', background: '#1a1a2a', color: '#d4b483',
              }}
            >▶ {label}</button>
          ))}
        </div>
      </div>

      {/* 斬撃エフェクト */}
      <div style={{ marginTop: 8, borderTop: '1px solid #333', paddingTop: 8 }}>
        <div style={{ ...labelStyle, marginBottom: 5 }}>⚔ 斬撃エフェクト</div>
        {/* 斬撃B装填トグル */}
        <div style={{ marginBottom: 6 }}>
          <button
            onClick={() => onSlashBArmedChange?.(!slashBArmed)}
            style={{
              width: '100%', fontSize: 10, padding: '3px 0', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${slashBArmed ? '#9a5a1a' : '#333'}`,
              background: slashBArmed ? '#4a2a0a' : '#1a1a1a',
              color: slashBArmed ? '#f9a' : '#666',
            }}
          >{slashBArmed ? '⚔B 斬撃B装填: ON（次の振りで発動）' : '⚔B 斬撃B装填: OFF'}</button>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 5 }}>
          <button
            onClick={() => { resumeAudio(); onSlashTest?.() }}
            style={{
              fontSize: 10, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
              border: '1px solid #666', background: '#1a1a1a', color: '#e0c090',
            }}
          >▶ 斬撃エフェクト再生</button>
        </div>
        {/* 割れ演出: success/miss 切り替え */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 5 }}>
          {(['success', 'miss'] as const).map(m => (
            <button
              key={m}
              onClick={() => onSlashDieModeChange?.(m)}
              style={{
                flex: 1, fontSize: 10, padding: '2px 0', borderRadius: 4, cursor: 'pointer',
                border: `1px solid ${slashDieMode === m ? '#5a9a3a' : '#333'}`,
                background: slashDieMode === m ? '#1a4a1a' : '#1a1a1a',
                color: slashDieMode === m ? '#8fc' : '#666',
              }}
            >{m === 'success' ? '✓ success' : '✗ miss'}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button
            onClick={() => { onSlashDieTest?.() }}
            style={{
              fontSize: 10, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
              border: '1px solid #666', background: '#1a1a1a', color: '#e0c090',
            }}
          >▶ 割れ＋復活テスト</button>
        </div>
      </div>

      {/* 光の柱 10パターン（クリックで選択＋即再生） */}
      {yachtVariantNames.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px solid #333', paddingTop: 8 }}>
          <div style={{ ...labelStyle, marginBottom: 5 }}>
            ✨ 光の柱（クリックで再生）
            {phase !== 'idle' && <span style={{ color: '#555' }}> ※idle時のみ</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {yachtVariantNames.map((name, i) => (
              <button
                key={i}
                disabled={phase !== 'idle'}
                onClick={() => { onYachtVariantChange?.(i); onYachtTest?.(i) }}
                title={name}
                style={{
                  fontSize: 10, padding: '4px 4px', borderRadius: 4,
                  cursor: phase === 'idle' ? 'pointer' : 'not-allowed',
                  textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  border: `1px solid ${yachtVariant === i ? '#7a5ad0' : '#333'}`,
                  background: yachtVariant === i ? '#2a1a4a' : '#1a1a1a',
                  color: yachtVariant === i ? '#cbb6ff' : '#888',
                  opacity: phase === 'idle' ? 1 : 0.45,
                }}
              >{i + 1}. {name}</button>
            ))}
          </div>
        </div>
      )}

      {/* 追加演出テスト（現在の盤面に対して再生。keep_select 時のみ） */}
      {stagingTests.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px solid #333', paddingTop: 8 }}>
          <div style={{ ...labelStyle, marginBottom: 5 }}>
            🎬 演出テスト（盤面に再生）
            {phase !== 'keep_select' && <span style={{ color: '#555' }}> ※振った後</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {stagingTests.map(({ key, label }) => (
              <button
                key={key}
                disabled={phase !== 'keep_select'}
                onClick={() => onStagingTest?.(key)}
                title={label}
                style={{
                  fontSize: 10, padding: '4px 4px', borderRadius: 4,
                  cursor: phase === 'keep_select' ? 'pointer' : 'not-allowed',
                  textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  border: '1px solid #3a6a4a', background: '#16241a', color: '#9ad8b0',
                  opacity: phase === 'keep_select' ? 1 : 0.4,
                }}
              >▶ {label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
