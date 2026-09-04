# 아키텍처: OMP 위의 영속적 runtime 계층

기준: 2026-09-05. OMP 18.1.10 (`v18.1.10`, `f241301c`), Homebrew darwin-arm64 바이너리.

## 1. 최종 선택

**OMP를 fork하지 않는다. 확장 API 위에 runtime을 얹고 core 수정은 0 파일로 유지한다.**

```text
                 upstream OMP (binary, brew upgrade 로 교체)
                      │  공개 확장 이벤트만 사용
                      ▼
          ~/.omp/agent/extensions/agi-runtime  (→ 이 저장소)
             ┌────────┼─────────┬──────────┐
             │        │         │          │
        journal    evidence   zvec      memory
      (~/.omp/    (hash 영수증) (입력 경계)  outbox
       runtime)                            │
                                           ▼  (미바인딩)
                                    Utopia / clab-mem  = 정본
```

역할 분리는 유지한다: `OMP = reasoning + action`, `zvec-grep = workspace retrieval`, `Utopia = canonical knowledge`. 이 계층은 네 번째 에이전트 프레임워크가 아니라 실행의 유효성을 제한하고 결과를 기록하는 얇은 층이다. 별도 모델 루프, 스케줄러, 벡터 DB, 웹 서비스는 없다.

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

- `intent(call)` — classify → decision → (opt-in) 정확 입력 승인 → 예산 예약 + `executing` 행. 한 트랜잭션. 거절은 `{block, reason}`으로 모델에 돌아간다.
- `revise(id, name, args)` — 실행 입력 hash가 intent와 다르면 행을 갱신하고 `action.revised` 이벤트.
- `settle(id, name, …, phase)` — 첫 관측이 결과를 확정한다. 이후 `isError`가 뒤집히면 `action.rewritten` 이벤트와 `rewrites` 카운트. `tool_result`가 오지 않는 경로(승인 거절, 다른 확장의 차단)는 `tool_execution_end`가 `failed`로 마감한다.

티켓 키는 `(toolCallId, toolName)`이다. 라이브에서 확인한 사실: `write({path:"xd://runtime_status"})`는 중첩 디스패치를 만들고, 그 중첩 `tool_call/tool_result`는 **외부 호출과 같은 toolCallId**를 쓰며 자체 `tool_execution_start/end`가 없다. toolCallId만으로 키를 잡으면 외부 행이 `executing`으로 남아 다음 세션에서 거짓 `unknown`이 된다. 회귀 테스트가 있다.

결과 판정: `isError` 또는 `details.exitCode ≠ 0`이면 `failed`(관측된 실패). `unknown`은 **관측이 끊긴 경우**에만 — 프로세스가 하트비트 없이 lapse한 세션의 `executing` 효과. 예외를 무조건 `unknown`으로 두던 이전 규칙은 버렸다: hook 경계에서는 tool의 throw와 `isError` 반환이 구분되지 않고, 테스트 실패(`bash` nonzero)마다 workspace를 얼리는 것은 실용적이지 않다.

경계 밖: provider-native 실행, 확장의 직접 `exec`, 서브프로세스, 다른 프로세스. 이 계층은 OS sandbox와 credential broker의 대체재가 아니다.

## 4. 저널과 lease

```text
workspaces(id, root, paused)
sessions(id, workspace, epoch, expires, has_ui, budgets…, native_goal, checkpoint)
actions(id, workspace, session, epoch, tool, input_hash, is_effect, state, outcome_hash)
events, evidence, outbox(+session), approvals(+session)
```

사용자는 같은 저장소에서 여러 OMP 터미널을 동시에 연다(`~/.omp/agent/sessions/` 참조). 그래서 **lease는 세션 단위**다: 같은 세션을 두 프로세스가 동시에 잡는 것만 `SESSION_WRITER_BUSY`로 거절하고, 다른 세션은 하나의 workspace 저널을 공유한다. workspace 전체에 걸치는 사실은 둘뿐이다 — `paused`, 그리고 해소되지 않은 `unknown`. 둘 다 같은 working tree를 건드리는 모든 세션에 관계가 있다.

`sweep(workspace)`는 `expires ≤ now`인 세션의 `executing` 효과를 `unknown`, 읽기를 `failed`, `sending` outbox를 `unknown`으로 옮긴다. acquire 시점과 매 효과 intent 직전에 **별도 트랜잭션으로** 실행한다 — 예산 거절로 롤백되어도 lapse 발견은 남아야 한다. 살아 있는 형제 세션의 `executing`은 건드리지 않는다.

액션 ID는 `digest({session, tool, toolCallId})`. 같은 ID의 재디스패치는 거절한다(과거 성공을 재사용하는 것은 임의 도구에 안전하지 않다). 재개는 epoch만 올리고 예산 사용량은 유지한다.

`reconcile`은 사람의 확인 기록이다. 근거 영수증은 선택 사항이고, `/runtime reconcile all`이 있다. 이전 버전처럼 근거를 필수로 요구하면 "터미널 닫다가 끊긴 bash 한 번"을 풀기 위해 파일 hash를 먼저 만들어야 했다.

## 5. 정책

분류는 **정확한 도구 이름 표**다. 확장은 OMP의 승인 tier를 볼 수 없고(`ToolInfo`에 없음), 이름 표는 안전한 쪽으로 실패한다 — 모르는 도구는 효과다. `read/grep/glob/ast_grep/web_search`와 runtime 읽기 도구 = read. `todo/goal/ask`와 runtime 세션 도구 = session-write(효과 아님). `write`는 literal `{path,content}`이고 tree 안·비민감·symlink 없음·비실행이면 `workspace-write`, `edit/ast_edit`는 path 기준. 그 외 = opaque. `mcp__zvec_grep_search` = read(workspace-index). `memoryReadTools`의 정확한 이름 = read(canonical-memory).

결정: read/session-write는 항상 허용. 효과는 `headlessEffects`, 구조화 infra 정책(§5.1), `requireApproval`을 거친다. **OMP 자체의 approval mode와 `kubernetes-approval.ts`가 이미 프롬프트를 담당한다**; 이 계층은 운영자가 명시한 도구에만 정확 입력·1회용 승인을 더한다. 이전 버전의 "모든 opaque exec에 승인"은 사용자의 `yolo` 선택과 충돌하므로 상시 계층의 기본에서 뺐다.

`read`의 민감 경로(`.env`, `.omp`, `.ssh`, 절대 경로, tree 밖)는 `read.sensitive` 이벤트로 저널에 남긴다. 차단하지 않는다 — 그것은 OMP의 권한 모델과 OS의 일이며, 여기서 막으면 `~/.omp/agent/config.yml`을 읽는 정당한 작업까지 깨진다.

### 5.1 Kubernetes/GitOps

`structuredOperationTools`가 공급하는 신뢰된 descriptor에만 적용된다. shell 문자열 파싱으로 권한을 판단하지 않는다(`eval`, Python, HTTP, SSH 모두 같은 결과를 만들 수 있다). headless 금지 → target fingerprint 일치 → `clab-cluster` 비고위험 예외 → 나머지 승인. 현재 연결된 어댑터는 없다. 실제 클러스터 승인은 `kubernetes-approval.ts`다.

## 6. 메모리

zvec에는 code/workspace 문서만. Utopia 원문을 다시 색인하지 않는다. 검색 결과는 `runtime_evidence`로 원문 hash를 남긴 뒤에만 후보의 근거가 된다.

후보는 `decision/constraint/incident/procedure/checkpoint`만. 모델은 후보를 만들 뿐이고 게시는 `/runtime publish`(사람)다. 게시 전 근거 재검증, payload hash 고정, validator가 payload를 바꾸면 거절.

전송 계층 `CanonicalMemoryPort`는 `idempotency: server-enforced`와 `durableAck`를 요구한다. clab-mem의 실제 계약(`mcp/server.ts`): `mem_task_start`는 key로 find-or-create(멱등), `mem_task_note`는 append(멱등 아님), `mem_task_complete`는 read-back 검증. 후보 하나 = note 하나이므로 타임아웃 후 재시도는 중복을 만든다. lookup(`mem_search`)으로 dedupe하는 방식은 임베딩/인덱싱 지연(skill 문서에 실측 기록) 때문에 false negative가 난다. 그러므로 **바인딩하지 않는다**. 서버가 `(actor, idempotencyKey)` 유일성과 durable receipt를 제공하면 `boundMemoryPort()` 슬롯에 어댑터를 넣는다. 슬롯은 `Symbol.for`로 신뢰된 호스트 모듈만 채운다 — config나 모델 출력으로는 채울 수 없다.

## 7. 결정 기록과 이견

| 결정 | 대안 | 이유 |
|---|---|---|
| hook 경계, core patch 0 | built-in shadowing(`registerTool` + `ctx.invokeTool`) | shadowing은 도구별 스키마 재선언이 필요해 업데이트마다 drift. hook은 네 이벤트만 의존 |
| `headlessEffects: allow` 기본 | `deny` | AGENTS.md headless 조항은 k8s 한정. 서브에이전트는 확장 미로드. `deny`는 `omp -p`를 읽기 전용으로 만듦. **advisor는 `deny`를 권고했다** — 한 줄로 전환 가능 |
| 세션 lease | workspace 단일 writer | 사용자는 같은 저장소에 여러 터미널을 연다. 단일 writer는 두 번째 세션을 막거나 관측 전용으로 만든다 |
| `isError` = failed | = unknown | hook에서 throw/isError 구분 불가. 테스트 실패마다 workspace 정지는 비실용적. unknown은 관측 단절에만 |
| 구조적 계약 위반 시 runtime 비활성(도구는 동작) | fail closed | 업데이트 후 OMP 불능도 "풀림". `OMP_RUNTIME_REQUIRED=1`로 fail closed 선택 가능 |
| `memoryReadTools` 사전 채움 | 빈 배열 | 서버 소스와 실행 중 라우트에서 이름·읽기 여부 확인 |

## 8. 남은 통합 게이트

1. clab-mem 서버에 idempotency receipt(`(actor, key)` 유일, payload hash 충돌 거절, durable ack) 추가 → 어댑터 바인딩 → timeout-after-commit 테스트.
2. Kubernetes target resolver/broker (CA/server identity, GitOps repo/ref) → `structuredOperationTools` 연결.
3. 사용량 이벤트와 goal ID 결합, provider/OS hard limit.
4. 동일 workload A/B 측정 후 자율성 확대.

각 단계는 독립적으로 검증한다. 이번 단계(extension-first 전환, 라이브 검증)가 통과했다고 다음 단계가 준비됐다고 기록하지 않는다.
