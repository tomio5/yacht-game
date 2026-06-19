# カップ内 物理ラトルで発生する Rapier フリーズ — 調査依頼まとめ

## 目的
カップを振る「カチャカチャ（カップ内でダイスが物理で転がる演出）」を **物理（@react-three/rapier）** で
実装したいが、再現性のあるフリーズ（クラッシュ）が起きる。原因を特定し、**物理ラトルを維持したまま**
直す方法を知りたい。現状はやむを得ず物理ラトルを撤去し、スクリプト（非物理）の揺れに退避している。

## 環境 / 依存
- React 19.2 / Vite 8（dev: oxc transform）
- three ^0.184.0
- @react-three/fiber ^9.6.1
- @react-three/rapier ^2.2.0（内部: @dimforge/rapier3d-compat, wasm）
- @react-three/drei ^10.7.7
- 単一の `<Physics gravity={[0,-20,0]}>`（[GameScene.tsx](../src/scene/GameScene.tsx) 内に1つだけ）

## 症状
- カチャカチャ中（特に「2〜3個キープして残りを再振り」した時）に、コンソールへ下記エラーが
  **毎フレーム大量に出続け**、R3F の物理ループが止まって画面ごとフリーズする。
- 最初の5個ロールでは比較的起きにくく、**再振り（カップ内が5個未満）＋シェイク中にカップを連打**すると
  ほぼ確実に発生した。

### エラーとスタックトレース
```
[Unhandled error] Error: recursive use of an object detected which would lead to unsafe aliasing in rust
 > I.wbg.__wbindgen_throw   node_modules/@dimforge/rapier3d-compat/rapier.mjs
 > set dt                   node_modules/@dimforge/rapier3d-compat/rapier.mjs
 > set timestep             node_modules/@dimforge/rapier3d-compat/rapier.mjs
 > Object.set               node_modules/@react-three/rapier/dist/react-three-rapier.esm.js:712
 > stepWorld                node_modules/@react-three/rapier/dist/react-three-rapier.esm.js:888
```
- `stepWorld` 内の `world.timestep = delta`（step 直前）で wasm-bindgen が「recursive use / unsafe aliasing」を
  throw。= **World が既に借用されている最中に再度 stepWorld が走っている／World への借用がリークしている**状態。
- 一度出ると毎フレーム出続ける（=借用が解放されないまま）。

## ラトルの実装（クラッシュした構成・撤去済み）
場所: `src/scene/CupAnim.tsx` の `CupRattle` コンポーネント（現在は削除）。要点:
- `active`（= React state `rattle`、ホールド開始で true / 投入後 false）が true の間だけマウント。
  → **dynamic RigidBody の追加/削除を毎ロール（さらに再振りごと）に行う**。
- 中身: 動かない fixed RigidBody（見えない円周ウォール8枚＋天井の蓋 CuboidCollider）＋
  `count` 個（1〜5可変）の dynamic ダイス（`colliders="cuboid"` ccd）。world座標 HOME に固定配置。
- `count` は再振り時に「非キープ数」に変化 → **マウントするボディ数が毎回変わる**。
- useFrame（毎フレーム）で各 dynamic ダイスに対し:
  ```ts
  const v = rb.linvel()
  if (v.y > VY_MAX) rb.setLinvel({x:v.x, y:VY_MAX, z:v.z}, true)
  if (hypot(v.x,v.z) < TARGET) {
    rb.setLinvel({x: rand*SPEED, y: min(v.y,VY_MAX), z: rand*SPEED}, true)
    rb.setAngvel({x: rand*SPIN, y: rand*SPIN*0.4, z: rand*SPIN}, true)
  }
  ```
  （`rb.mass()` で初期化前を弾く。`setLinvel/setAngvel` を毎フレーム呼ぶ）
- 別途、ホールド解放時に CupAnim 側 useFrame から `rb.translation()/rotation()` を読んで
  見た目ダイスへ姿勢を引き継いでいた（= **2つの useFrame が同じボディ群へアクセス**）。

参考: フィールド投入ダイス `FieldDie`（[FieldDie.tsx](../src/scene/FieldDie.tsx)）も dynamic で、
useFrame 内で `applyImpulse`/`setAngvel`/`translation` 等を呼ぶが、**こちらは単体ではクラッシュしない**
（最初の5個投入は正常に着地・静止する）。クラッシュは CupRattle 起因。

## 試した対策（いずれも無効 or 回避にとどまる）
1. **ラトルダイスの mesh を `raycast={() => null}`** に（クリック時のレイキャストが動く物理ボディを
   参照して再帰借用するのでは、という仮説）→ 効果なし。
2. **`React.StrictMode` を撤去**（dev 二重マウントが World 二重ステップを誘発する定番issue対策）→ 効果なし。
3. **useFrame を try/catch で包む**（借用リークを握りつぶせるか）→ エラーは自前 useFrame の外
   （ライブラリの `stepWorld`）で出る Unhandled なので捕捉できず無効。
4. **最終退避: 物理ラトルを完全撤去し、見た目ダイスをスクリプトで揺らす**（dynamic ボディをカップ内に
   一切置かない）→ フリーズは解消。ただし「物理で転がる」感触は失われた（本来は維持したい）。

## 仮説（未確定・調査してほしい点）
- `stepWorld` の `world.timestep =` で recursive use → **step が再入している／World 借用が解放されていない**。
- 怪しい要素:
  - **state 駆動で RigidBody を頻繁に add/remove**（active トグル＋count 変化）。ステップ進行中に
    ボディ追加/削除が走り World を二重借用している可能性。
  - 同一ボディ群へ**複数 useFrame からアクセス**（CupRattle の jostle と CupAnim の姿勢引き継ぎ）。
  - ある rapier 呼び出しが内部で throw → World 借用がリーク → 以後 stepWorld が毎回失敗。
  - React 19 + fiber 9 + rapier 2.2 の組み合わせ特有の既知issueの可能性（要 GitHub issue 調査）。

## 知りたいこと
- **物理ラトルを維持**しつつこのクラッシュを根絶する実装パターン。例:
  - ボディを毎回 add/remove せず**常設**して active/visible だけ切替える設計が安全か？
  - jostle を useFrame でなく `beforeStep`/`afterStep`（@react-three/rapier のコールバック）で行うべきか？
  - count 可変をやめ**常に5個**にして表示/投入数だけ絞るべきか？
  - rapier/fiber/rapier のバージョン相性・既知バグの有無。
- 「カップが静止中だけ物理を効かせる（移動・反転は非物理）」という当プロジェクトのハイブリッド方針は
  [CLAUDE.md](../CLAUDE.md) 参照（動く/反転するカップと中のダイスを物理衝突させない、が大前提）。

## 関連ファイル
- [src/scene/CupAnim.tsx](../src/scene/CupAnim.tsx)（カップ演出。CupRattle はここにあった）
- [src/scene/GameScene.tsx](../src/scene/GameScene.tsx)（Physics・投入・再振り・キープ管理）
- [src/scene/FieldDie.tsx](../src/scene/FieldDie.tsx)（フィールド投入ダイス＝正常動作する物理ダイスの参考実装）
- [CLAUDE.md](../CLAUDE.md)（設計思想・経緯）
