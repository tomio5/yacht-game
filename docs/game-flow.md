# 現在のゲームフロー（コードベース・2026-06-22 更新）

> [GameScene.tsx](../src/scene/GameScene.tsx) / [CupAnim.tsx](../src/scene/CupAnim.tsx) / [FieldDie.tsx](../src/scene/FieldDie.tsx) の正確な記録。

## 1. GamePhase 全種類

型: `'idle' | 'cup_ready' | 'rolling' | 'gathering' | 'pre_gather_cover' | 'staging' | 'keep_select'`

| フェイズ | 内容 | 操作 |
|---|---|---|
| **idle** | ターン待機 | 可（振るボタン） |
| **cup_ready** | カップにセット→ホールド待ち。ホールド→ラトル→移動→反転→投入まで全部この間 | カップのみ |
| **rolling** | 投入ダイスが物理で散らばり、全数 sleep を待つ | 不可 |
| **gathering** | 中央集約の移動アニメ（470ms） | 不可 |
| **pre_gather_cover** | cupHide 専用。集約後にカップが1個を覆う → commitReveal → gathering へ連結 | 不可 |
| **staging** | 集約後の演出フェイズ（flip / thunder / fire 等）。演出なしなら即通過 | 不可 |
| **keep_select** | キープ/再振り/記入を受付 | 可 |

遷移は常に **rolling → gathering → (pre_gather_cover?) → staging → keep_select** の順。

## 2. 1ターンの時系列

| # | フェイズ | 内容 | 時間 | 操作 |
|---|---|---|---|---|
| 1 | cup_ready / roll_ready | 中身表示・ホールド待ち | ホールドまで | ユーザー待ち |
| 2 | cup_ready / roll_shaking | カップ揺れ＋物理ラトル | 最低0.5s + 離すまで | ユーザー（押→離す） |
| 3 | cup_ready / roll_moving | HOME→POUR_POS 移動 | 0.5s | 自動 |
| 4 | cup_ready / roll_pouring | 140°反転、90°で中身隠す | 0.45s | 自動 |
| 5 | cup_ready / roll_hold | 反転停止→投入発火 | 0.05s後 onSpawn | 自動 |
| 6 | **rolling** | spawnDice→射出・散らばり・全数静止待ち | 約1〜3s | 自動 |
| 7 | **gathering** | 全ダイスを5円へ集約・kinematic移動 | 470ms | 自動・不可 |
| 8 | **pre_gather_cover** | [cupHide時のみ] カップが1個を覆い書き換え→gathering | 約1.5s | 自動・不可 |
| 9 | **staging** | 演出再生（flip / thunder / fire 等）。なければ即通過 | 演出依存 | 自動・不可 |
| 10 | **keep_select** | キープ/再振り/記入 受付 | 無制限 | ユーザー待ち |
| 11 | → cup_ready | 再振り → handleReRoll → カップへ再セット | 即時 | ユーザー（再振り） |

CPU は別途 setTimeout（1200/1000/600/1400ms）で進行。

## 3. 静止後の分岐フロー（handleSettle）

全ダイス静止後に以下の順で分岐する:

```
handleSettle（全数静止）
  ↓
[1] cupHide？ (lastResultRef.effectId === 'cupHide')
      YES → pre_gather_cover フェイズ
             playCupHide() → commitReveal() → gatherFieldDice() → finishGatherToKeepSelect()
      NO ↓
[2] slashB？ (slashBArmedRef || effectId === 'slashB')
      YES → gathering フェイズ
             対象ダイスがジグザグ移動（zigzagTo）
             他のダイスは通常集約（gatherTo）
             完了後 → 直接 keep_select（stagingなし）
      NO ↓
[3] 通常
      gatherFieldDice() → gathering フェイズ
      470ms後 finishGatherToKeepSelect()
              ↓
            stagingArmedRef をセット
              isYacht=true → 強制装填
              selectStagingEffect()≠none → 装填
              ↓
            keep_select フェイズ
```

## 4. staging の起動タイミング

`stagingArmedRef = true` の状態で:

- **プレイヤーターン**: ダイスクリック or スコアシートクリック時に `maybeTriggerStaging()` が起動
  → `playStaging()` + `netMode.notifyStaging()`（相手側でも同時再生）
- **CPUターン**: 1秒後に自動起動
- **ネット観戦側**: `onStaging` メッセージ受信時に起動。gather 完了前に届いた場合は `pendingStagingRef` にキューイングし gather 完了時に消化

## 5. 演出セレクタ（resolveEffect / selectStagingEffect）

```
resolveEffect(finals, mode, cover, fieldCount)
  ↓
  [デバッグ強制] mode=none/success/miss or cover=flip/thunder/... → 直接返す
  ↓
  [cupHide 独立抽選] fieldCount=1（4キープ再振り）のとき
      drawIndependentCupHide(): success:20% / miss:8% / none:72%
      cupHide → 返す / none → フォールスルー
  ↓
  [テーブル抽選] selectEffectFromTable(displayRank, Math.random, slashBBoost)
      displayRank(none/weak/mid/strong/max) × weight で抽選
      化けダイスあり時 slashB を 1.5 倍ブースト
  ↓
effectId + mode(success/miss) 確定
```

確率テーブルの詳細は [effectTable.ts](../src/game/effectTable.ts) 参照（CLAUDE.md にも現在値を記載）。

## 6. ネット対戦時の差異

- ゲスト（非アクティブ側）は `onRollResult` を受信して `preparePendingRoll`（1投目）or `handleReRoll`（再振り）を呼ぶ
- 演出の抽選・finalValue 生成はすべてホストが行い `roll_result` メッセージで配信
- カップ投入のタイミングは `cup_thrown` / `cup_released` メッセージで同期
- `staging` メッセージで両者同時に演出再生
- `gatherFieldDice` はネットモード時シャッフルなし・ジッターなし（両クライアントで集約位置が完全一致）
