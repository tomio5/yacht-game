# 演出システム 設計思想と実装状況

> 更新: 2026-06-22

## 基本原則

「通常フロー＝演出なし（最弱ランクの演出）」と定義し、すべての投入を「何らかの投入演出を再生している状態」として統一的に扱う。派手な演出は通常フローの特定フェイズを **差し替え／拡張** したバリエーション（独立した別処理にしない）。

## 不変の原則

- 出目（finalValue）は公正乱数で先に確定済み。**演出は結果を変えない、ただの見せ方**。
- スコア判定・記録は常に finalValue。displayValue では判定しない。
- 書き換えは「**目隠しの一瞬**」にのみ行う（カップで隠れた間 / 欠片爆散中 / 跳ね上がり中 等）。
- 演出は「通常フローのどのフェイズを、どう差し替え/拡張するか」で定義する。

## 投入フローのフェイズ

```
idle → cup_ready → rolling → gathering → (pre_gather_cover?) → staging → keep_select
```

詳細は [game-flow.md](game-flow.md) 参照。

## 演出の2系統

### A系統: 集約後に書き換える演出 → **staging フェイズ**

整った配置の上で目隠しの一瞬に displayValue → finalValue を書き換える。

| 演出ID | 内容 | variant | 実装状況 |
|--------|------|---------|---------|
| cupHide | カップが1個を覆い書き換え（or ハズレ）。pre_gather_cover フェイズで再生 | success / miss | ✅ |
| flip | ダイスが跳ね上がり回転し final 面で着地。jump.wav | success | ✅ |
| thunder | 物理射出 → 着地誘導 → 確認1秒 → 集約。thunder2.mp3 | success | ✅ |
| thunder_v2 | 128欠片爆散 → 余韻 → 高速集合。thunder4.mp3 | success | ✅ |
| fire | GPU パーティクル炎（発生1.5s→拡大3.0s→消える1.2s）。fire1/2/3.mp3 | success / miss | ✅ |
| ヨット（光の柱） | yachtActive で光の柱 + Amazing Grace。finalValues が全一致で強制起動 | success のみ | ✅ |

**staging の起動**: `finishGatherToKeepSelect` で `stagingArmedRef` をセット → プレイヤーの最初の操作（or CPU は1秒後）で `playStaging()` が起動。演出完了後 `commitReveal()` で displayValue を finalValue に同期。

### B系統: 集約過程そのものを差し替える演出

gathering の代わりに別の移動処理を行う。staging フェイズは使わない。

| 演出ID | 内容 | 実装状況 |
|--------|------|---------|
| slashB | 対象ダイスがジグザグ移動で集約スロットへ着地。斬撃SE + エフェクト。移動完了後 displayValue を finalValue に同期し直接 keep_select へ | ✅ |
| 三角形フォーメーション等 | 投入過程（射出・集約の配置）自体を演出用に置き換える | 未実装 |

## 演出選択フロー

```
投入確定（finals 決定）
  ↓
resolveEffect(finals, mode, cover, fieldCount)
  ↓
[1] デバッグ強制（mode=none/success/miss / cover=flip/thunder/...）→ 直接返す
  ↓
[2] cupHide 独立抽選（fieldCount=1 のみ）
      success:20% / miss:8% / none:72%
      cupHide → 返す / none → フォールスルー
  ↓
[3] テーブル抽選
      getDisplayRank(finals) → none/weak/mid/strong/max
      EFFECT_TABLE[rank] で weight 正規化抽選
      化けダイスあり時 slashB を 1.5 倍ブースト
  ↓
effectId + mode(success/miss) 確定
  ↓
computeShowDice(finals, mode, keptIds)
  success → 役に応じた decoy を1個仕込む（swapIndices に記録）
  miss    → final そのまま（カップ等は動くが書き換えなし）
  none    → そのまま投入
```

## 見せ目（decoy）

`computeShowDice` → `getSuccessDecoy` が役ごとに1個の差し替えを計算する。

| 役 | decoy の選び方 |
|----|----------------|
| ヨット | field(非キープ)の中からランダム1個を別の目に変える |
| フォーダイス | 揃いの目を1個崩す（トリプルに見える） |
| フルハウス | ペア側を1個崩す |
| 上段 | 対象の目を1個崩す |
| S.ストレート / B.ストレート | run の1個を崩す（端伸ばし or 穴埋め）|
| none / 未対応役 | null（decoy なし）|

`swapIndices` にインデックスが記録され、演出の `commitReveal()` で finalValue に戻る。**decoy が存在する（swapIndices.length > 0）のに effectId が 'none' だった場合、`selectStagingEffect` が強制的に 'flip' に昇格させる**（decoy を reveal せずに keep_select に入ることを防ぐ）。

## ネット対戦での演出同期

- finalValues・effectId・displayValues（decoy 込み）はすべてホストが決定し `roll_result` で配信
- ゲスト（観戦側）は受信した値をそのまま使い、ローカルで再抽選しない
- staging 起動は `staging` メッセージで同期（アクティブ側が送信 → 観戦側も同時再生）
- ヨット再振り時: ホストが `computeShowDice` を実行して decoy 付き displayValues を送信

## 実装ロードマップ（残課題）

- 演出確率テーブルの本番値チューニング（現在は仮値）
- B系統の追加演出（三角形フォーメーション等）
- フリップ高さ＝期待度演出（高く跳ねる = 成功率高く見える）
- 着地誘導（方向C）の GUIDE_* パラメータ微調整
