# 現在のゲームフロー（コードベース・2026-06-16 settled分割後）

> [GameScene.tsx](../src/scene/GameScene.tsx) / [CupAnim.tsx](../src/scene/CupAnim.tsx) / [FieldDie.tsx](../src/scene/FieldDie.tsx) の正確な記録。
> 2026-06-16 に settled を gathering/staging/keep_select に分割し、カップ隠しを集約後(staging)へ移動済み。

## 1. GamePhase 全種類
型: `'idle' | 'cup_ready' | 'rolling' | 'gathering' | 'staging' | 'keep_select'`（[GameScene.tsx]）
※旧 `animating`/`settled`/`done` は廃止。

| フェイズ | 内容 | 操作 | 設定箇所 |
|---|---|---|---|
| **idle** | ターン待機。プレイヤーはデバッグパネルで「振る」可。CPUは思考中 | 可(idleのみ) | 初期値 / `resetForNextTurn` |
| **cup_ready** | カップに中身セット→ホールド待ち。**ホールド→ラトル→移動→反転→投入まで全部この間**（GamePhaseは変わらない） | カップのホールド | `preparePendingRoll` / `handleReRoll` |
| **rolling** | 投入ダイスが物理で散らばり、全数 sleep を待つ | 不可 | `spawnDice`（onSpawn経由） |
| **gathering** | 中央集約の移動アニメ（5円へkinematic移動 0.45s） | **不可** | `handleSettle`（全数静止時） |
| **staging** | 集約後の演出フェイズ。カップ隠し等を再生。無ければ即 keep_select へ通過 | **不可** | `enterStaging` |
| **keep_select** | キープ/戻す/再振り/記入を受付 | **可** | `enterKeepSelect` |

遷移は常に **rolling → gathering → staging → keep_select** で一定。

## 2. 1投目ホールド→2投目ホールドの時系列
（大文字=GamePhase / 小文字=CupAnim内部フェイズ）

| # | GamePhase / 内部 | 内容 | 時間 | 操作/自動 |
|---|---|---|---|---|
| 1 | cup_ready / `roll_ready` | 中身表示・ホールド待ち | ホールドまで | ユーザー待ち |
| 2 | cup_ready / `roll_shaking` | カップ揺れ＋物理ラトル | 最低0.5s(`MIN_HOLD_SECS`)＋離すまで | ユーザー(押下→離す) |
| 3 | cup_ready / `roll_moving` | HOME→POUR_POS 移動 | 0.5s(`MOVE_DURATION`) | 自動 |
| 4 | cup_ready / `roll_pouring` | 140°反転、90°で中身隠す | 0.45s(`POUR_DURATION`) | 自動 |
| 5 | cup_ready / `roll_hold` | 反転停止→投入発火 | 0.05s(`HOLD_AFTER_POUR`)後 onSpawn | 自動 |
| 6 | **rolling** | spawnDice→射出・散らばり・全数静止待ち（裏でカップ帰還） | 可変・**推測 約1〜3s** | 自動 |
| 7 | **gathering** | 全ダイスを5円へシャッフル集約・kinematic移動 | 約0.47s(`GATHER_MS`) | 自動・操作不可 |
| 8 | **staging** | 演出フェイズ。success/miss はカップ隠し再生（**推測 約1.5〜1.7s**）／それ以外は即通過 | 演出依存 / 0s | 自動・操作不可 |
| 9 | **keep_select** | キープ/戻す/再振り/記入 受付 | 無制限 | ユーザー待ち |
| 10 | → cup_ready | 「再振り」→`handleReRoll`：非キープをカップへ→中身セット | 即時 | ユーザー(再振り) |
| 11 | cup_ready / `roll_shaking` | 2投目ホールド（以降1〜と同じ） | 同上 | ユーザー |

CPUは別途 setTimeout(1200/1000/600/1400ms)で進行。`keep_select` で keep/記入を判断。

## 3. 中央集約 → 演出セレクタ（staging）の順序
`handleSettle` 全数静止 → `gathering`(集約) → `GATHER_MS`後 `enterStaging`:
```
staging:
  effect = selectStagingEffect()   // mode と役の強さで決定
    success/miss → 'cupHide'（強制） / none → 'none'（強制）
    auto(通常/CPU/再振り) → diceStrengthTier→STAGING_CUPHIDE_PROB で 'cupHide'/'none' 抽選
  stagingPlayers[effect](onDone=enterKeepSelect)
    'cupHide' → playCupHide（覆う→swapTopFace→戻る。覆う座標=集約後worldPos。targetは cupIndices[0] 又はランダム）
    'none'    → 即 enterKeepSelect
```
- **順序: 中央集約(gathering) → 演出セレクタ/再生(staging) → keep_select**。集約で間隔を確保した整った配置の上で覆う。
- 演出セレクタ＆レジストリ（`selectStagingEffect`/`stagingPlayers`）は最小構成。将来の演出はここに追加。
- ⚠️ auto の cupHide は通常 display==final のため書き換えは no-op（覆って戻るだけ）。success/miss(ヨット)のみ実書換。

## 4. 投入6ステップ → 実フェイズ対応（改修後）
| ステップ | フェイズ |
|---|---|
| (1)ホールド/ラトル | cup_ready(`roll_shaking`) |
| (2)反転/射出 | cup_ready(`roll_moving`→`pouring`→`hold`)→投入で **rolling** へ |
| (3)着地/散らばり | **rolling** |
| (4)中央集約/配置 | **gathering** |
| (5)集約後の演出フェイズ | **staging**（カップ隠しはここ。将来 雷/フリップ等を載せる共通の場） |
| (6)キープ選択 | **keep_select** |

→ 6ステップと実フェイズが1:1で対応。旧版の「候補1(未分離)・候補2(隠しが集約前)・候補3(done)」は解消済み。

## 将来メモ
- staging は集約後の書き換え演出（雷・フリップ等）を増やせる共通フェイズ。種類選択の構造は今後拡張。
- 「三角形フォーメーション」等の“投入過程を変える演出”は反転〜集約の差し替え（staging とは別系統・未実装）。
