# ネット対戦実装 作業記録

## フェーズ1: 基本アーキテクチャ

- **PeerJS (WebRTC)** + シグナリングサーバー (`yacht-signaling-server.onrender.com`) で P2P 接続
- **ホスト権威型**: 乱数・演出抽選・スコア計算はすべてホスト側で決定
- `NetMode` インターフェース・`useNetMode.ts` フック・`protocol.ts` メッセージ型定義を設計・実装

---

## フェーズ2: バグ修正（通しテストで発見・修正したもの）

| # | 不具合 | 原因 | 修正 |
|---|---|---|---|
| 1 | **集約位置がホスト/ゲストでズレる** | stateの並び順に依存するインデックス`k`を使っていた | netモードは`s.id`をスロットに使用 |
| 2 | **炎/フリップがゲストで別のダイスに当たる** | netInjectパスで`swapIndices = []`のまま | `displayValues vs finals`比較で正しく再計算 |
| 3 | **アンキープ時にダイスが空中から着地する** | 旧物理config（launchImpulse）が残っていた | `onKeepUpdate`でkinematicSpawnに差し替え |
| 4 | **ゲストターン中にホストのスコアシート手番表示が反転** | `notifyRecord`で`turnChangeCbs`を呼んでいなかった | `turnChangeCbs(false)`を追加 |
| 5 | **ゲストが間違ったスコアを記入する** | `guestDiceFinals`が`hostProcessGuestRoll`後に更新されていなかった | `guestDiceFinals.current = newFinals`を追加 |
| 6 | **振るボタンを押すと勝手にカップが投入される** | `triggerAutoRoll()`が操作側にも発火していた | `if (netInject)` のみ発火に修正 |
| 7 | **ゲスト観戦側が最低秒数で勝手に投入される** | 観戦側に`triggerAutoRoll()`（自動投入）を使っていた | `cup_thrown`/`cup_released`プロトコルを追加、`triggerSyncRoll`/`releaseThrow`を実装 |
| 8 | **再振り時にゲスト側フィールドのダイスが残る** | `setDieConfigs([])`が適切なタイミングで呼ばれていなかった | `onRollResult`冒頭で常にクリア |
| 9 | **再振り時に非キープダイスの乱数がリセットされない** | `handleReRoll(auto=false)`が前回の`lastResultRef.finalValues`を使っていた | `auto \|\| netMode?.role === 'host'`のときランダム抽選 |
| 10 | **リザルト画面が"あなた/CPU"表記** | netモード判定がなかった | 役割に応じて"1P/2P"固定表示に修正 |
| 11 | **ヨット成立時に斬撃Bやカップ演出が発生する** | ヨット検知がなかった | `preparePendingRoll`・`handleReRoll`両方でヨット判定→`effectId='none'`に抑制 |
| 12 | **炎演出がホストにしか出ない** | `onStaging`メッセージがゲストのgather完了前に届き弾かれていた（タイミング競合） | `pendingStagingRef`でキューイング、gather完了時に消化 |
| 13 | **もう一度プレイでBGMがhealing15に戻らない** | AudioContext suspended時に`playDefault()`が無音のまま終了 | `ctx.resume()`を自前で呼んでから再開 |

---

## フェーズ3: UX改善

- **振るボタン追加**: デバッグパネルなしでカップを振り始められるよう `🎲 振る` ボタンを実装
- **光の柱（ヨット）演出の抑制ルール**: ヨット成立時は集約前演出（斬撃B等）を一切出さず、光の柱のみ発火するよう統一

---

## 変更した主要ファイル

| ファイル | 主な変更 |
|---|---|
| `src/net/useNetMode.ts` | ターン切替通知・`cup_thrown`/`cup_released`コールバック追加 |
| `src/net/protocol.ts` | `MsgCupThrown`・`MsgCupReleased`型追加 |
| `src/scene/GameScene.tsx` | 上記バグ修正全般・振るボタン・pendingStagingRef |
| `src/scene/CupAnim.tsx` | `triggerSyncRoll`/`releaseThrow`・`onThrowStart`/`onThrowRelease` props・150ms誤発火防止 |
| `src/audio/bgm.ts` | `playDefault()` AudioContext suspended対応 |
