# 아키텍처: OMP 위의 영속적 runtime 계층

기준: 2026-09-05. OMP 18.1.10 (`v18.1.10`, `f241301c`), Homebrew darwin-arm64 바이너리.

## 1. 최종 선택

**OMP를 fork하지 않는다. 확장 API 위에 runtime을 얹고 core 수정은 0 파일로 유지한다.**

```text
                 upstream OMP (binary, brew upgrade 로 교체)
                      │  공개 확장 이벤트만 사용
                      ▼
          ~/.omp/agent/extensions/agi-runtime  (→ 이 저장소)
             ┌────────┼─────────┬──────────┬──────────┐
             │        │         │          │          │
        journal    evidence   zvec      recall     memory gates
      (~/.omp/    (hash 영수증) (read 관측) (첫 효과 전) (전송 전 검사, read-back)
       runtime)                                        │ 모델이 MCP 로 전송
                                                       ▼
                                                       gbrain  = 정본
```

역할 분리는 유지한다: `OMP = reasoning + action + search routing`, `zvec-grep = workspace retrieval`, `gbrain = canonical knowledge`. 이 계층은 네 번째 에이전트 프레임워크가 아니라 실행의 유효성을 제한하고 결과를 기록하는 얇은 층이다. 별도 모델 루프, 스케줄러, 벡터 DB, 웹 서비스는 없다.

**권한은 에이전트에게 있다.** 사람 승인은 Kubernetes(clab-cluster 제외)에만 남는다 — `kubernetes-approval.ts`와 §5.1. 이 계층이 강제하는 것은 권한이 아니라 **절차**다: goal의 첫 효과 전에 회상이 settle되어 있을 것, 결과 불명인 효과는 read-back 뒤에 attestation으로 닫을 것, 정본 메모리에 쓰는 사실은 자격증명이 아니고 인용한 근거가 현재일 것. 이 계층은 어떤 훅에서도 턴을 시작하거나 stop을 막지 않는다(`session_stop` 미등록). `agent_end`는 알림뿐이다.

검색을 잘하는 책임은 OMP와 zvec에 둔다. 에이전트는 위치를 모르는 의미·행동·구조·cross-file 질문에 zvec를 먼저 쓰고, 정확한 식별자·전수 occurrence는 native(`grep`/`rg`/LSP/`ast_grep`)로 찾고, 중요한 zvec hit는 현재 소스로 확인한 뒤 결정한다. 이 계층은 그 라우팅을 `before_agent_start` 상태의 `search` 키 한 줄로 전달할 뿐, zvec 호출의 입력(`limit`, `autoUpdate`, `hidden`, query group 수)을 바꾸거나 검색 전략을 결정하지 않는다. 이전 버전의 `boundedSearch`(입력 clamp·scope 키 제거·`search.foreign_root` 이벤트)는 이 이유로 제거했다 — 인덱스 freshness와 query semantics는 zvec 자신의 책임이다.

이전 설계의 `withRuntimeBoundary` core patch는 폐기했다. 이유는 두 가지다. (1) 사용자의 OMP는 컴파일된 바이너리라 소스 패치가 실행 경로에 도달하지 않는다. (2) v18.1.10 소스를 읽은 결과 공개 이벤트 네 개가 그 패치가 얻으려던 정보를 모두 제공한다(§3).

## 2. 업데이트 내성의 구조

| 계층 | 업데이트 시 | 왜 유지되는가 |
|---|---|---|
| OMP 바이너리 | 교체 | — |
| `~/.omp/agent/config.yml`, `AGENTS.md`, 기존 확장 | 유지 | OMP 데이터 디렉터리 |
| `~/.omp/agent/extensions/agi-runtime` (symlink) | 유지 | auto-discovery: 디렉터리의 `package.json#omp.extensions` |
| `~/.omp/runtime/*` | 유지 | OMP 밖의 우리 디렉터리 |
| 확장 ↔ OMP 계약 | **검증** | load 시 API/컨텍스트 멤버 probe, 세션 중 이벤트 counters, 버전별 `compat/<v>.json` |

계약이 깨지는 방식은 두 종류다. **구조적**(probe한 멤버 사라짐)은 attach를 거부한다: 알림 한 줄, 저널 없음, OMP 도구는 평소처럼 동작하고 report는 `degraded`. 업데이트마다 OMP를 못 쓰게 되는 것은 "풀림"의 다른 형태이므로 기본은 runtime만 꺼지는 것이다. 무인 실행처럼 경계가 반드시 있어야 하는 곳에서는 `OMP_RUNTIME_REQUIRED=1`로 모든 `tool_call`을 차단한다. 한계: 차단은 `tool_call` 핸들러가 설치된 경우에만 성립한다. `pi.on`이 없거나 factory가 load 중 throw하면 핸들러가 없고, OMP는 확장 load error를 기록한 뒤 도구를 평소처럼 실행한다. **의미적**(이벤트 payload 의미·순서 변경)은 counters(`unmatchedStarts/Results`, `revisions`, `rewrites`)로 드러난다; report만 `degraded`이고 커널은 설정된 `mode`로 계속 동작한다 — 자동 전환은 없다.

`types/pi-coding-agent.d.ts`는 이 확장이 의존하는 OMP 표면의 **최소** 선언이다. 런타임에는 OMP loader가 호스트 패키지로 resolve하므로 쓰이지 않고, `tsc`가 확장을 검사할 때만 쓰인다. 여기 없는 것은 계약이 아니다.

## 3. 실행 경계

v18.1.10 `wrapper.ts`/`agent-loop`가 보장하는 순서:

```text
tool_call            agent loop, arg-prep 시점. input = 원본. 차단/입력 수정 가능.
                     여러 핸들러가 input 을 수정하면 마지막이 이기고 서로의 수정을 보지 못한다.
tool_execution_start agent loop. args = 실제 실행 입력 (수정 반영).
[wrapper]            승인 게이트 → tool.execute → tool_result (middleware 순서 = 확장 로드 순서)
tool_execution_end   agent loop. result = middleware 통과 후 최종.
```

커널 매핑:

- `intent(call)` — classify → decision → 메모리 쓰기 게이트(§6) → 회상 게이트(§3.1) → (opt-in) 정확 입력 승인 → unknown 해소 게이트 + 사용량 카운트 + `executing` 행. 거절은 `{block, reason}`으로 모델에 돌아간다. 입력은 절대 바꾸지 않는다.
- `revise(id, name, args)` — 실행 입력 hash가 intent와 다르면 행을 갱신하고 `action.revised` 이벤트. 메모리 쓰기의 입력이 여기서 바뀌면 그 호출은 게이트를 통과한 intent가 아니므로 결과와 무관하게 `unknown`으로 닫는다(실행은 이 훅에서 막을 수 없다).
- `settle(id, name, …, phase)` — 첫 관측이 결과를 확정한다. 이후 `isError`가 뒤집히면 `action.rewritten` 이벤트와 `rewrites` 카운트. `tool_result`가 오지 않는 경로(승인 거절, 다른 확장의 차단)는 `tool_execution_end`가 `failed`로 마감한다. 결과 본문은 관측(zvec의 `freshness:`, 회상 결과의 `total`)에만 쓰이고, 저널 상태를 바꾸는 본문은 없다(§6).
- `turnStart()` — `turn_start`와 `before_agent_start`에서 turn 카운터를 올린다. turn t에 settle된 결과는 t+1의 모델 호출에서 처음 보인다.

### 3.1 회상 게이트

`recall.mode: require`면 goal(`goal.observed`의 id, 없으면 세션)마다 첫 효과 전에 `recall.tools` 중 하나가 **이전 turn에 settle**되어 있어야 한다. intent 관측은 근거가 아니다: 같은 메시지에서 `recall`과 `bash`를 함께 낸 모델은 회상 결과를 읽지 않고 결정한 것이고, OMP는 `tool_call`을 arg-prep 시점에 emit하므로 실행 순서도 보장하지 않는다. 그래서 통과 조건은 `settledTurn < intent.turn`이다. 실패한 회상도 settle이다 — 정본 메모리가 죽어도 작업은 멈추지 않고 `recall.state: failed`가 상태에 남는다. 자동 해제는 없다: 차단 횟수·시간은 게이트를 풀지 못한다(횟수 기반 해제는 효과 재요청 두 번으로 통과되는 구조적 우회였다). `require`는 운영자의 선언이고, clab-mem이 없는 환경은 `advise`다. epoch이 오른 재개 세션에서 `memoryTask`가 알려져 있으면 그 키의 `mem_task_read`만 통과시킨다. `mem_status`·`mem_read`는 회상이 아니다(telemetry). `hits>0`인 검색 뒤 읽기 없이 첫 효과가 나가면 `recall.shallow` 이벤트 — 차단은 없고 측정만 한다.

`write({path:"xd://<tool>"})`는 봉투일 뿐이라 **디스패치되는 도구로** 분류한다(`src/policy.mjs`의 `dispatched`). 봉투를 opaque write로 보면 디스패치된 회상 read가 효과가 되어 recall 게이트가 자기 자신을 막는다. 게이트가 실제 인자를 필요로 하는 검사(메모리 쓰기)는 중첩 호출 쪽에서 돌고, 봉투는 kind만 물려받는다.

티켓 키는 `(toolCallId, toolName)`이다. 라이브에서 확인한 사실: `write({path:"xd://runtime_status"})`는 중첩 디스패치를 만들고, 그 중첩 `tool_call/tool_result`는 **외부 호출과 같은 toolCallId**를 쓰며 자체 `tool_execution_start/end`가 없다. toolCallId만으로 키를 잡으면 외부 행이 `executing`으로 남아 다음 세션에서 거짓 `unknown`이 된다. 회귀 테스트가 있다.

결과 판정: `isError` 또는 `details.exitCode ≠ 0`이면 `failed`(관측된 실패). `unknown`은 **관측이 끊긴 경우**에만 — 프로세스가 하트비트 없이 lapse한 세션의 `executing` 효과. 예외를 무조건 `unknown`으로 두던 이전 규칙은 버렸다: hook 경계에서는 tool의 throw와 `isError` 반환이 구분되지 않고, 테스트 실패(`bash` nonzero)마다 workspace를 얼리는 것은 실용적이지 않다.

경계 밖: provider-native 실행, 확장의 직접 `exec`, 서브프로세스, 다른 프로세스. 이 계층은 OS sandbox와 credential broker의 대체재가 아니다.

## 4. 저널과 lease

```text
workspaces(id, root, paused)
sessions(id, workspace, epoch, expires, has_ui, tool_calls, effects_used, native_goal, checkpoint)
actions(id, workspace, session, epoch, tool, input_hash, is_effect, state, outcome_hash)
events, evidence, approvals(+session)
```

사용자는 같은 저장소에서 여러 OMP 터미널을 동시에 연다(`~/.omp/agent/sessions/` 참조). 그래서 **lease는 세션 단위**다: 같은 세션을 두 프로세스가 동시에 잡는 것만 `SESSION_WRITER_BUSY`로 거절하고, 다른 세션은 하나의 workspace 저널을 공유한다. workspace 전체에 걸치는 사실은 둘뿐이다 — `paused`, 그리고 해소되지 않은 `unknown`. 둘 다 같은 working tree를 건드리는 모든 세션에 관계가 있다.

`sweep(workspace)`는 `expires ≤ now`인 세션의 `executing` 효과를 `unknown`, 읽기를 `failed`로 옮긴다. acquire 시점과 매 효과 intent 직전에 **별도 트랜잭션으로** 실행한다 — intent 거절(`RECONCILIATION_REQUIRED`, `DUPLICATE_ACTION`)로 롤백되어도 lapse 발견은 남아야 한다. 살아 있는 형제 세션의 `executing`은 건드리지 않는다.

액션 ID는 `digest({session, tool, toolCallId})`. 같은 ID의 재디스패치는 거절한다(과거 성공을 재사용하는 것은 임의 도구에 안전하지 않다). 재개는 epoch만 올리고 사용량 카운터(`tool_calls`, `effects_used`)는 이어진다. 카운터는 관측용이다 — 상한도, 갱신 명령도 없다. 사람이 있는 세션이든 무인이든 카운터가 작업을 멈추는 경로는 두지 않는다.

`reconcile`은 read-back의 attestation이다. 에이전트가 `runtime_reconcile`로(저널 `by: session`, `observed`에 확인한 내용) 또는 사람이 `/runtime reconcile`로 닫는다. 근거 영수증은 선택 사항이다. 이전 버전처럼 근거를 필수로 요구하면 "터미널 닫다가 끊긴 bash 한 번"을 풀기 위해 파일 hash를 먼저 만들어야 했다.

`unknown`에는 범위가 있다. 도구 이름이 `memoryWriteTools`면 `remote`, 아니면 workspace다(schema 변경 없이 유도). workspace 효과는 workspace unknown에만 막히고, 메모리 쓰기는 둘 다에 막힌다 — 다시 쓰면 같은 사실이 두 번 들어갈 수 있기 때문이다. 예외는 없다: 읽어서 확인한 뒤 attestation으로 닫는다.

메모리에 관한 사실은 저장하지 않고 저널에서 유도한다: `effectsSinceNote`는 마지막 메모리 쓰기 행 이후의 settle된 효과 수다(`rowid` 경계 — 한 tick에 여러 행이 들어온다). `xd://` 봉투로 디스패치된 쓰기도 저널 행의 도구 이름이 실행될 도구이므로 같은 계산에 들어온다. crash 뒤에도 resume card가 같은 값을 낸다.

## 5. 정책

분류는 **정확한 도구 이름 표**다. 확장은 OMP의 승인 tier를 볼 수 없고(`ToolInfo`에 없음), 이름 표는 안전한 쪽으로 실패한다 — 모르는 도구는 효과다. `read/grep/glob/ast_grep/web_search/mcp__zvec_grep_search`와 runtime 읽기 도구 = read. `todo/goal/ask`와 runtime 세션 도구 = session-write(효과 아님). `write`는 literal `{path,content}`이고 tree 안·비민감·symlink 없음·비실행이면 `workspace-write`, `edit/ast_edit`는 path 기준. 그 외 = opaque. `memoryReadTools`의 정확한 이름 = read(canonical-memory). read는 입력이 그대로 실행되고, 실패(`isError`)나 lapse는 `failed`로 마감된다 — unknown도 poison도 아니므로 zvec 장애는 native 검색으로의 fallback을 막지 않는다.

결정: read/session-write는 항상 허용. 효과는 `headlessEffects`, 구조화 infra 정책(§5.1), `requireApproval`을 거친다. **OMP 자체의 approval mode와 `kubernetes-approval.ts`가 이미 프롬프트를 담당한다**; 이 계층은 운영자가 명시한 도구에만 정확 입력·1회용 승인을 더한다. 이전 버전의 "모든 opaque exec에 승인"은 사용자의 `yolo` 선택과 충돌하므로 상시 계층의 기본에서 뺐다.

`read`의 민감 경로(`.env`, `.omp`, `.ssh`, 절대 경로, tree 밖)는 `read.sensitive` 이벤트로 저널에 남긴다. 차단하지 않는다 — 그것은 OMP의 권한 모델과 OS의 일이며, 여기서 막으면 `~/.omp/agent/config.yml`을 읽는 정당한 작업까지 깨진다.

### 5.1 Kubernetes/GitOps

`structuredOperationTools`가 공급하는 신뢰된 descriptor에만 적용된다. shell 문자열 파싱으로 권한을 판단하지 않는다(`eval`, Python, HTTP, SSH 모두 같은 결과를 만들 수 있다). headless 금지 → target fingerprint 일치 → `clab-cluster` 비고위험 예외 → 나머지 승인. 현재 연결된 어댑터는 없다. 실제 클러스터 승인은 `kubernetes-approval.ts`다.

## 6. 메모리

zvec에는 code/workspace 문서만. 정본 기록을 다시 색인하지 않는다. 검색 결과는 evidence이지 truth가 아니다 — `runtime_evidence`로 현재 원문 hash를 남긴 뒤에만 사실의 근거가 된다.

정본 메모리는 gbrain이고, 쓰는 주체는 모델이다. 이 프로세스는 MCP 도구를 호출할 수 없으므로(`ctx.invokeTool`은 같은 이름의 built-in 위임뿐) 런타임이 전송을 소유하는 설계는 애초에 불가능하다. 이 계층이 소유하는 것은 **의무와 정합성**이다.

읽기는 `recall`(질의는 코퍼스 조망, `entity`는 아는 대상), `entity`, `context_pack`, `delta`, `synthesize`. 쓰기는 `remember`(사실 하나 + provenance 필수)와 `forget`(id로 만료). 한 도구가 읽기·쓰기 목록에 동시에 들어갈 수 없다 — 게이트가 다르다.

쓰기의 결과 본문은 전부 telemetry다. 서버가 강제하는 멱등 키가 없고 중복 판정은 임베딩 유사도이므로, "성공"이라는 텍스트도 "같은 사실이 한 번만 들어갔다"를 증명하지 않는다. 그래서:

- 쓰기의 `isError`는 `unknown(remote)`이다. 기록됐는지 알 수 없다는 뜻이고, 문구를 바꿔 다시 쓰는 것은 두 번 기록할 위험이다.
- 실행 입력이 게이트 통과 후 바뀐 쓰기(`action.revised`)는 성공해도 `unknown`이다. 게이트를 통과한 intent가 아니다.
- 해소는 하나뿐이다: 기록을 읽어(`recall`/`entity`) 실제 상태를 확인한 뒤 `runtime_reconcile`에 관측한 내용을 적는다. 저널에 `by: session`으로 남는다.
- 전송 전 검사(전부 구조적): 자격증명 패턴(`MEMORY_SECRET` — 한 번 들어가면 정본에서 지우기 어렵다), 인용된 evidence의 현재성(`STALE_EVIDENCE`), 직전 메모리 호출이 실패·불명이면 읽기 먼저(`MEMORY_BACKEND_DEGRADED` — 장애 중 unknown이 쌓이지 않게).
- 근거를 인용하지 않은 사실은 허용하고 `memory.unverified`로 센다. 결정·제약·사고 기록은 파일 범위와 무관한 경우가 많다.

`unknown`에는 범위가 있다. 도구 이름이 `memoryWriteTools`면 `remote`, 아니면 workspace다. workspace 효과는 workspace unknown에만 막히고, 메모리 쓰기는 둘 다에 막힌다. 메모리 쓰기 하나가 불명이라고 작업 트리 작업이 멈추지는 않는다.

`agent_end`에서 `effectsSinceNote > 0`이면 한 줄 알린다. 기록하라고 말하는 것은 사용자다 — 이 계층은 continue를 하지 않는다.

로컬 staging 단계는 두지 않는다. 정본 쓰기 도구가 곧 정본이고, 같은 사실을 두 곳에 두면 어느 쪽이 사실인지 물어야 한다. `runtime_checkpoint`는 정본이 아니라 이 세션의 복구 상태다.

## 7. 결정 기록과 이견

| 결정 | 대안 | 이유 |
|---|---|---|
| hook 경계, core patch 0 | built-in shadowing(`registerTool` + `ctx.invokeTool`) | shadowing은 도구별 스키마 재선언이 필요해 업데이트마다 drift. hook은 네 이벤트만 의존 |
| `headlessEffects: allow` 기본 | `deny` | AGENTS.md headless 조항은 k8s 한정. 서브에이전트는 확장 미로드. `deny`는 `omp -p`를 읽기 전용으로 만듦. **advisor는 `deny`를 권고했다** — 한 줄로 전환 가능 |
| 세션 lease | workspace 단일 writer | 사용자는 같은 저장소에 여러 터미널을 연다. 단일 writer는 두 번째 세션을 막거나 관측 전용으로 만든다 |
| `isError` = failed | = unknown | hook에서 throw/isError 구분 불가. 테스트 실패마다 workspace 정지는 비실용적. unknown은 관측 단절에만 |
| 구조적 계약 위반 시 runtime 비활성(도구는 동작) | fail closed | 업데이트 후 OMP 불능도 "풀림". `OMP_RUNTIME_REQUIRED=1`로 fail closed 선택 가능 |
| `memoryReadTools` 사전 채움 | 빈 배열 | 서버 소스와 실행 중 라우트에서 이름·읽기 여부 확인 |
| 회상 게이트를 turn 기준 settle로 | intent 관측 1건 | 병렬 tool call은 실행 전에 모두 intent를 지나고, 같은 메시지의 효과는 회상 결과를 읽지 않은 결정이다 |
| 회상 게이트는 3회 거절 후 스스로 열림 | 사람이 `/runtime recall skip` | 도구 부재는 사전 관측이 불가능하고(OMP에 세션 도구 목록 API 없음) 사람 개입을 요구하면 자율 실행이 멈춘다. 시도의 실패와 반복 거절은 관측 가능하므로 그것으로 강등한다 |
| 저널 쓰기 실패는 관측으로 강등 | 효과 차단(fail closed) | 원장이 깨진 것은 작업을 멈출 이유가 아니다. 차단하면 세션 재시작 외에 풀 방법이 없었다. `journal.degraded` 이벤트와 상태로 노출한다 |
| `OMP_RUNTIME_REQUIRED=1`은 호스트 계약 위반에만 fail closed | attach 실패 전체 | 운영자 config의 낡은 키나 다른 세션이 쥔 writer lease는 호스트 계약이 아니다. 그걸로 모든 도구를 막으면 자율 실행이 사람 손을 요구한다 |
| 쓰기 오류는 전부 `unknown` | 결과 텍스트로 `failed` 강등 | 텍스트는 middleware가 바꿀 수 있고 중복 기록은 지우기 어렵다. 강등할 근거가 없다 |
| 모델이 전송, 런타임은 검증 | 런타임이 소유한 전송 계층 | `invokeTool`은 same-tool 위임뿐이다. 둘째 클라이언트는 이중 구현 |
| `agent_end` 알림만 | `session_stop` continue | 둘째 자율 루프 금지(`AGENTS.runtime.md`). 사용자가 continuation 권한자 |

## 8. 남은 통합 게이트

1. Kubernetes target resolver/broker (CA/server identity, GitOps repo/ref) → `structuredOperationTools` 연결.
2. `recall.shallow`·`memory.unverified`·`memory.note_due`·`discovery.readsBeforeFirstZvec`를 몇 세션 관측한 뒤 goal 전환 시 `noteDue` 게이트 여부를 결정한다. 측정 전에는 advisory다.
3. 사용량 이벤트와 goal ID를 연결하되 관측용으로만 사용한다. Runtime은 호출 수·효과 수·세션 경과시간을 근거로 작업을 중단하지 않는다.
4. 동일 workload A/B 측정 후 자율성 확대.

각 단계는 독립적으로 검증한다. 이번 단계(extension-first 전환, 라이브 검증)가 통과했다고 다음 단계가 준비됐다고 기록하지 않는다.
