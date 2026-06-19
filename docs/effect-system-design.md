# 演出システム 設計思想

> 「通常フロー＝演出なし(最弱ランクの演出)」と定義し、すべての投入を
> 「何らかの投入演出を再生している状態」として統一的に扱う。
> 派手な演出は通常フローの特定フェイズを **差し替え／拡張** したバリエーション
> （独立した別処理にしない）。

## 投入フローのフェイズ（演出が作用する単位）
遷移は常に一定: `idle → cup_ready → rolling → gathering → staging → keep_select`
（実装は [game-flow.md](game-flow.md) 参照。GamePhase と一致）
- **idle** … ターン待機
- **cup_ready** … カップにホールド→ラトル→移動→反転→投入（CupAnim 内部フェイズで進行）
- **rolling** … 物理で散らばり静止を待つ
- **gathering** … 中央集約（5円へ kinematic 移動・操作不可）
- **staging** … 集約後の演出フェイズ（操作不可）。演出を再生。無ければ即通過
- **keep_select** … キープ/再振り/記入を受付（ユーザー操作可）

## 演出の2系統
### A系統: 集約後の盤面で書き換える演出 → **staging に載せる**
- 例: カップ隠し(✅実装済み)・雷・フリップ・光の柱・地震
- 整った配置・確保された間隔の上で、**目隠しの一瞬**に displayValue→finalValue を書き換える
- ✅**演出セレクタ実装済み（最小構成）**（[GameScene.tsx]）:
  - `enterStaging` → `selectStagingEffect()` で識別子を決定 → `stagingPlayers`（識別子→再生処理のレジストリ）で再生 → 完了後 keep_select。
  - 現状の登録: `'none'`（即通過）/ `'cupHide'`（既存カップ隠し `playCupHide`）。
  - **将来 'thunder'/'flip' 等は「StagingEffect型に追加＋selectStagingEffectの分岐＋stagingPlayersに登録」の局所追加だけで足せる**。

### B系統: 投入過程そのものを変える演出 → **cup_ready〜gathering を差し替え**
- 例: 三角形フォーメーション（射出を煽る→無回転でストン→三角形配置で高得点役）
- staging とは別系統。反転・射出・集約の挙動自体を演出用に置き換える。
- 未実装。実装時は cup_ready/CupAnim の反転・射出や gathering の配置を差し替える形にする。

## 演出選択
- finalValue の役の強さ → 確率テーブル（**演出確率設計の xlsx**＝別管理）で演出を抽選。
- 「演出なし(弱)」が選ばれたら通常フローがそのまま流れる（staging を即通過）。
- 成功ケース/失敗ケースで演出配分を分ける。強い役ほど派手な演出が選ばれやすく、
  **演出の派手さで期待度が読める**（パチンコの信頼度）。
- 雷・光の柱など最強演出は**成功ケースにのみ**登場＝出たらほぼ確定、という設計。
- **現状（最小構成）**:
  - `EffectMode`: `success`/`miss`/`none`=デバッグ強制、`auto`=通常プレイ/CPU/再振り（確率抽選）。
  - `selectStagingEffect`: success/miss→`cupHide`、none→`none`、auto→役の強さ tier(`diceStrengthTier`)で
    `STAGING_CUPHIDE_PROB=[0.03,0.15,0.45,0.9]`（仮値）で `cupHide`/`none` を抽選。
  - 確率テーブルのフル実装（5段階×多演出・成功/失敗配分）は未。仮の2択＋tier確率のみ。
  - ⚠️ auto で cupHide が出ても通常プレイは display==final のため「覆って戻るだけ（書き換えnoop）」。
    本物のフェイク表示→reveal は、ロール時にフェイク display を決める仕組み（確率テーブル実装時）が必要。
  - ⚠️ success演出の見せ札書き換えは現状ヨットのみ実装（フォーダイス等は未＝カップは動くが書換noop。[showDice.ts] TODO）。

## 不変の原則（CLAUDE.md「★最重要の設計思想」と一致）
- 出目(finalValue)は公正乱数で先に決定済み。**演出は結果を変えない、ただの見せ方**。
- スコア判定・記録は常に finalValue。displayValue では判定しない。
- 書き換えは「**目隠しの一瞬**」にのみ行う（それ以外で書き換えない）。
- 演出は「通常フローのどのフェイズを、どう差し替え/拡張するか」で定義する。

## 実装ロードマップ（メモ）
1. ✅ staging に「演出の種類」枠（セレクタ＋レジストリ）。カップ隠し＝A系統の最初の一例。（最小構成・完了）
2. 演出選択ロジックのフル化（役の強さ→**確率テーブル(xlsx)**→演出抽選。成功/失敗で配分分け）。仮確率を本実装へ。
   - 併せて「フェイク display→reveal」の仕組み（ロール時に演出予約しフェイク見せ札を出す）も検討。
3. A系統の追加演出（雷＝分解→再集合で書換 等）。`StagingEffect`＋セレクタ＋`stagingPlayers` に追加するだけ。
4. B系統（三角形フォーメーション等。投入過程＝cup_ready〜gathering の差し替え）。
5. success演出の見せ札書き換えを全役対応（[showDice.ts] の getCupIndices/computeShowDice TODO）。
