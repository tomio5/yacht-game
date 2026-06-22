# ヨット ゲーム仕様書

> 作成: 2026-06-22  
> コードベース: `src/` 配下の実装に基づく正確な記述

---

## 1. ゲーム概要

アソビ大全の「ヨット」ルールを採用した 3D ダイスゲーム。
5個のサイコロを最大3回振り、13のカテゴリにスコアを記入していく。
全13カテゴリを埋めたプレイヤーの合計点で勝敗を決める。

### 対戦形式

| モード | 内容 |
|--------|------|
| ソロ(CPU対戦) | プレイヤー 1 人 vs CPU |
| ネット対戦 | ブラウザ2タブ間の P2P 対戦（PeerJS / WebRTC）|

---

## 2. ゲームルール

### 基本フロー（1ターン）

1. サイコロ5個をカップに入れ、**ホールド→離す**で投入（1投目）
2. 着地後、好きなサイコロをキープ
3. 残りを再投入（2投目）→ 同様にキープ
4. 3投目終了後（または任意のタイミングで）、**13カテゴリのいずれかに記入**
5. 次のプレイヤーへターンチェンジ

> 振る回数は最大3回（初回 + 再振り2回）。rollsLeft が 0 になるとキープ操作は不可になりスコア記入のみ可能。

### 13カテゴリ（スコアシート）

#### 上段（エース〜シックス）

| カテゴリ | 計算 |
|----------|------|
| エース (ones) | 1の目の合計 |
| デュース (twos) | 2の目の合計 |
| トレイ (threes) | 3の目の合計 |
| フォー (fours) | 4の目の合計 |
| ファイブ (fives) | 5の目の合計 |
| シックス (sixes) | 6の目の合計 |

**上段ボーナス**: 上段合計が 63点以上 で +35点ボーナス。

#### 下段

| カテゴリ | 条件 | 得点 |
|----------|------|------|
| チョイス (choice) | 制限なし | 5個の合計 |
| フォーダイス (fourOfAKind) | 同じ目が4個以上 | 5個の合計 |
| フルハウス (fullHouse) | 3個 + 2個ちょうど（5個同じは不可） | 5個の合計 |
| S.ストレート (smallStraight) | 4連続を含む | 15点（固定） |
| B.ストレート (largeStraight) | 5連続 | 30点（固定） |
| ヨット (yacht) | 5個全部同じ | 50点（固定） |

### ゲーム終了・勝敗

- 両プレイヤーが全13カテゴリを埋めるとゲーム終了
- 上段ボーナスを含む総合得点が高い方が勝ち
- 同点は引き分け

---

## 3. フェイズ遷移（1ターンのフロー）

```
idle
  ↓ （振るボタン押下）
cup_ready  ← カップ中身セット・ホールド→ラトル→移動→反転→投入
  ↓ （反転完了でダイス出現）
rolling    ← 物理シミュ・全ダイス静止待ち
  ↓ （全数静止）
gathering  ← 中央集約（470ms）
  ↓
staging    ← 演出再生（なければ即通過）
  ↓
keep_select ← キープ/再振り/記入を受付
  ↓ （再振り）→ cup_ready へ戻る
  ↓ （記入）→ idle（次ターン）
```

| フェイズ | 説明 | 操作可否 |
|----------|------|----------|
| idle | ターン待機 | 可（振るボタン） |
| cup_ready | カップ操作中（ホールド〜投入） | カップのみ |
| rolling | ダイス物理演算・静止待ち | 不可 |
| gathering | 中央集約アニメ (0.47s) | 不可 |
| staging | 演出再生（flip / thunder 等） | 不可 |
| keep_select | キープ選択・再振り・記入 | 可 |

---

## 4. ダイスの2値管理

ダイスは **displayValue（見た目）** と **finalValue（確定目）** の2つを持つ。

| 値 | 役割 |
|----|------|
| `finalValue` | 公正乱数で先に確定した本当の出目。スコア計算・記録に使う |
| `displayValue` | 画面に映る目。演出中は finalValue と異なる場合がある（見せ目） |

演出（flip / thunder 等）が `commitReveal()` を呼ぶことで `displayValue → finalValue` に同期される。**displayValue でスコア判定は絶対に行わない。**

---

## 5. 演出システム

### 演出選択フロー

```
投入確定（finals 決定）
  ↓
resolveEffect(finals, mode, cover, fieldCount)
  ↓
  [cupHide 独立抽選] — field=1個（4キープ再振り）限定
      success: 20% / miss: 8% / none: 72%
      cupHide 確定 → そのまま
      none → テーブル抽選へ
  ↓
  [テーブル抽選] — 役ランクで重み抽選
      DisplayRank（none/weak/mid/strong/max）→ effectId + variant
  ↓
effectId（演出の種類）と mode（success/miss）が確定
  ↓
computeShowDice(finals, mode, keptIds)
  success → 役に応じた見せ目(decoy)を1個仕込む
  miss    → finalそのまま（カップは動くが書き換えなし）
  none    → そのまま投入
```

### 役ランク（DisplayRank）

演出テーブルのキー。スコア上の強さではなく「見栄えの強さ」。

| rank | 条件の目安 |
|------|-----------|
| none | 揃いなし・ストレートなし |
| weak | 変動役の実点 1〜14 |
| mid | S.ストレート / 変動役の実点 15〜27 |
| strong | B.ストレート / 変動役の実点 28〜30 |
| max | ヨット（5個同じ） |

### 演出確率テーブル（現在値）

| rank | none | flip | thunder | thunder_v2 | fire(s) | fire(m) | slashB |
|------|------|------|---------|------------|---------|---------|--------|
| none | 100 | — | — | — | — | — | — |
| weak | 96 | 2 | — | — | — | — | 2 |
| mid | 78 | 10 | 6 | — | 3 | 1 | 2 |
| strong | 62 | 12 | 11 | 4 | 6 | 2 | 3 |
| max | 42 | 9 | 14 | 22 | 8 | 2 | 3 |

cupHide は 4キープ再振り時のみ独立抽選（success:20% / miss:8% / none:72%）。

### A系統演出（staging フェイズで再生）

集約後の盤面で displayValue → finalValue に書き換える演出群。

| 演出ID | 内容 | 対応 variant |
|--------|------|-------------|
| flip | ダイスが跳ね上がって回転し、final面が上になる | success |
| thunder | 物理射出 → 着地誘導 → 確認1秒 → 集約 | success |
| thunder_v2 | 128欠片爆散 → 余韻 → 高速集合 | success |
| fire | GPUパーティクル炎（発生1.5s → 拡大3.0s → 消える1.2s） | success / miss |
| ヨット（光の柱） | yachtActive=true で光の柱表示 + Amazing Grace 再生 | success のみ |
| cupHide | カップが1個を覆い中身を差し替え（or ハズレ） | success / miss |

**staging の起動タイミング（プレイヤーターン）**: `finishGatherToKeepSelect` で `stagingArmedRef` がセットされ、プレイヤーが最初にダイスかスコアシートをクリックした瞬間に起動（`maybeTriggerStaging()`）。CPU は1秒後に自動起動。

### B系統演出（集約過程を差し替え）

staging を使わず、gatherFieldDice の代わりに別の移動処理を行う。

| 演出ID | 内容 |
|--------|------|
| slashB | 対象ダイスがジグザグ移動で集約スロットへ。斬撃SE + エフェクト表示。staging は発生しない |

### 見せ目（decoy）の仕組み

`computeShowDice(finals, 'success', keptIds)` が役に応じた差し替えを1個作る。

| 役 | decoy の選び方 |
|----|----------------|
| ヨット | field(非キープ)の中からランダム1個を別の目に変える |
| フォーダイス | 揃いの目を1個崩す（トリプルに見える） |
| フルハウス | ペア側を1個崩す |
| 上段 | 対象の目を1個崩す |
| S.ストレート / B.ストレート | run の1個を崩す（端伸ばし or 穴埋め） |

`swapIndices` にインデックスが記録され、演出の `commitReveal()` で finalValue に戻る。decoy が存在するのに effectId='none' だった場合は `selectStagingEffect` が強制的に 'flip' に昇格。

---

## 6. CPU AI

`src/game/cpuAI.ts` に実装。

### キープ判断（cpuKeepDice）

優先順位（上から順に適用）:

1. ヨット（5個同じ）→ 全部キープ
2. 4個同じ → 4個キープ
3. フルハウス（3+2）→ 全部キープ
4. 4連続以上 → ストレート狙いでその目をキープ
5. 3個同じ → 3個キープ
6. 2ペア → 両方の値をキープ
7. 1ペア → 高い方のペアをキープ
8. バラ → 最大値の1個だけキープ

### カテゴリ選択（cpuChooseCategory）

記入可能なカテゴリの中で **スコアが最大** のものを選ぶ。
全部0点の場合は損失が少ない順（ones → twos → smallStraight → ...）に無駄使い。

CPU の操作タイミング（sleep ms）:

| 操作 | 待機 |
|------|------|
| キープ選択 | 1200ms |
| 再振り | 1000ms |
| 記入 | 600ms（staging後）/ 1400ms |

---

## 7. ネット対戦

### 接続方式

PeerJS（WebRTC P2P）。シグナリングサーバー: `https://yacht-signaling-server.onrender.com`

### ホスト権威モデル

| 責務 | 担当 |
|------|------|
| 乱数生成（サイコロの目） | ホスト |
| 演出抽選（effectId / mode） | ホスト |
| スコア計算・確定 | ホスト |
| ゲーム終了判定 | ホスト |
| キープ状態の管理 | ホスト（guestKeptIds で追跡） |
| 操作リクエスト | ゲスト → ホストへ送信 |
| 状態通知 | ホスト → ゲストへブロードキャスト |

### メッセージ種別

**Host → Guest**

| type | 内容 |
|------|------|
| game_start | ゲーム開始・先攻通知 |
| game_reset | 次のゲーム開始（ホストが押した時） |
| turn_start | ターン開始（who + rollsLeft=3） |
| roll_result | サイコロ結果（finals / displayValues / effectId 等） |
| keep_update | キープ状態の更新（keptIds 全量） |
| score_recorded | スコア記入確定（両者のシート全量） |
| game_over | ゲーム終了（hostTotal / guestTotal / winner） |

**Guest → Host**

| type | 内容 |
|------|------|
| req_roll | 振るボタン押下 |
| req_keep | ダイスのキープ/アンキープ |
| req_record | スコア記入 |

**双方向**

| type | 内容 |
|------|------|
| staging | staging演出トリガー（同時再生） |
| cup_thrown | カップ投入開始（観戦側カップを連動） |
| cup_released | カップ解放（観戦側も同時解放） |

### ターンチェンジ

- ホストが記入確定 → `notifyRecord` → ゲストのターン開始 (`turn_start: guest`)
- ゲストが記入確定 → `req_record` → ホストが処理 → `score_recorded` → ホストのターン開始 (`turn_start: host`)
- ゲームリセット → ホストが `game_reset` + `turn_start(host)` を送信 → ゲストはリセット処理後にホスト先攻で待機

---

## 8. 物理・3D 実装

### ダイスの物理ポリシー

- ダイスは常設5個。React の mount/unmount をしない（Rapier の recursive use フリーズ対策）
- `location: 'field' | 'kept'` で居場所を管理
- カップと動ダイスを物理衝突させない（過去の爆発事故の再発防止）
- 演出後は必ず `finalValue` を強制セット（物理で出た面は採用しない）
- kinematic → dynamic 切替直後は `applyImpulse` が無効なため、`setLinvel` / `setAngvel` で速度を指定

### カップ動作

```
HOME[7,2.25,5] → POUR_POS[5,7,0.5]
  ↓ 0.5s（移動）
140°反転 → 90°時点で中身非表示（目隠し）
  ↓ 0.05s後 onSpawn（ダイス出現・射出）
帰還
```

### 集約スロット

中央集約後のダイス配置。ネット対戦時はシャッフルなし（両クライアントで完全一致させる）。

キープスロット: 上空の専用エリア（5箇所）にキープダイスが浮遊表示される。

---

## 9. オーディオ

### SE（効果音）

Web Audio API 合成音。`src/game/audio.ts`。

| SE | タイミング |
|----|-----------|
| roll | カップ投入 |
| land | ダイス着地 |
| keep | キープ |
| unkeep | キープ解除 |
| record | スコア記入 |
| button | ボタン押下 |
| win | 勝利 |
| 信頼度SE（gako / gakokyuin） | 30点以上成立時、50%確率 |

演出別SE:
- flip → `jump.wav`
- thunder A1 → `thunder2.mp3`
- thunder v2 → `thunder4.mp3`
- fire → `fire1/2/3.mp3`（段階別）
- slashB → `zangeki.wav`

### BGM

`src/audio/bgm.ts`。

| 曲 | 条件 |
|----|------|
| maou_bgm_healing15.wav | 通常時ループ |
| Amazing Grace.wav | ヨット成立時（光の柱演出中） |

音量スライダー: 二乗カーブ（`gain = (slider/100)²`）。知覚ベースのリニア感。

---

## 10. UI

- **スコアシート**: 木目調。左右列でプレイヤー/対戦相手。ネット対戦時は自分が常に左になるよう `swapColumns` で列入れ替え
- **プレビュー**: keep_select フェイズで記入前のカテゴリにスコア予測を表示（ゴールド文字）
- **ターンバナー**: ネット対戦でターン開始直後（rollsLeft=3 の idle）に「あなたのターンです」を中央表示。最初の振るボタン押下で消える
- **DebugPanel**: finalValue 手動指定・演出強制・SE 試聴等。本番環境でも残す（演出調整用）
- **勝敗画面**: ゲーム終了後に結果表示。「次のゲームを開始」ボタンでリセット

---

## 11. ファイル構成

```
src/
  game/
    types.ts       — 型定義（DieValue, Category, ScoreSheet, DisplayRank 等）
    scoring.ts     — 13カテゴリのスコア計算 / getBestScoringRole / getDisplayRank
    dice.ts        — ダイス乱数
    cpuAI.ts       — CPU キープ判断 / カテゴリ選択
    showDice.ts    — 見せ目(decoy)計算（computeShowDice / getSuccessDecoy）
    effectTable.ts — 演出抽選テーブル（EFFECT_TABLE / drawIndependentCupHide）
    gameState.ts   — ゲーム状態管理
    audio.ts       — SE / 合成BGM / ファイルSE 再生

  audio/
    bgm.ts         — ファイルBGM マネージャ（healing15 / Amazing Grace）

  scene/
    GameScene.tsx  — メインコンポーネント。全フェイズ管理・演出制御
    FieldDie.tsx   — 1個のダイス（物理 / キープ浮遊 / gather 等）
    CupAnim.tsx    — カップアニメーション制御
    ScoreSheet.tsx — スコアシートUI + 音量スライダー
    DebugPanel.tsx — デバッグパネル
    FractureSystem.tsx — thunder_v2 用 128欠片プール
    fireTexture.ts — 炎パーティクル Canvas 生成
    woodTexture.ts — 木目テクスチャ生成

  net/
    useNetMode.ts  — ネット対戦フック（ホスト権威 / コールバック pub-sub）
    PeerConnection.ts — PeerJS ラッパー
    protocol.ts    — 通信メッセージ型定義
```

---

## 12. 技術スタック

| 分類 | 使用技術 |
|------|---------|
| フロントエンド | Vite + React + TypeScript |
| 3D | React Three Fiber |
| 物理 | @react-three/rapier（Rapier.js） |
| ユーティリティ | @react-three/drei |
| P2P通信 | PeerJS（WebRTC） |
| デプロイ | Vercel（GitHub push で自動） |
| シグナリング | Render（`yacht-signaling-server`） |
