# CI の coverage step が hang する件 — 調査記録

**状態: 部分的に解決 (2026-08-31)。** 大きな遅さは 2 件 直したが、
**`tests/todo.test.ts` が CI でのみ wedge する**現象は未解決で、
coverage step は `continue-on-error` のまま。

## 直したもの (実測値つき)

1. **`coverage.include` が広すぎた** — istanbul が `ts/cli.ts` (4220 行) を
   毎回 instrument して結果を捨てていた。Node 24 で **2m59s → 33s**。
2. **mock server の teardown が無限待ち** — `closeAllConnections` は optional で、
   届かない socket があると `server.close()` の callback が永久に来ない。
   2 秒の上限を追加。**これで CI の停止位置が初めて動いた**
   (slack.test.ts → todo.test.ts)。

副産物として、backoff が test 実行時に実時間を待たない guard も入れた
(CI 実測で有効: vitest worker 内 `VITEST='true'`、`sleep(4000)` の実経過 0ms)。

## 未解決: todo.test.ts が CI でのみ wedge する

**切り分け済みの事実:**

    CI で単独実行 (clean process, coverage 無し, verbose)  -> hang
    同じコマンドをローカル Node 24 で実行                    -> 1-2 秒で完走
    CI=true + TTY 無しでローカル再現                        -> 1 秒で完走
    他 11 ファイル                                          -> すべて 1 秒未満

つまり **worker の共有でも、coverage の instrument でも、他ファイルとの
相互作用でもない。ファイル単体の問題で、かつ GitHub runner 上でしか出ない。**

stderr は `withRateLimitRetry` の 4 テストまで出力され、そこで止まる。
ただし vitest 4 の `--reporter=verbose` は個別テスト行を出さないため、
「どのテストまで通ったか」は stderr の順序からの推定に留まる。

**次に試すべきこと:**

- `tmate` 等で runner に入り、hang 中のプロセスの stack を直接取る
- `todo.test.ts` を分割し、どの describe が原因かを CI 上で二分探索する
- vitest を 4.x 以外に上げ下げして再現するか見る

## `continue-on-error` にした理由 (excluding ではなく)

`todo.test.ts` を除外すると lines 99.6% → **84.9%**、branches → **72.6%** に
落ちる。閾値を実力より下げることになり、**「守られているように見えて実は
緩い門禁」は、明示的に advisory な門禁より悪い。**

`bun run test` は 580 テスト全部を**硬い門禁**として回し続けている。
失われているのは coverage の閾値チェックだけ。

## 否定された仮説 (再検証しないこと)

    subprocess 系テストが遅い       -> 除外しても CI は hang (別途 4m40s→11.7s の実利はあり)
    プロセスが終了しない            -> hanging-process reporter が何も報告しない
    TTY の有無                      -> < /dev/null でも変わらず
    Node のバージョン差 (26 vs 24)  -> 24 でもローカルは 1-2 秒
    fork pool の worker 起動        -> --maxWorkers=1 で CI は直らず
    sleep stub の restore 漏れ      -> guard を入れても CI は直らず
    harness の top-level await      -> 静的 import にしても直らず
    worker の共有 / ファイル間干渉  -> 単独実行でも hang

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
