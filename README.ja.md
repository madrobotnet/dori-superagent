<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# dori-superagent

複数セッションのコーディングエージェントを能動的に回すハーネスです。TypeScript 約 1,600 行で、[herdr](https://github.com/herdrdev/herdr) と [omo](https://github.com/code-yeongyu/oh-my-openagent) の上で動きます。

[English](README.md) | [한국어](README.ko.md) | [简体中文](README.zh-CN.md) | 日本語

人と会話するのは lead セッション一つだけです。タスクは一つずつ lane として走ります。lane は専用の herdr タブに立てた omo セッションで、文書化された brief（指示書）から始まり、エビデンス付きの READY で終わります。duty ループは黙り込んだ lane を催促し、lead にエスカレーションし、忙しいペイン宛てのメッセージは読める状態になるまで預かります。マージはゲートを通ります。ゲートが要求するのは、現在の head SHA に対する CLEAR のレビュー記録（receipt）と、グリーンのチェックです。

## なぜ作ったか

DeepSeek が [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) を公開しました（最初のコミットは 2026-10-31）。その約 1 日後に記事 "Exploring Super-agent Design: Towards a More Autonomous Agent System" が出ています。設計は、人とだけ会話して仕事を振り分ける長命の Router セッション、チケットごとに隔離された Worker セッション、ターン単位でまとめて届くイベントトリガー、そして watchdog からなります。README には研究プロトタイプと書かれ、掲げる思想は "take as little human attention as possible, and give as much value as possible"（人の注意は最小限に、価値は最大限に）です。

同じ形のものを、私たちは約半年、公開の場で動かし続けてきました。

- 2026-04-18: omo にチームモードが入りました。ターミナルのペインごとにエージェントセッション一つ、それぞれに worktree 一つです（[f1268c0](https://github.com/code-yeongyu/oh-my-openagent/commit/f1268c0)、[e303fee](https://github.com/code-yeongyu/oh-my-openagent/commit/e303fee)）。
- 2026-05-06: omo の README に Dori の名前が載りました（[#3807](https://github.com/code-yeongyu/oh-my-openagent/pull/3807)）。
- 2026-10-07: このリポジトリが Dori モードを `omo-dori-mode-experimental` として公開しました（[ce53e4d](https://github.com/sisyphuslabs/dori-superagent/commit/ce53e4d)）。一つのエージェントが仕事ごとに herdr タブへ専用のエージェントセッションを立てて任せ、仕事が終わってから初めて閉じます。git の履歴は公開されています。
- 2026-10-31: DeepSeek のプロトタイプに最初のコミット。
- 2026-11-01 ごろ: DeepSeek の記事。

これが私たちの日々の働き方です。omo のスターは 7 万を超えています。2026-10-03 から 2026-11-02 までの 31 日間で、[作者の GitHub コントリビューションカレンダー](https://github.com/code-yeongyu)には 38,656 件のコントリビューションが記録されています。1 日平均で約 1,250 件、ピークは 2026-10-16 の 2,227 件と 2026-10-29 の 2,001 件です。多い日には 1 日 2,000 件前後に達し、これをこのセットアップのフル版で出しています。

このリポジトリのルートにあるハーネスは、その最小版です。herdr と omo だけで動く部分で、ほかには何も付いていません。

## 同じ構造、同じ思想

DeepSeek のプロトタイプのドキュメントと Dori は、構造でも[思想のドキュメント](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)でも、概念が一つずつ対応します。

![Dori vs DeepSeek](docs/dori-vs-deepseek.en.png)

### 構造

| DeepSeek dsh-superagent | Dori |
|---|---|
| Source（GitHub、Feishu） | Dori の居場所はチャットです。Slack、Discord、Telegram |
| Trigger → Eval → Ticket | チャットで頼まれた一つのタスクが、一つのチケットになります |
| チケットごとの Executor セッション（セッション一つ、作業ディレクトリ一つ） | タスクごとにコーディングエージェントのセッション一つ。omo で動き、多数が並列に走ります |
| Channel（元の会話の中で答える。たとえば PR で） | 同じチャンネルに報告します。タスクごとにステータスメッセージは一通で、それをその場で編集し続けます |
| Panel（人の対応が要るものだけを見せる） | チケットボードと Notion は自動で最新に保たれます |

### 思想

| DeepSeek dsh-superagent | Dori |
|---|---|
| 人の注意は最小限に、価値は最大限に | 短いメッセージ、絵文字なし、ping はマージ後に一度だけ |
| 頼まれたとき、または文書化されたチームのルールが許すときだけ動く | 方向性と新しいアイデアは人が出します。誰も頼んでいない仕事を Dori が始めることはありません |
| 人が動かなければならないときだけ話す。質問は一度に一つ | 判断を求めるときは、選択肢、自分の推奨、図を一枚添えます |
| 正直に報告し、ブロックを迂回しない | 証明なしの「done」はありません。実際のケースで検証し、マージ済みの結果を報告します |

Dori の列は、私たちの本番の Dori と Dori モード（`skills/dori-mode`）です。このリポジトリのルートにあるハーネスは、そのうち lane、inbox、duty、マージゲートの部分を herdr + omo の上に実装したものです。

## アーキテクチャ

![architecture](docs/architecture.png)

役割は三つで、それぞれが herdr のペイン内で動く omo セッションです。herdr がワークスペース、タブ、ペインを提供し、ペインの中の omo をエージェントとして認識して、その状態（idle、working、blocked、done）を CLI 経由で返します。dori はペインに何かする前に、必ずこの状態を読みます。

lead は人と会話する唯一のセッションです。依頼を brief に落とし込み、`dori start` で lane を開き、lane からの報告を読み、マージします。

lane は専用の herdr タブに立てた omo セッション一つで、brief 一つの末尾に lane ルール（`prompts/lane-footer.md`）を付けた状態で起動します。途中経過は `dori report` で報告し、`dori ready` で終えます。`dori ready` はエビデンスのリンクなしでは送信を拒否します。

duty ループは `dori duty --interval 60` です。duty 用の omo セッションの隣のペインで動く、ただのプロセスです。tick ごとに、idle になったペインへ溜まったメッセージを流し込み、黙っている lane を催促し、lead にエスカレーションし、ペインが消えた lane を lost 扱いにします。

状態は `~/.dori`（または `$DORI_HOME`）配下の JSON です。`lanes/`、`inbox/`、`briefs/`、`receipts/`、それに 1 時間ループが使う `backlog/` と `loop/`。エージェントのセッションを除けば、ハーネスが増やす常駐プロセスは duty ループと 1 時間ループの 2 つだけで、ランタイム依存は Bun だけです。

![lane lifecycle](docs/lane-flow.png)

`dori start <key> --brief FILE` は、brief と lane ルールを `~/.dori/briefs/<key>.md` に書き、タブを開いて `omo 'Read your brief at <path> and execute it. Your lane key is <key>.'` を実行し、lane を `working` として記録し、lead に `[START <key>]` を送ります。以降、lane は `[REPORT <key>]` で報告し（自分のペインの外でブロックされているときは `[REPORT <key> WAITING]`）、エビデンスのリンクを添えた `[READY <key>]` で終えます。lead はエビデンスを確認し、PR があれば `dori review` と `dori merge` を実行し、`dori done <key>` で lane を閉じます。idle のままの lane は 10 分と 20 分で催促され、40 分で lead にエスカレーションされます（`[ESCALATE <key>]`）。READY の前にペインが消えた lane は `[LOST <key>]` として報告されます。

## DeepSeek の super-agent との対応

| DeepSeek super-agent | dori | このリポジトリでは |
|---|---|---|
| Router セッション: 人と会話し、仕事を振り分ける | LEAD セッション: 人と会話する唯一のセッション。lane を開き、マージする | `prompts/lead.md`、`src/cli.ts` の `up()` |
| Worker セッション、チケットごとに一つ | LANE: タスクごとに omo セッション一つ。専用の herdr タブと専用の brief を持つ | `src/harness.ts` の `startLane()`、`prompts/lane-footer.md` |
| Ticket + Mandate | brief ファイル + lane ルールのフッター、そしてエビデンス必須の READY | `~/.dori/briefs/<key>.md`、`src/harness.ts` の `ready()` |
| トリガーのバッチ化: イベントをターン単位でまとめる | ペインの inbox: 忙しいペイン宛てのメッセージはキューに入り、idle になった時点で一括で届く | `src/harness.ts` の `send()`、`flushInbox()`。`src/store.ts` の `inbox/` |
| Watchdog | DUTY ループ: inbox を流し、10/20 分で催促、40 分でエスカレーション、消えたペインを検知 | `src/harness.ts` の `dutyTick()`、`prompts/duty.md`、`prompts/nudge.md` |
| Admission matrix、`maxWorkers`（デフォルト 3） | 1 時間ループの予算: 開いている lane は `--max-lanes`（デフォルト 3）まで、1 回 `--max-starts`（デフォルト 2）まで、負荷の高いホストでは始めない | `src/loop.ts` の `loopTick()` |
| プロトタイプにはない | ゲート付きマージ: head SHA に厳密に一致する CLEAR の receipt と、グリーンのチェック。空のチェック一覧はグリーン扱いしない | `src/harness.ts` の `review()`、`mergeGate()`、`prompts/review.md`、`src/store.ts` の `receipts/` |
| プロトタイプにはない | 窓口一本化のルール: lane と duty は人に話しかけない | `prompts/lead.md`、`prompts/duty.md`、`prompts/lane-footer.md` |
| プロトタイプにはない | 回答の全文台帳: lane ごとの最終回答、エビデンスのリンク、ログをディスクに保存 | `src/store.ts` の `Lane.final`、`Lane.log` |

## クイックスタート

Bun 1.3 以上、herdr、omo、GitHub CLI の `gh`（PR の head SHA の取得、チェックの確認、マージに使います）が必要です。

```sh
git clone https://github.com/sisyphuslabs/dori-superagent
cd dori-superagent
bun install
bun link   # puts `dori` on your PATH; or write `bun src/cli.ts` wherever `dori` appears below
```

herdr を起動し、シェルから:

```sh
dori up
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 home=~/.dori
```

これで `dori` という名前の herdr ワークスペースが開き、lead ペイン（システムプロンプトに `prompts/lead.md` を追記した omo）、duty ペイン（`prompts/duty.md` を追記した omo）、その下に duty ループ、さらにその下に 1 時間ループが立ちます。話しかける相手は lead ペインです。lead は brief（目標、入力、成果物、終了条件、制約。[`examples/brief.md`](examples/brief.md) を参照）を書いて自分で lane を開きます。同じことはシェルからもできます。

```sh
dori start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p5 brief=~/.dori/briefs/fix-flaky-login.md
dori status
# lead=w1:p1 duty=w1:p2 home=~/.dori
# fix-flaky-login          working  w1:p5    active 0m ago  start: examples/brief.md
```

lane の key は `^[a-z][a-z0-9-]{1,40}$` に一致する必要があり、すでに開いている key は拒否されます。

lane の中では、omo が lane ルールから渡されたコマンドで報告し、仕事を終えます。

```sh
dori report fix-flaky-login --text 'reproduced: 1 failure in 20 runs, shared session fixture'
dori report fix-flaky-login --status waiting --text 'WAITING: checks on owner/repo#12'
dori ready fix-flaky-login --text 'root cause fixed in owner/repo#12, checks green' --evidence https://github.com/owner/repo/pull/12
```

`[READY fix-flaky-login]` を受け取った lead は:

```sh
dori review owner/repo#12            # fresh omo reviewer pinned to the head SHA; writes a receipt; exit 0 on CLEAR
dori merge owner/repo#12 --dry-run   # MERGE_OK ... (dry run), or MERGE_REFUSED <why> with exit 2
dori merge owner/repo#12             # gh pr merge --squash --match-head-commit <sha>
dori done fix-flaky-login            # closes the lane's pane; only a READY lane can be closed
```

`dori send <lead|duty|key|pane> --text '...'` はペインにメッセージを届け、ペインが忙しければキューに入れます。`dori role <lead|duty> [PANE]` は、`dori up` を使わなかったときにペインを手動で登録します。`--text` を省くと stdin からメッセージを読みます。エージェントに見せるコマンドは `src/cli.ts` のフルパスと `DORI_HOME` を埋め込んだ形でレンダリングされるので、エージェント側の PATH に `dori` は要りません。環境変数: `DORI_HOME`（状態ディレクトリ、デフォルト `~/.dori`）、`DORI_AGENT_CMD`（デフォルト `omo`）、`DORI_HERDR_SESSION`（名前付きの herdr セッション）、`DORI_CMD`（エージェントに dori をどう呼ばせるか）。

## ハーネスが強制すること

窓口は一つです。人と会話するセッションは lead だけです（`prompts/lead.md`）。lane ルールは、人に伝えるべき事実をすべて lead に送るよう定めています（`prompts/lane-footer.md` のルール 3）。duty セッションはマージせず、人にも話しかけません（`prompts/duty.md`）。lane の動きはすべてプロンプトとして lead ペインに届きます。`[START]`、`[REPORT]`、`[READY]`、`[LOST]`、`[ESCALATE]`。

READY にはエビデンスが要ります。`dori ready` は、`--evidence` のリンクが一つもないか、最終回答のテキストがなければ拒否します（`src/harness.ts` の `ready()`）。テキストとリンクは lane レコードの `final` に保存され、`dori done` は `ready` でない lane を拒否します。記録された回答なしに閉じる lane はありません。

忙しいペインには割り込みません。`dori send` はまず herdr にペインのエージェント状態を問い合わせます。`idle`、`done`、素のシェルならその場で届け、それ以外は `~/.dori/inbox/` のキューに入れて `QUEUED` と表示します。duty ループはペインが idle になった時点でキューをまとめて一通のメッセージとして届けます。その先頭は "N messages arrived while you were busy" です（`src/harness.ts` の `send()` と `flushInbox()`）。`dori done` も同じ流儀で待ちます。herdr が working または blocked と報告するペインは閉じません。

10 分、20 分、40 分で催促します。`src/harness.ts` の `NUDGE_MINUTES = [10, 20, 40]` です。10 分間報告がなく、ペインも working でない lane は、自分のペインに `prompts/nudge.md` を受け取ります。20 分でもう一度。40 分で duty ループは催促をやめ、lead に `[ESCALATE <key>]` を送ります。`working` のペインはアイドル時間をリセットし、`--status waiting` で報告した lane やペインが `blocked` の lane には触れません。新しい報告があれば催促の回数は 0 に戻り、ペインが消えれば `[LOST <key>]` として報告されます。

マージには、head SHA に厳密に一致する CLEAR の receipt と、グリーンのチェックが要ります。`dori merge` は `gh` で PR の head SHA を読み、その SHA に対する verdict が `CLEAR` の receipt が `~/.dori/receipts/` にあることを要求します。receipt を書くのは `dori review` だけです。`dori review` は、その SHA に固定した `prompts/review.md` で新しい非対話モードの omo（`omo -p --no-session`、必要なら `--model` も）を走らせ、レビュアーが `VERDICT:` 行を出さなければ receipt を書きません。次に `gh pr checks` がチェックを一つ以上返し、すべてのチェックが `pass` か `skipping` で、そのうち一つ以上が `pass` でなければなりません。空のチェック一覧は "an empty check list is never green" と言って拒否します。マージ自体は `gh pr merge --squash --match-head-commit <sha>` です。レビュー後に push すると head SHA が変わり、receipt が一致しなくなるのでマージは拒否されます（`src/harness.ts` の `review()` と `mergeGate()`）。

## 1 時間ループ

`dori up` は 4 つ目のペインで `dori loop` も起動します。1 時間ごとにハーネスの状態を実際と突き合わせ、誰の判断も要らない次の仕事を自分で始めます。次に何をやるかを lead が覚えておく必要はありません。設計の全体は [`docs/hourly-loop.md`](docs/hourly-loop.md) にあります。

仕事は `~/.dori/backlog/` のバックログに、1 項目につき brief 1 つで並びます。lead が追加するか、ラベル付きの開いている GitHub issue を取り込みます。

```sh
dori backlog add search-index --brief briefs/search.md --priority 2
dori backlog add new-billing --brief briefs/billing.md --decision 'シート課金かワークスペース課金か?'
dori backlog import owner/repo --label dori     # p1..p9 ラベルは優先度、needs-decision ラベルは質問
dori backlog list
```

ループはまず関門を見ます。止められているとき、別のループがロックを持っているとき、前回の実行から間隔（デフォルト 1 時間。`--force` ならこの確認を飛ばします）がたっていないときは何もしません。関門を通った実行は、次の 5 つをこの順番で行います。

1. 同期。lane が終わった項目、READY の PR がマージされた項目は done になります。lane が lost になった項目はキューに戻り、2 回失うと質問に変わります。取り込んだ issue が閉じられた項目は外れます。
2. 取りこぼしの点検。3 時間報告のない lane、READY のまま 2 時間誰も閉じていない lane、ペインが消えた lane を拾います。
3. 次の仕事を引く。質問の付いていない開いた項目を、優先度、次に古い順で始めます。開始に 2 回失敗した項目は質問に変わるので、後ろの項目を止めません。開いている lane は `--max-lanes`（デフォルト 3）まで、1 回あたり `--max-starts`（デフォルト 2）までです。1 分間のロードがコア数（または `--max-load`）を超えているか、使えるメモリが 10% を切っていると（macOS では空きページだけだと常に 0 近くになるので、カーネルの利用可能メモリの値を使います）何も始めません。
4. 尋ねる。開いている質問は `[DECIDE <id>]` として lead に 1 回届き、6 時間後に 1 回だけ再送されます。lead が人に尋ね、答えを `dori backlog decide <id> --text '...'` で記録するか（答えは項目の brief の末尾に追記されます）、`dori backlog drop <id>` で外します。
5. 報告。開いている lane の数と上限、バックログの件数、ホストのロードと空きメモリ、見つけたことを `[LOOP ...]` メッセージ 1 つで lead に送ります。関門を通った実行は `~/.dori/loop/runs/` にも記録が残ります。

自分の状態ファイル（バックログ項目、実行記録、ロック）を除けば、ループがするのは lane を開くこととメッセージを送ることだけです。マージ、プッシュ、ペインを閉じることはせず、開いている lane の記録も書き換えません（lost になった項目をやり直すときは同じ key で新しい lane を開きます）。`gh` は読むだけです。緊急停止は `dori loop stop --text '理由'` です。`dori loop resume` までは毎回何もしません。ロックと最終実行の記録があるので、ループが 2 つあっても同じ時間帯を 2 回走ることはなく、cron から `dori loop --once` を併用しても安全です。`dori loop status` は最後の実行を表示します。

## Dori モード（`skills/dori-mode`）

Dori モードはメッセンジャーに面した側の半分で、2026-10-07 にこのリポジトリで公開しました。コーディングエージェントのセッション一つを、メッセンジャー越しに話しかける常駐エージェントに変えます。そのセッションは仕事ごとに herdr タブへ専用のエージェントセッションを立てて任せ、自分が立てたセッションをすべてレジストリに記録し、仕事が終わったと証明できてから初めて閉じます。証明になるのは、マージされた PR、クローズされた issue、公開されたバージョン、または自分で実行できるチェックです。スキル（`skills/dori-mode/SKILL.md` と `references/`）と、同じく `dori` という名前の独自の Bun + TypeScript CLI として配布しています。

```sh
curl -fsSL https://raw.githubusercontent.com/sisyphuslabs/dori-superagent/main/install.sh | bash
```

このスクリプトは、このリポジトリを `~/.dori/src` にクローンし、スキルを `~/.agents/skills/dori-mode` にリンクし、`bun link` で Dori モードの `dori` を PATH に載せ、設定例を `~/.dori/config.json` にコピーします。コマンド、設定、ルーティング、done プロトコルは [`skills/dori-mode/SKILL.md`](skills/dori-mode/SKILL.md) と [`references/`](skills/dori-mode/references/) にあります。

ハーネスと Dori モードは、どちらも `dori` という名前のコマンドを持っています。一台のマシンにはどちらか一方だけを入れるか、ハーネスを `bun src/cli.ts` で呼んで `dori` は Dori モードに譲ってください。ハーネス自身のプロンプトは `src/cli.ts` のフルパスで自分を呼ぶので、ハーネスが立てたエージェントは PATH 上の `dori` がどちらであっても影響を受けません。

## これは何ではないか

最小の実験です。ハーネスは Bun 上の TypeScript 約 1,600 行でランタイム依存はゼロ、私たちの本番スタックではありません。意図して外したもの: マシン間のメッシュ、heavy-slot のスケジューリング、チャットとチケットトラッカーのブリッジ、テストスイート全体に対する receipt。ここにあるのは herdr と omo だけで動く部分です。役割、lane、inbox、duty ループ、1 時間ループとバックログ、レビューとマージのゲート。`skills/dori-mode` の Dori モードは、独自のメッセンジャー部品、ホストガード、heavy-slot ランナーを持つ別の CLI で、ハーネスはそこから何も import しません。

## テレメトリ

dori は omo と同じやり方で匿名の利用回数を送ります。OTLP/HTTP の JSON ログを、omo のコレクター `https://t.omo.dev` に送ります。識別子は `~/.dori/telemetry.json` に置いたランダムなインストール id で、送るのはその sha256 だけです。初回の送信時に、コレクターがそのハッシュからインストールごとの ingest key を発行します（`POST /v1/register`）。key は `~/.dori/telemetry.json` にキャッシュし、コレクターが 401 を返したら発行し直します。コードには共有の key は入っていません。初回の実行では一行の通知を表示します。`DORI_TELEMETRY=0` で止まります（`DO_NOT_TRACK=1` でも止まります）。`DORI_TELEMETRY_ENDPOINT` でコレクターの URL を差し替えられます。

| イベント | いつ | フィールド |
|---|---|---|
| `dori.installed` | 初回の実行 | なし |
| `dori.daily_active` | どの dori コマンドでも、UTC の一日に一回 | `day_utc` |
| `dori.lane_started` | `dori start` | `open_lanes` |
| `dori.lane_ready` | `dori ready` | `evidence_count`、`lane_minutes` |
| `dori.review_completed` | `dori review` | `verdict`: `CLEAR` または `BLOCK` |
| `dori.merge_decided` | `--dry-run` なしの `dori merge` | `outcome`: `merged`、`no_receipt`、`review_block`、`no_checks`、`checks_red`、`checks_all_skipped` |
| `dori.duty_summary` | duty ループから一時間に最大一回 | `ticks`、`flushed`、`nudges`、`escalations`、`lost` |

日次、週次、月次のアクティブ数は `dori.daily_active` から数えます。アクティブ数はインストール単位で数えるので、同時に起動した二つの実行がまれに二回送っても数は変わりません。どのレコードにもリソースフィールドが付きます。サービス名とバージョン、インストールのハッシュ、CI フラグ、OS の種類（`darwin`、`linux`、`windows` のいずれか。それ以外の OS では何も送りません）とバージョン、CPU アーキテクチャです。パス、リポジトリ名、PR 番号、lane の key、brief、メッセージ、その他のテキストは一切送りません。送信はバックグラウンドで行い、リクエストごとのタイムアウトは 2 秒です。コマンドは終了前に最大 2 秒だけ待ち、テレメトリが失敗してもコマンドは失敗しません。

## テスト

リポジトリのルートで `bun test ./test/` を実行すると、ハーネスの 57 個のテストが走ります。モデルは呼びません。素の `bun test` だと Dori モードのテストも拾います。

ハーネスのユニットテスト 8 個（`test/harness.test.ts`）は偽の herdr（`test/fake.ts`）に対して走ります。`herdr` と `gh` のバイナリの代わりを務めるレコーダーで、エージェント状態を設定できるペインを持ち、テストから進められる時計を持っています。カバーするのは、lane の開始と READY、忙しい lead に対するキューと一括配信、未知の宛先の拒否、10 分と 20 分の催促と 40 分のエスカレーションと WAITING の lane の放置、working と lost の状態、マージゲートの全分岐（receipt なし、BLOCK、空のチェック一覧、赤いチェック、全部スキップ、CLEAR とグリーン）、そして VERDICT 行のないレビュアーです。

さらにユニットテスト 19 個（`test/loop.test.ts`）が、同じ偽物の上で 1 時間ループを動かします。バックログの追加、決定、外す、取り込み、開始の順番と予算、lane が埋まっている・ホストが忙しい・質問が付いているときの保留、done・lost・マージ済みの lane の同期、取りこぼしの点検、質問ごとに 1 回尋ねて 1 回だけ再送、緊急停止、生きている・死んでいる・壊れたロック、実行中に奪われたロック、戻せずに脇に残したロック、lane 開始の失敗、開始が失敗し続けて質問に変わる項目、実行と実行の間の待ち時間、開いたのに lead へ知らせられなかった lane、バックログのフォルダから出ようとする id、消えた lane の記録、同じミリ秒の 2 回の実行です。そのうち 2 個はループがペインの close、merge、push を一度も送らないことを確かめ、点検のテストは lane の記録がバイト単位で変わらないことも確かめます。

テレメトリのユニットテスト 11 個（`test/telemetry.test.ts`）は、オプトアウト、初回の通知と一日一回の `dori.daily_active`、インストールごとの key が一度だけ発行されてキャッシュされ 401 の後に発行し直されること、登録済みのスキーマに合うペイロード（scope の名前とバージョン、許可されたリソースキーのみ、回数のみ）、コレクターが 200 応答の中で拒否したレコード（`partialSuccess.rejectedLogRecords`）を数えること、一時間ごとの duty サマリー、オフラインの初回実行でも送信が成功するまで `dori.installed` と `dori.daily_active` を保留すること、状態ファイルの権限が 0600 で壊れた状態ファイルでも throw しないこと、呼び出しがすぐ戻り flush が期限で諦めること、同じホームで同時に始まった二つの初回実行が一つのインストール id を共有すること、そしてコレクターに届かないか登録を拒否されても throw せずログも送らないことを確認します。

エンドツーエンドテスト 2 個（`test/e2e.test.ts`）のうち 1 個目は、隔離した名前付きセッションで本物の herdr サーバーを起動し、ワークスペースを作り、lead ペインを登録して、omo の代わりに `test/fixtures/fake-agent.sh` をエージェントにした lane を開始します。このスクリプトは brief を読んで `dori report` と `dori ready` を呼び、テストは `[START]`、`[REPORT]`、`[READY]` が lead ペインに届くことと、`dori done` が lane を閉じることを確認します。2 個目はバックログに項目を足して `dori loop --once` を実行し、ループが始めた lane が READY まで行くこと、`[LOOP ...]` が lead ペインに届くこと、`dori loop stop` の後の実行が何もしないことを確認します。どちらも PATH に `herdr` がなければスキップされ、`DORI_TELEMETRY=0` で走ります。`bun run typecheck` は `tsc --noEmit` を実行します。

Dori モードには、偽の herdr、git、gh に対する独自のテストが 233 個あります。

```sh
cd skills/dori-mode/scripts && bun install && bun test
```

## ライセンス

MIT です。[LICENSE](LICENSE) を参照してください。
