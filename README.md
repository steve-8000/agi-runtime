# OMP AGI Runtime — extension-first

**OMP 위에 얹는 영속적인 runtime 계층. OMP core patch 0 파일. `brew upgrade omp` 후에도 그대로 로드된다.**

2026-09-05, Asia/Seoul 기준. 여기서 "AGI runtime"은 모델 능력을 지속적인 작업·근거·권한·복구에 연결하는 런타임의 프로젝트 이름이다. AGI 달성, 자기 의식, 범용성, 인간 수준 신뢰성을 입증했다는 뜻이 아니다.

## 결론

이전 버전은 OMP 소스(`wrapper.ts`)를 패치해 실행 경계를 넣었다. 실제 설치본은 Homebrew의 **컴파일된 단일 바이너리**(`omp/18.1.10`, 128MB)이므로 그 패치는 사용자의 실행 경로에 적용될 수 없었다. 이번 버전은 그 경계를 OMP의 **공개 확장 이벤트**로 옮겼다.

```text
tool_call            → intent()  : 정책, (opt-in) 정확 입력 승인, unknown 해소 게이트, `executing` 행
tool_execution_start → revise()  : 실제로 실행되는 입력 (다른 확장이 수정했을 수 있음)
tool_result          → settle()  : 원시 결과의 첫 관측 (다른 middleware 이전)
tool_execution_end   → settle()  : 최종 결과; isError 가 tool_result 와 뒤집히면 저널에 기록
```

OMP core는 수정하지 않는다. 확장 API 계약이 바뀌면 `~/.omp/runtime/compat/<version>.json`에 `degraded`로 기록된다. probe한 멤버가 사라진 경우 runtime은 attach하지 않는다 — 알림 한 줄, 저널 없음, OMP 도구는 평소처럼 동작. `OMP_RUNTIME_REQUIRED=1`이면 대신 모든 도구 호출을 `RUNTIME_HANDLER_REQUIRED`로 차단한다 — 단, 이 차단은 `tool_call` 핸들러가 설치된 뒤에만 가능하다. `pi.on` 자체가 사라졌거나 factory가 load 중 throw하면 핸들러가 없으므로 REQUIRED도 아무것도 막지 못하고 OMP는 확장 load error만 남긴다. 이벤트 의미만 바뀐 경우(`counters.unmatched* > 0`)는 report만 `degraded`이고 커널은 설정된 `mode`로 계속 동작한다.

## 설치 위치

```text
~/.omp/
├── agent/
│   ├── config.yml, AGENTS.md          # 기존 그대로
│   └── extensions/
│       └── agi-runtime -> <checkout>   # symlink; package.json#omp.extensions 로 진입점 선언
└── runtime/                            # 이 계층의 상태. 어떤 workspace 안에도 쓰지 않는다
    ├── config.json                     # 운영자 정책 (아래)
    ├── journals/<workspace-digest>.sqlite
    └── compat/<omp-version>.json
```

```sh
cd <checkout>
node scripts/install.mjs         # symlink + ~/.omp/runtime 생성 (멱등, 타인 파일 덮어쓰지 않음)
node scripts/doctor.mjs          # 설치·config·마지막 compat report 확인
node --experimental-strip-types scripts/compat.mjs --live   # 실제 omp -p 로 로드·저널 검증 (모델 호출 1회)
```

OMP를 업데이트한 뒤 할 일은 새 세션 한 번 열고 `doctor`를 보는 것이다. `compat-report`가 `ok`면 끝이다. `degraded`면 `missing`/`counters`가 어떤 계약이 깨졌는지 말해 준다. `compat/tested-versions.json`이 실제로 라이브 검증한 버전 목록이다.

## 이 계층이 하는 일

| 구성 | 내용 | 한계 |
|---|---|---|
| 운영 저널 | workspace별 SQLite(WAL, FULL sync). 도구 호출마다 intent→outcome. 세션별 writer lease와 epoch | 같은 OS 사용자 프로세스나 악성 확장을 격리하지 못함 |
| 중단·복구 | 하트비트 없이 lapse한 세션의 `executing` 효과는 `unknown`. `enforce` 모드에서는 해소 전까지 workspace의 새 효과 차단 | 외부 부작용의 실제 결과는 사람이 확인(`/runtime reconcile`) |
| 사용량 | 세션당 도구 호출·효과 카운트(관측용, 상한 없음). 재개해도 이어진다. 카운터가 작업을 멈추는 경로는 없다 | 모델 토큰·하위 에이전트 과금은 미포함 |
| 근거 | `runtime_evidence`: 파일 범위 hash 영수증. 게시 전 재검증 | hash는 진위·의미를 증명하지 않음 |
| 검색 경계 | `mcp__zvec_grep_search` 입력을 revise: limit≤10, autoUpdate:false, hidden/noIgnore/follow 제거, query group≤3 | zvec 자체를 수정하지 않음 |
| 메모리 outbox | 후보→승인→전송→ack/unknown. Utopia가 정본 | 전송 계층 미바인딩(아래) |
| 호환성 | API/컨텍스트 멤버 probe, 이벤트 counters, 버전별 report | 이벤트 payload 의미 변경은 counters로만 드러남 |

## 정책 기본값과 기존 시스템과의 관계

사용자 설정은 `tools.approvalMode: yolo`이고 승인은 `kubernetes-approval.ts`가 유일하게 담당한다. 이 계층은 그것을 이중 프롬프트로 덮지 않는다. `~/.omp/runtime/config.json`:

```json
{
  "mode": "enforce",            // "observe": 저널·카운트만, 차단 없음
  "blockOnUnknown": true,       // false: unknown 을 기록만 하고 효과를 계속 허용
  "headlessEffects": "allow",   // "deny": hasUI=false 세션(omp -p)의 write/edit/bash 등 차단
  "requireApproval": [],        // 예: ["eval"] → 정확 입력·1회용 승인 프롬프트
  "memoryReadTools": ["mcp__clab_mem_mem_search", "mcp__clab_mem_mem_read", "mcp__clab_mem_mem_status", "mcp__clab_mem_mem_task_lookup", "mcp__clab_mem_mem_task_read"],
  "structuredOperationTools": [], "targets": {}
}
```

`headlessEffects: allow`가 기본인 이유: AGENTS.md의 headless fail-closed 조항은 **Kubernetes 변경** 한정이고 그 경계는 이미 `kubernetes-approval.ts`가 강제한다. 서브에이전트는 확장을 로드하지 않으므로 이 옵션이 실제로 닿는 경로는 사용자가 직접 실행하는 `omp -p`뿐이며, `deny`는 그 경로를 읽기 전용으로 만든다. 더 보수적으로 가려면 한 줄을 바꾸면 된다. 이 결정에는 advisor의 이견이 있었다(`docs/ARCHITECTURE.md` §7).

`memoryReadTools`의 이름은 추측이 아니다. `~/.omp/agent/mcp.json`의 서버명 `clab-mem`과 `lazy-project/clab-mem/mcp/server.ts`의 도구 정의, 그리고 실행 중 OMP가 노출하는 `mcp__clab_mem_mem_*` 라우트에서 확인했다. 쓰기 도구(`mem_task_start/note/complete`, `mem_supersede`)는 효과로 계산된다.

## 운영 명령

```text
/runtime status
/runtime pause | resume
/runtime reconcile <action-id|all> [evidence-id…]     # 사람의 확인 기록. 자동 재실행 없음
/runtime publish <candidate-id> | reject <candidate-id> | reconcile-memory <candidate-id>
/runtime compat
```

모델 도구: `runtime_status`, `runtime_evidence`, `runtime_checkpoint`, `runtime_memory_candidate`. 게시·불명 해소는 모델 도구로 노출하지 않는다.

## 검증

```sh
node --experimental-strip-types --test tests/*.test.mjs   # 66 tests
node scripts/check.mjs                                    # JS syntax + tsc (types/pi-coding-agent.d.ts 기준)
node scripts/demo.mjs                                     # offline fake memory port
```

`docs/VERIFICATION.md`와 `evidence/`가 실제 수행 결과다. OMP 18.1.10 바이너리에서 `-e` 명시 로드와 auto-discovery 두 경로로 라이브 검증했고, 라이브에서만 드러난 결함(중첩 `xd://` 디스패치가 외부 호출과 같은 `toolCallId`를 공유) 하나를 고쳐 회귀 테스트로 남겼다.

## 아직 아닌 것

- **정본 메모리 전송은 미바인딩.** `/runtime publish`는 `MEMORY_PORT_UNBOUND`로 fail closed. clab-mem의 `mem_task_note`는 append-only이고 서버 측 idempotency key가 없어, 타임아웃 후 lookup 기반 dedupe는 인덱싱 지연 때문에 신뢰할 수 없다. 바인딩은 서버가 `(actor, idempotencyKey)` 유일성과 durable ack를 제공한 뒤에 한다(`docs/ARCHITECTURE.md` §6).
- **Kubernetes/GitOps 구조화 정책의 resolver/broker 없음.** `structuredOperationTools`/`targets`는 테스트된 정책 seam이지만 연결된 어댑터가 없다. 현재 클러스터 승인은 전적으로 `kubernetes-approval.ts`다.
- **격리 아님.** in-process 확장은 같은 프로세스의 다른 코드를 막지 못한다. OS sandbox/credential broker의 대체재가 아니다.

## 읽을 문서

`docs/ARCHITECTURE.md` 최종 구조와 결정. `docs/SOURCE-AUDIT.md` v18.1.10 소스에서 확인한 이벤트 계약. `docs/OPERATIONS.md` 설치·업데이트·복구. `docs/VERIFICATION.md` 수행한 검사.
