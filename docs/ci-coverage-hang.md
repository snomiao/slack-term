# CI の coverage step が hang していた件 — 調査記録

**状態: 解決 (2026-08-31)。** 原因は `tests/todo.test.ts` の 1 行、
テスト用の「書き込めないパス」に `/proc` 配下を指定していたこと。
coverage step は `continue-on-error` を外し、硬い門禁に戻した。

## 真の原因

```js
// tests/todo.test.ts — "an unwritable cache path is swallowed"
vi.spyOn(cacheMod._internals, "path").mockReturnValue("/proc/definitely/not/writable/cache.json");
```

`ts/cache.ts` の `persist()` は書き込み前に
`mkdirSync(dirname(path), { recursive: true })` を呼ぶ。

**Linux では `/proc` 配下の `mkdir` が EACCES でも EPERM でもなく ENOENT を返す**
(`/proc` 自体は存在するのに、である)。node の再帰 mkdirp は ENOENT を
「親がまだ無い」と解釈して親を積むので、次のように往復し続ける:

    mkdir /proc/definitely/not/writable  -> ENOENT  -> 親を積む
    mkdir /proc/definitely/not           -> ENOENT  -> 親を積む
    mkdir /proc/definitely               -> ENOENT  -> 親を積む
    mkdir /proc                          -> EEXIST  -> 進む
    mkdir /proc/definitely               -> ENOENT  -> 親を積む   … 無限

**native コード内の同期ループ**なので:

- worker は `S (sleeping)` ではなく **`R (running)`** で CPU を焼き続ける
- `testTimeout` / `hookTimeout` / `teardownTimeout` はどれも発火しない
  (イベントループに戻らないため)
- isolate を interrupt できないので **SIGUSR2 を送っても診断レポートすら出ない**

**macOS で再現しなかった理由** (両 OS で実測):

    Linux : mkdir("/proc")            -> EEXIST   ← 「親は作れた」と解釈され前進する
            mkdir("/proc/definitely") -> ENOENT   ← しかし子は永久に作れない  = 無限往復
    macOS : mkdir("/proc")            -> EROFS    ← /proc 自体が無く、作ることもできない
            再帰呼び出し全体          -> ENOENT を 0ms で返して終了

つまり **「親は存在するのに子を作れず、しかもその失敗が ENOENT」** という
`/proc` 固有の組み合わせが罠だった。macOS には `/proc` が無いので成立しない。
**この errno の差が local と CI の全ての違い**である。

コンテナでの最小再現:

```
$ docker run --rm --user 1000:1000 node:22-slim \
    node -e 'require("fs").mkdirSync("/proc/definitely/not/writable",{recursive:true})'
   -> 返ってこない

$ ... node -e 'require("fs").mkdirSync("/root/x/y",{recursive:true})'
   -> EACCES 0ms   (EACCES 一般の問題ではない。/proc 固有)
```

## 修正

親を**ファイル**にして `ENOTDIR` を起こす形に変えた。全 OS・全 uid (root 含む)
で決定的に即座に失敗する。

```js
writeFileSync(join(dir, "not-a-dir"), "x");
vi.spyOn(cacheMod._internals, "path").mockReturnValue(join(dir, "not-a-dir", "sub", "cache.json"));
```

## どう突き止めたか (再現しない CI hang の手順として残す)

1. **runner 上で hang 中のプロセスの状態を見る**。`ps -eo stat,wchan` で
   親は `ep_poll` で待機、worker は **`R`** と判明 → deadlock ではなく **spin**。
   さらに SIGUSR2 に応答しない → **native の非中断ループ**まで絞れた。
2. **`-t <describe 名>` で describe 単位に別プロセスで実行**。
   `cache` だけ rc=137、他 7 ブロックは 1 秒以下。
3. `-t "存在しない名前"` が rc=0 → module 評価ではなく**テスト本体**の問題。
4. `cache` 内で唯一 OS 依存なのが `/proc` パス。**docker で単独再現**。

**効いた計測**: 「ローカルで速くなった」は証拠にならない。
**CI の停止位置が動いたか**だけが証拠になる。

## 副次的に直したもの (実測値つき)

1. **`coverage.include` が広すぎた** — istanbul が `ts/cli.ts` (4220 行) を
   毎回 instrument して結果を捨てていた。Node 24 で **2m59s → 33s**。
2. **mock server の teardown が無限待ち** — `closeAllConnections` は optional で、
   届かない socket があると `server.close()` の callback が永久に来ない。
   2 秒の上限を追加。**これで CI の停止位置が初めて動いた**
   (slack.test.ts → todo.test.ts)。
3. backoff が test 実行時に実時間を待たない guard。

## 否定された仮説 (再検証しないこと)

    subprocess 系テストが遅い       -> 除外しても hang (別途 4m40s→11.7s の実利はあり)
    プロセスが終了しない            -> hanging-process reporter が何も報告しない
    TTY の有無                      -> < /dev/null でも変わらず
    Node のバージョン差             -> runner は 22。macOS の 22/24/26 では全て 1-2 秒
    fork pool の worker 起動        -> --maxWorkers=1 でも、--pool=threads でも hang
    sleep stub の restore 漏れ      -> guard を入れても直らず
    harness の top-level await      -> 静的 import にしても直らず
    worker の共有 / ファイル間干渉  -> 単独実行でも hang
    dynamic import の deadlock      -> vitest.config.ts に書かれていたが誤り

**注意**: 「runner は Node 24」と config のコメントに書かれていたが、
実際は **22.23.2** だった。この誤った前提のせいでローカル比較が全て
的外れになっていた。runner 上で `node -v` を実行するまで気づけなかった。
