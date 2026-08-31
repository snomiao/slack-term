# CI の coverage step が hang する件 — 調査記録

**状態: 解決済み (2026-08-31)。** `continue-on-error` は外し、CI は
失敗すれば赤くなる状態に戻した。

原因は **2 つ**あり、片方だけでは直らなかった:

1. **`coverage.include` が広すぎた** — istanbul が `ts/cli.ts` (4220 行) を
   毎回 instrument して結果を捨てていた。Node 24 で 2m59s → 33s。
2. **fork pool の worker 起動** — 残った 33s のうち大半がこれ。
   `--maxWorkers=1` で **16s**。`--no-file-parallelism` を既に付けているので
   2 個目の worker は起動コストしか産まない。

決め手は `--pool=threads` が 5.5s で走ったこと。テストではなく
**fork の起動が支配的**だと分かり、そこから worker 数に辿り着いた。

以下は当時の調査記録。**否定された仮説**の一覧としてそのまま残す。

## 症状

`.github/workflows/build.yml` の 2 段目 (vitest --coverage) が CI で
時間を使い切る。1 段目の `bun run test` (全 553 テスト) は 15 秒程度で通る。

このリポジトリの CI は**この問題のせいで一度も緑になったことがなかった**。

## 確定している事実 (すべて CI 実測)

- **ファイル単位で走らせると `todo.test.ts` だけが rc=124**、他 19 件は 0-2 秒。
- coverage step が到達するのは **tail → slack → todo の 3 ファイルまで**。
- 出力は毎回 `withRateLimitRetry` の最後のテスト直後で止まる。
- **同じ 3 ファイルは手元では 5.4 秒**。Node は CI と同じ v24 を使って測定。
- SIGQUIT を送ってもスタックは残らなかった (`Quit (core dumped)` のみ)。

## 検証して**否定された**仮説

| 仮説 | 結果 |
|---|---|
| subprocess 系テストが遅い | ✗ 除外しても CI は hang。ただし 4m40s → 11.7s の実利はあり、修正は残した |
| プロセスが終了しない (handle leak) | ✗ `hanging-process` reporter が何も報告しない。**実行中**に止まっている |
| TTY の有無 | ✗ `< /dev/null` でも 9.9 秒 |
| Node のバージョン差 (26 → 24) | ✗ v24 単体では再現しない。ただし**フルスイートでは効く** (下記) |
| `restoreAllMocks` が本物の sleep を漏らす | △ 実在の問題で修正済み。だが CI の hang は直らなかった |

## 修正済み (副産物だが実利あり)

1. **`coverage.include` が広すぎた**。`ts/**/*.ts` は `ts/cli.ts` (4220 行) まで
   instrument し、`exclude` はレポートから落とすだけだった。
   Node 24 実測: **2m59s → 33s**、カバレッジ数値は 1 桁まで同一。
2. **sleep の stub が describe 単位だった**。`mockRestore()` が後続ブロックに
   本物の sleep を渡し、auth.test 失敗時の retry が実時間を消費していた。
   ファイル単位の `beforeEach` に移動。

## 次に試すべきこと

- `--pool=forks` / `--pool=threads` を切り替える (worker 起動まわりの疑い)
- CI runner のコア数 (2) を `--maxWorkers=1` などで手元に再現する
- istanbul をやめて別の provider を試す (ただし v8 は bun 配下で 0% を返した前科あり)
- そもそも branch coverage 門禁を別の手段で担保できないか

## なぜ諦めて continue-on-error にしたか

`bun run test` が全 553 テストを**硬い門禁として**回している。失われるのは
branch coverage の**閾値チェックだけ**。

一方、赤いままにしておくと全ての PR が「失敗したチェック」を抱えたまま
マージされることになる。**常に赤い CI は読まれなくなる**ので、そちらの方が
実害が大きいと判断した。
