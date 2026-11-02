<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# dori-superagent

코딩 에이전트 세션 여러 개를 능동적으로 굴리는 하네스입니다. TypeScript 약 1,600줄이고, [herdr](https://github.com/herdrdev/herdr)와 [omo](https://github.com/code-yeongyu/oh-my-openagent) 위에서 돕니다.

[English](README.md) | 한국어 | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

사람과 이야기하는 세션은 리드 하나입니다. 작업은 하나하나 레인(lane)으로 돌아갑니다. 레인은 자기 herdr 탭에 뜬 omo 세션 하나로, 글로 쓴 브리프를 받아 시작하고 증거가 붙은 READY로 끝납니다. 듀티(duty) 루프는 조용해진 레인을 찔러 보고, 그래도 안 되면 리드에게 올리고, 바쁜 pane에 갈 메시지는 읽을 수 있을 때까지 들고 있습니다. 머지는 게이트를 지나는데, 게이트가 요구하는 것은 정확히 그 head에서 받은 CLEAR 리뷰 영수증과 녹색 체크입니다.

## 왜 만들었나

DeepSeek이 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)을 공개했습니다(첫 커밋 2026-10-31). 하루쯤 지나 "Exploring Super-agent Design: Towards a More Autonomous Agent System"이라는 글도 냈습니다. 글에 나온 설계는 사람하고만 대화하고 일을 나눠 주는 오래 사는 Router 세션, 티켓마다 하나씩 격리된 Worker 세션, 턴마다 묶어서 처리하는 이벤트 트리거, 그리고 watchdog입니다. README에는 리서치 프로토타입이라고 적혀 있고, 내건 철학은 "take as little human attention as possible, and give as much value as possible"입니다.

같은 구조를 저희는 여섯 달쯤 전부터 공개된 자리에서 돌려 왔습니다.

- 2026-04-18: omo에 팀 모드가 들어갔습니다. 터미널 pane마다 에이전트 세션 하나, 세션마다 worktree 하나입니다([f1268c0](https://github.com/code-yeongyu/oh-my-openagent/commit/f1268c0), [e303fee](https://github.com/code-yeongyu/oh-my-openagent/commit/e303fee)).
- 2026-05-06: Dori라는 이름이 omo README에 올라갔습니다([#3807](https://github.com/code-yeongyu/oh-my-openagent/pull/3807)).
- 2026-10-07: 이 저장소가 `omo-dori-mode-experimental`이라는 이름으로 Dori 모드를 공개했습니다([ce53e4d](https://github.com/sisyphuslabs/dori-superagent/commit/ce53e4d)). 에이전트 하나가 일마다 herdr 탭에 에이전트 세션을 따로 띄워 맡기고, 일이 끝나야 닫습니다. git 히스토리가 공개돼 있습니다.
- 2026-10-31: DeepSeek 프로토타입의 첫 커밋.
- 2026-11-01 무렵: DeepSeek의 글.

매일 이렇게 일합니다. omo는 star가 7만 개를 넘었습니다. 2026-10-03부터 2026-11-02까지 31일 동안 [작성자의 GitHub 기여 그래프](https://github.com/code-yeongyu)에 찍힌 contribution은 38,656건입니다. 하루 평균 약 1,250건이고, 최고치는 2026-10-16의 2,227건과 2026-10-29의 2,001건입니다. 하루에 많게는 2,000건 가까이이고, 이 셋업의 풀 버전으로 낸 숫자입니다.

이 저장소 루트의 하네스는 그 최소 버전입니다. herdr와 omo만으로 돌아가는 부분만 있고, 다른 것은 붙이지 않았습니다.

## 같은 구조, 같은 철학

DeepSeek 프로토타입의 문서를 Dori 옆에 놓으면 개념이 하나하나 맞물립니다. 파이프라인 구조가 그렇고, [철학 문서](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)의 규칙도 그렇습니다.

![Dori vs DeepSeek](docs/dori-vs-deepseek.ko.png)

### 구조

| DeepSeek dsh-superagent | Dori |
|---|---|
| Source: GitHub, Feishu | Dori는 채팅에 삽니다. Slack, Discord, Telegram |
| Trigger, Eval, Ticket 순서 | 채팅에서 부탁한 일 하나가 티켓 하나가 됩니다 |
| 티켓마다 Executor 세션 하나: 세션 하나, 작업 디렉터리 하나 | 작업마다 코딩 에이전트 세션 하나. omo 위에서 돌고, 여러 개가 병렬로 돕니다 |
| Channel: 원래 대화에 답함, 예를 들어 PR로 | 같은 채널에 보고합니다. 작업당 상태 메시지 하나를 제자리에서 고쳐 씁니다 |
| Panel: 사람이 봐야 할 것만 보여 줌 | 티켓 보드와 Notion이 알아서 최신 상태를 유지합니다 |

### 철학

| DeepSeek dsh-superagent | Dori |
|---|---|
| 사람의 주의는 최소로, 가치는 최대로 | 짧은 메시지, 이모지 없음, 핑은 머지 뒤에 한 번 |
| 부탁받았거나 글로 적힌 팀 규칙이 허용할 때만 움직임 | 방향과 새 아이디어는 사람이 정합니다. 아무도 시키지 않은 일을 Dori가 시작하지는 않습니다 |
| 사람이 움직여야 할 때만 말하고, 질문은 한 번에 하나 | 결정 요청에는 선택지, Dori의 추천, 그림 한 장이 같이 갑니다 |
| 정직하게 보고하고, 막힌 것을 우회하지 않음 | 증거 없는 'done'은 없습니다. 실제 사례로 확인하고, 머지된 결과를 보고합니다 |

Dori 열은 저희가 실제로 굴리는 프로덕션 Dori와 Dori 모드(`skills/dori-mode`)입니다. 이 저장소 루트의 하네스는 그중 레인, 인박스, 듀티, 머지 게이트 부분을 herdr와 omo 위에 구현합니다.

## 아키텍처

![architecture](docs/architecture.png)

역할은 셋이고, 각각 herdr pane 하나에 뜬 omo 세션입니다. herdr가 워크스페이스, 탭, pane을 만들어 주고, pane 안의 omo를 에이전트로 알아보고, 그 상태(idle, working, blocked, done)를 CLI로 알려 줍니다. dori는 pane에 무엇을 하든 그 전에 이 상태부터 읽습니다.

리드는 사람과 대화하는 유일한 세션입니다. 요청을 브리프로 바꾸고, `dori start`로 레인을 열고, 레인이 보내오는 것을 읽고, 머지합니다.

레인은 자기 herdr 탭에 뜬 omo 세션 하나입니다. 브리프 하나에 레인 규칙(`prompts/lane-footer.md`)을 덧붙여서 시작합니다. 중간 결과는 `dori report`로 보고하고 `dori ready`로 끝내는데, `dori ready`는 증거 링크가 없으면 나가지 않습니다.

듀티 루프는 `dori duty --interval 60`입니다. 듀티 omo 세션 옆 pane에서 도는 보통 프로세스입니다. 틱마다 idle이 된 pane에 쌓인 메시지를 밀어 넣고, 조용한 레인을 찔러 보고, 리드에게 올리고, pane이 사라진 레인은 lost로 표시합니다.

상태는 `~/.dori`(또는 `$DORI_HOME`) 아래 JSON입니다. `lanes/`, `inbox/`, `briefs/`, `receipts/`, 그리고 한 시간 루프가 쓰는 `backlog/`와 `loop/`. 에이전트 세션을 빼면 하네스가 더하는 상주 프로세스는 듀티 루프와 한 시간 루프 둘뿐이고, 런타임 의존성은 Bun 하나뿐입니다.

![lane lifecycle](docs/lane-flow.png)

`dori start <key> --brief FILE`은 브리프와 레인 규칙을 `~/.dori/briefs/<key>.md`에 쓰고, 탭을 열고, `omo 'Read your brief at <path> and execute it. Your lane key is <key>.'`를 실행하고, 레인을 `working`으로 기록하고, 리드에게 `[START <key>]`를 보냅니다. 그다음부터 레인은 보고하고(`[REPORT <key>]`, 자기 pane 바깥의 무언가에 막혔으면 `[REPORT <key> WAITING]`), 증거 링크를 붙인 `[READY <key>]`로 끝냅니다. 리드는 증거를 확인하고, PR이 있으면 `dori review`와 `dori merge`를 돌리고, `dori done <key>`로 레인을 닫습니다. 가만히 있는 레인은 10분과 20분에 nudge를 받고 40분에 리드로 올라갑니다(`[ESCALATE <key>]`). READY 전에 pane이 사라진 레인은 `[LOST <key>]`로 보고됩니다.

## DeepSeek super-agent 대응표

| DeepSeek super-agent | dori | 이 저장소에서 |
|---|---|---|
| Router 세션: 사람과 대화하고 일을 나눠 줌 | LEAD 세션: 사람과 대화하는 유일한 세션. 레인을 열고 머지함 | `prompts/lead.md`, `src/cli.ts`의 `up()` |
| Worker 세션, 티켓마다 하나 | LANE: 작업마다 omo 세션 하나. 자기 herdr 탭과 자기 브리프 | `src/harness.ts`의 `startLane()`, `prompts/lane-footer.md` |
| Ticket + Mandate | 브리프 파일 + 레인 규칙 푸터, 그리고 증거가 꼭 붙어야 하는 READY | `~/.dori/briefs/<key>.md`, `src/harness.ts`의 `ready()` |
| 트리거 배칭: 이벤트를 턴마다 묶음 | pane 인박스: 바쁜 pane에 보낸 메시지는 큐에 쌓였다가 idle이 되면 한 묶음으로 도착 | `src/harness.ts`의 `send()`, `flushInbox()`; `src/store.ts`의 `inbox/` |
| Watchdog | DUTY 루프: 인박스를 비우고, 10/20분에 nudge, 40분에 리드로 올리고, 사라진 pane 감지 | `src/harness.ts`의 `dutyTick()`, `prompts/duty.md`, `prompts/nudge.md` |
| Admission matrix, `maxWorkers`(기본 3) | 한 시간 루프 예산: 열린 레인 `--max-lanes`(기본 3)개, 한 번에 `--max-starts`(기본 2)개, 부하가 큰 호스트에서는 시작 안 함 | `src/loop.ts`의 `loopTick()` |
| 프로토타입에 없음 | 게이트 머지: 정확한 head SHA의 CLEAR 리뷰 영수증 + 녹색 체크. 빈 체크 목록은 녹색이 아님 | `src/harness.ts`의 `review()`, `mergeGate()`, `prompts/review.md`, `src/store.ts`의 `receipts/` |
| 프로토타입에 없음 | 한 목소리 규칙: 레인과 듀티는 사람과 대화하지 않음 | `prompts/lead.md`, `prompts/duty.md`, `prompts/lane-footer.md` |
| 프로토타입에 없음 | 답변 전문 장부: 레인마다 최종 답변, 증거 링크, 로그를 디스크에 보관 | `src/store.ts`의 `Lane.final`, `Lane.log` |

## 빠른 시작

Bun 1.3 이상, herdr, omo, 그리고 GitHub CLI `gh`가 필요합니다. `gh`는 PR의 head SHA와 체크를 읽고 머지할 때 씁니다.

```sh
git clone https://github.com/sisyphuslabs/dori-superagent
cd dori-superagent
bun install
bun link   # puts `dori` on your PATH; or write `bun src/cli.ts` wherever `dori` appears below
```

herdr를 띄운 다음 셸에서:

```sh
dori up
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 home=~/.dori
```

`dori`라는 herdr 워크스페이스가 열립니다. 리드 pane(시스템 프롬프트 뒤에 `prompts/lead.md`를 붙인 omo), 듀티 pane(`prompts/duty.md`를 붙인 omo), 그 아래 듀티 루프, 또 그 아래 한 시간 루프입니다. 리드 pane에 말을 걸면 됩니다. 리드가 브리프(목표, 입력, 결과물, 종료 조건, 제약. [`examples/brief.md`](examples/brief.md) 참고)를 쓰고 레인을 직접 엽니다. 셸에서 열어도 됩니다.

```sh
dori start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p5 brief=~/.dori/briefs/fix-flaky-login.md
dori status
# lead=w1:p1 duty=w1:p2 home=~/.dori
# fix-flaky-login          working  w1:p5    active 0m ago  start: examples/brief.md
```

레인 키는 `^[a-z][a-z0-9-]{1,40}$`에 맞아야 하고, 이미 열린 키는 거절됩니다.

레인 안의 omo는 레인 규칙이 건네준 명령으로 보고하고 끝냅니다.

```sh
dori report fix-flaky-login --text 'reproduced: 1 failure in 20 runs, shared session fixture'
dori report fix-flaky-login --status waiting --text 'WAITING: checks on owner/repo#12'
dori ready fix-flaky-login --text 'root cause fixed in owner/repo#12, checks green' --evidence https://github.com/owner/repo/pull/12
```

리드는 `[READY fix-flaky-login]`을 받으면:

```sh
dori review owner/repo#12            # fresh omo reviewer pinned to the head SHA; writes a receipt; exit 0 on CLEAR
dori merge owner/repo#12 --dry-run   # MERGE_OK ... (dry run), or MERGE_REFUSED <why> with exit 2
dori merge owner/repo#12             # gh pr merge --squash --match-head-commit <sha>
dori done fix-flaky-login            # closes the lane's pane; only a READY lane can be closed
```

`dori send <lead|duty|key|pane> --text '...'`는 pane에 메시지를 전달하고, pane이 바쁘면 큐에 넣습니다. `dori role <lead|duty> [PANE]`은 `dori up`을 쓰지 않았을 때 pane을 손으로 등록합니다. `--text`를 빼면 stdin에서 읽습니다. 에이전트가 보는 명령은 `src/cli.ts`의 전체 경로와 `DORI_HOME`이 채워진 채로 렌더링되므로, 에이전트의 PATH에 `dori`가 없어도 됩니다. 환경 변수는 `DORI_HOME`(상태 디렉터리, 기본 `~/.dori`), `DORI_AGENT_CMD`(기본 `omo`), `DORI_HERDR_SESSION`(이름 붙인 herdr 세션), `DORI_CMD`(에이전트에게 알려 줄 dori 호출법)입니다.

## 하네스가 강제하는 것

목소리는 하나입니다. 사람과 대화하는 세션은 리드뿐입니다(`prompts/lead.md`). 레인 규칙은 사람에게 갈 사실을 전부 리드로 보내라고 하고(`prompts/lane-footer.md` 3번 규칙), 듀티 세션은 머지도 하지 않고 사람과 대화도 하지 않습니다(`prompts/duty.md`). 레인이 하는 일은 전부 리드 pane에 프롬프트로 들어갑니다. `[START]`, `[REPORT]`, `[READY]`, `[LOST]`, `[ESCALATE]`.

READY에는 증거가 붙어야 합니다. `dori ready`는 `--evidence` 링크가 하나도 없거나 최종 답변 텍스트가 없으면 거절합니다(`src/harness.ts`의 `ready()`). 텍스트와 링크는 레인 레코드에 `final`로 저장되고, `dori done`은 `ready`가 아닌 레인을 거절합니다. 그래서 답변이 기록되지 않은 채 닫히는 레인은 없습니다.

바쁜 pane은 건드리지 않습니다. `dori send`는 먼저 herdr에 그 pane의 에이전트 상태를 묻습니다. `idle`, `done`, 아니면 그냥 셸이면 바로 전달하고, 그 밖의 상태면 `~/.dori/inbox/`에 큐로 넣고 `QUEUED`를 출력합니다. pane이 idle이 되면 듀티 루프가 큐를 메시지 하나로 전달하는데, 그 메시지는 "N messages arrived while you were busy"로 시작합니다(`src/harness.ts`의 `send()`와 `flushInbox()`). `dori done`도 같은 식으로 기다립니다. herdr가 working이나 blocked라고 하는 pane은 닫지 않습니다.

nudge는 10분, 20분, 40분입니다. `src/harness.ts`의 `NUDGE_MINUTES = [10, 20, 40]`입니다. 10분 동안 보고가 없고 pane도 working이 아닌 레인은 자기 pane에 `prompts/nudge.md`를 받습니다. 20분에 한 번 더 받습니다. 40분이 되면 듀티 루프는 nudge를 그만두고 리드에게 `[ESCALATE <key>]`를 보냅니다. `working`인 pane은 idle 시계가 되돌아가고, `--status waiting`으로 보고했거나 pane이 `blocked`인 레인은 건드리지 않고, 새 보고가 오면 nudge 횟수가 0으로 돌아가고, pane이 사라지면 `[LOST <key>]`로 보고됩니다.

머지에는 정확한 head의 CLEAR 영수증과 녹색 체크가 필요합니다. `dori merge`는 `gh`로 PR의 head SHA를 읽고, 그 SHA에 대한 영수증이 `~/.dori/receipts/`에 verdict `CLEAR`로 있어야 넘어갑니다. 영수증을 쓰는 것은 `dori review`뿐입니다. `dori review`는 그 SHA에 고정한 `prompts/review.md`로 새 비대화형 omo(`omo -p --no-session`, 필요하면 `--model`)를 돌리고, 리뷰어가 `VERDICT:` 줄을 출력하지 않으면 영수증을 쓰지 않습니다. 그다음 `gh pr checks`가 체크를 하나 이상 돌려줘야 하고, 모든 체크가 `pass`나 `skipping`이어야 하고, 그중 하나 이상은 `pass`여야 합니다. 빈 체크 목록은 "an empty check list is never green"으로 거절합니다. 머지 자체는 `gh pr merge --squash --match-head-commit <sha>`입니다. 리뷰 뒤에 push가 들어오면 head SHA가 바뀌어 영수증이 맞지 않게 되고, 머지는 거절됩니다(`src/harness.ts`의 `review()`와 `mergeGate()`).

## 한 시간 루프

`dori up`은 네 번째 pane에서 `dori loop`도 띄웁니다. 한 시간마다 하네스 상태를 실제와 맞춰 보고, 누구의 결정도 필요 없는 다음 일을 직접 시작합니다. 리드가 다음 할 일을 기억하고 있지 않아도 됩니다. 전체 설계는 [`docs/hourly-loop.md`](docs/hourly-loop.md)에 있습니다.

할 일은 `~/.dori/backlog/`의 백로그에 항목당 브리프 하나로 쌓입니다. 리드가 넣거나, 라벨이 붙은 열린 GitHub 이슈를 가져옵니다.

```sh
dori backlog add search-index --brief briefs/search.md --priority 2
dori backlog add new-billing --brief briefs/billing.md --decision '좌석 과금이야, 워크스페이스 과금이야?'
dori backlog import owner/repo --label dori     # p1..p9 라벨은 우선순위, needs-decision 라벨은 질문
dori backlog list
```

루프는 먼저 관문을 봅니다. 멈춰 있거나, 다른 루프가 잠금을 쥐고 있거나, 마지막 실행에서 간격(기본 한 시간, `--force`면 이 확인을 건너뜀)이 안 지났으면 아무것도 하지 않습니다. 관문을 통과한 실행은 다음 다섯 가지를 순서대로 합니다.

1. 동기화. 레인이 끝났거나 READY의 PR이 머지된 항목은 done이 됩니다. 레인이 lost된 항목은 다시 큐로 돌아가고, 두 번 잃으면 질문으로 바뀝니다. 가져온 이슈가 닫힌 항목은 빠집니다.
2. 놓친 일 점검. 3시간째 보고가 없는 레인, READY인데 2시간째 아무도 닫지 않은 레인, pane이 사라진 레인을 찾습니다.
3. 다음 일 당기기. 질문이 걸리지 않은 열린 항목을 우선순위, 그다음 오래된 순으로 시작합니다. 시작이 두 번 실패한 항목은 질문으로 바뀌어서 뒤의 항목을 막지 않습니다. 열린 레인은 `--max-lanes`(기본 3)개까지, 한 번에 `--max-starts`(기본 2)개까지입니다. 1분 부하가 코어 수(또는 `--max-load`)를 넘거나 쓸 수 있는 메모리가 10% 밑이면(macOS에서는 빈 페이지만 세면 늘 0에 가까워서 커널의 가용 메모리 수준을 씁니다) 아무것도 시작하지 않습니다.
4. 묻기. 열린 질문은 `[DECIDE <id>]`로 리드에게 한 번 가고, 6시간 뒤에 한 번만 다시 갑니다. 리드가 사람에게 묻고, 답을 `dori backlog decide <id> --text '...'`로 남기거나(답은 항목 브리프 끝에 붙습니다) `dori backlog drop <id>`로 뺍니다.
5. 보고. 열린 레인 수와 한도, 백로그 개수, 호스트 부하와 남은 메모리, 찾은 것들을 `[LOOP ...]` 메시지 하나로 리드에게 보냅니다. 관문을 통과한 실행은 `~/.dori/loop/runs/`에도 기록이 남습니다.

자기 상태 파일(백로그 항목, 실행 기록, 잠금)을 빼면 루프는 레인을 열고 메시지를 보내는 일만 합니다. 머지, 푸시, pane 닫기는 하지 않고, 열린 레인의 기록도 고치지 않습니다(lost된 항목을 다시 하면 같은 키로 새 레인을 엽니다). `gh`는 읽기만 합니다. 긴급 정지는 `dori loop stop --text '이유'`입니다. `dori loop resume` 전까지 루프는 아무것도 하지 않습니다. 잠금과 마지막 실행 기록이 있어서 루프 두 개가 같은 시간대를 두 번 돌지 않고, cron에서 `dori loop --once`를 같이 돌려도 안전합니다. `dori loop status`는 마지막 실행을 보여 줍니다.

## Dori 모드(`skills/dori-mode`)

Dori 모드는 메신저 쪽 절반으로, 2026-10-07에 이 저장소에서 공개됐습니다. 코딩 에이전트 세션 하나를 메신저로 말을 거는, 늘 켜져 있는 에이전트로 만듭니다. 그 세션은 일마다 herdr 탭에 에이전트 세션을 따로 띄워 맡기고, 자기가 띄운 세션을 전부 레지스트리에 적어 두고, 일이 끝났다는 증명이 있어야 닫습니다. 증명은 머지된 PR, 닫힌 이슈, 배포된 버전, 아니면 스스로 돌려 볼 수 있는 체크입니다. 스킬(`skills/dori-mode/SKILL.md`와 `references/`)과 자체 Bun + TypeScript CLI로 나가고, CLI 이름도 `dori`입니다.

```sh
curl -fsSL https://raw.githubusercontent.com/sisyphuslabs/dori-superagent/main/install.sh | bash
```

이 한 줄이 저장소를 `~/.dori/src`에 클론하고, 스킬을 `~/.agents/skills/dori-mode`에 링크하고, `bun link`로 Dori 모드의 `dori`를 PATH에 올리고, 예시 설정을 `~/.dori/config.json`에 복사합니다. 명령, 설정, 라우팅, done 프로토콜은 [`skills/dori-mode/SKILL.md`](skills/dori-mode/SKILL.md)와 그 [`references/`](skills/dori-mode/references/)에 있습니다.

하네스와 Dori 모드 둘 다 `dori`라는 명령을 내놓습니다. 한 머신에는 하나만 설치하거나, 하네스는 `bun src/cli.ts`로 부르고 `dori`는 Dori 모드에 맡기면 됩니다. 하네스의 프롬프트는 자기 명령을 `src/cli.ts`의 전체 경로로 부르므로, 하네스가 띄운 에이전트는 PATH의 `dori`가 어느 쪽이든 상관없습니다.

## 범위

최소 실험입니다. 하네스는 Bun 위의 TypeScript 약 1,600줄에 런타임 의존성이 없고, 저희의 프로덕션 스택은 아닙니다. 일부러 뺀 것은 머신 간 메시, heavy-slot 스케줄링, 채팅과 티켓 트래커 브리지, 테스트 스위트 전체에 대한 영수증입니다. 여기 있는 것은 herdr와 omo만으로 돌아가는 부분입니다. 역할, 레인, 인박스, 듀티 루프, 한 시간 루프와 백로그, 리뷰와 머지 게이트. `skills/dori-mode`의 Dori 모드는 별개의 CLI입니다. 메신저 기능, 호스트 가드, heavy-slot 러너가 따로 있고, 하네스는 거기서 아무것도 import하지 않습니다.

## 텔레메트리

dori는 omo와 같은 방식으로 익명 사용 횟수를 보냅니다. OTLP/HTTP JSON 로그를 omo 수집기 `https://t.omo.dev`로 보냅니다. 식별자는 `~/.dori/telemetry.json`에 둔 무작위 설치 id 하나이고, 보내는 것은 그 sha256뿐입니다. 첫 전송 때 수집기가 그 해시로 설치별 ingest 키를 발급하고(`POST /v1/register`), 키는 `~/.dori/telemetry.json`에 캐시해 두고 수집기가 401로 거절하면 다시 발급받습니다. 코드에 공유 키는 들어 있지 않습니다. 처음 실행하면 한 줄 안내가 뜹니다. `DORI_TELEMETRY=0`으로 끕니다(`DO_NOT_TRACK=1`도 됩니다). `DORI_TELEMETRY_ENDPOINT`는 수집기 URL을 바꿉니다.

| 이벤트 | 언제 | 필드 |
|---|---|---|
| `dori.installed` | 첫 실행 | 없음 |
| `dori.daily_active` | 어떤 dori 명령이든, UTC 하루에 한 번 | `day_utc` |
| `dori.lane_started` | `dori start` | `open_lanes` |
| `dori.lane_ready` | `dori ready` | `evidence_count`, `lane_minutes` |
| `dori.review_completed` | `dori review` | `verdict`: `CLEAR` 또는 `BLOCK` |
| `dori.merge_decided` | `--dry-run`이 아닌 `dori merge` | `outcome`: `merged`, `no_receipt`, `review_block`, `no_checks`, `checks_red`, `checks_all_skipped` |
| `dori.duty_summary` | 듀티 루프에서 한 시간에 최대 한 번 | `ticks`, `flushed`, `nudges`, `escalations`, `lost` |

일간, 주간, 월간 활성 수는 `dori.daily_active`로 셉니다. 활성 수는 설치 단위로 세기 때문에, 두 실행이 같은 순간에 시작해 드물게 한 번 더 보내도 숫자는 바뀌지 않습니다. 레코드마다 리소스 필드가 같이 붙습니다. 서비스 이름과 버전, 설치 해시, CI 여부, OS 종류와 버전, CPU 아키텍처입니다. OS 종류는 `darwin`, `linux`, `windows` 중 하나이고, 그 밖의 OS에서는 아무것도 보내지 않습니다. 경로, 저장소 이름, PR 번호, 레인 키, 브리프, 메시지, 그 밖의 어떤 텍스트도 보내지 않습니다. 전송은 백그라운드에서 요청마다 2초 타임아웃으로 돌고, 명령은 끝나기 전에 최대 2초까지만 기다립니다. 텔레메트리가 실패해도 명령은 실패하지 않습니다.

## 테스트

저장소 루트에서 `bun test ./test/`를 치면 하네스 테스트 29개가 돌고, 모델은 부르지 않습니다. 그냥 `bun test`를 치면 Dori 모드 테스트까지 같이 돕니다.

하네스 단위 테스트 8개(`test/harness.test.ts`)는 가짜 herdr(`test/fake.ts`)를 상대로 돕니다. `herdr`와 `gh` 바이너리 대신 들어가는 레코더로, 에이전트 상태를 바꿀 수 있는 pane들을 들고 있고, 테스트가 손으로 돌리는 시계가 있습니다. 다루는 것은 레인 시작과 READY, 바쁜 리드의 큐와 묶음 전달, 모르는 대상 거절, 10분과 20분의 nudge와 40분의 에스컬레이션과 WAITING 레인 제외, working과 lost 상태, 머지 게이트의 모든 분기(영수증 없음, BLOCK, 빈 체크 목록, 빨간 체크, 전부 skip, CLEAR + 녹색), VERDICT 줄 없는 리뷰어입니다.

단위 테스트 19개(`test/loop.test.ts`)는 같은 가짜 위에서 한 시간 루프를 돌립니다. 백로그 추가, 결정, 빼기, 가져오기, 시작 순서와 예산, 레인이 꽉 찼거나 호스트가 바쁘거나 질문이 걸린 경우의 보류, done, lost, 머지된 레인의 동기화, 놓친 일 점검, 질문당 한 번 묻고 한 번 다시 묻기, 긴급 정지, 살아 있거나 죽었거나 깨진 잠금, 실행 중에 뺏긴 잠금, 되돌릴 수 없어 옆에 남겨 둔 잠금, 레인 시작 실패, 시작이 계속 실패해 질문으로 바뀌는 항목, 실행 사이의 대기 시간, 열렸지만 리드에게 알리지 못한 레인, 백로그 폴더 밖으로 나가려는 id, 사라진 레인 기록, 같은 밀리초의 두 실행을 다룹니다. 그중 두 개는 루프가 pane 닫기, 머지, 푸시를 한 번도 보내지 않는지 확인하고, 점검 테스트는 레인 기록이 바이트 단위로 그대로인지도 확인합니다.

텔레메트리 단위 테스트 11개(`test/telemetry.test.ts`)는 끄기, 첫 실행 안내와 하루 한 번의 `dori.daily_active`, 설치별 키를 한 번만 발급받아 캐시하고 401 뒤에 다시 발급받는 것, 등록된 스키마에 맞는 페이로드(scope 이름과 버전, 허용된 리소스 키만, 횟수만), 수집기가 200 응답 안에서 거절한 레코드(`partialSuccess.rejectedLogRecords`)를 따로 세는 것, 한 시간 단위 듀티 요약, 오프라인에서 처음 실행해도 `dori.installed`와 `dori.daily_active`를 전송이 성공할 때까지 남겨 두는 것, 상태 파일 권한이 0600이고 깨진 상태 파일에도 throw하지 않는 것, 호출이 바로 돌아오고 flush가 기한에 포기하는 것, 같은 홈에서 동시에 시작한 첫 실행 둘이 설치 id 하나를 나눠 쓰는 것, 수집기에 닿지 않거나 등록이 거절돼도 throw하지 않고 로그도 보내지 않는 것을 확인합니다.

엔드투엔드 테스트 2개(`test/e2e.test.ts`) 중 첫 번째는 격리된 이름의 세션에 진짜 herdr 서버를 띄우고, 워크스페이스를 만들고, 리드 pane을 등록하고, omo 대신 `test/fixtures/fake-agent.sh`를 에이전트로 쓰는 레인을 시작합니다. 이 스크립트는 브리프를 읽고 `dori report`와 `dori ready`를 부르고, 테스트는 `[START]`, `[REPORT]`, `[READY]`가 리드 pane에 도착하는지와 `dori done`이 레인을 닫는지 확인합니다. 두 번째는 백로그 항목을 넣고 `dori loop --once`를 돌린 뒤, 루프가 시작한 레인이 READY까지 가는지, `[LOOP ...]`가 리드 pane에 도착하는지, `dori loop stop` 뒤의 실행이 아무것도 하지 않는지 확인합니다. 둘 다 PATH에 `herdr`가 없으면 건너뛰고, `DORI_TELEMETRY=0`으로 돕니다. `bun run typecheck`는 `tsc --noEmit`입니다.

Dori 모드에는 가짜 herdr, git, gh를 상대로 하는 자체 테스트 145개가 있습니다.

```sh
cd skills/dori-mode/scripts && bun install && bun test
```

## 라이선스

MIT입니다. [LICENSE](LICENSE)에 있습니다.
