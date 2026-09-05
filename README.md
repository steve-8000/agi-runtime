# OMP AGI Runtime — extension-first

**OMP 위에 얹는 영속적인 runtime 계층. OMP core patch 0 파일. `brew upgrade omp` 후에도 그대로 로드된다.**

2026-09-05, Asia/Seoul 기준. 여기서 "AGI runtime"은 모델 능력을 지속적인 작업·근거·권한·복구에 연결하는 런타임의 프로젝트 이름이다. AGI 달성, 자기 의식, 범용성, 인간 수준 신뢰성을 입증했다는 뜻이 아니다.

## 결론

이전 버전은 OMP 소스(`wrapper.ts`)를 패치해 실행 경계를 넣었다. 실제 설치본은 Homebrew의 **컴파일된 단일 바이너리**(`omp/18.1.10`, 128MB)이므로 그 패치는 사용자의 실행 경로에 적용될 수 없었다. 이번 버전은 그 경계를 OMP의 **공개 확장 이벤트**로 옮겼다.

```text
tool_call            → intent()  : 정책, 회상·메모리 게이트, (opt-in) 정확 입력 승인, unknown 해소 게이트, `executing` 행
tool_execution_start → revise()  : 실제로 실행되는 입력 (다른 확장이 수정했을 수 있음)
tool_result          → settle()  : 원시 결과의 첫 관측 (다른 middleware 이전)
tool_execution_end   → settle()  : 최종 결과; isError 가 tool_result 와 뒤집히면 저널에 기록
turn_start           → turnStart(): 결과는 다음 turn 에서만 모델에게 보인다 — 회상 게이트의 기준
agent_end            → 알림만    : 기록되지 않은 효과 수. continue/block 은 절대 하지 않는다
```

**권한 모델.** 에이전트가 권한을 가진다. 사람 승인은 Kubernetes(clab-cluster 제외) 하나에만 남고 그것은 `kubernetes-approval.ts`와 §5.1 구조화 정책의 일이다. 이 계층은 관측자·문지기·원장이다: 절차를 강제하고(첫 효과 전 회상, 재시도 전 read-back, 인용한 근거의 현재성) 스스로 턴을 시작하지 않는다.

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
| 중단·복구 | 하트비트 없이 lapse한 세션의 `executing` 효과는 `unknown`. `enforce` 모드에서는 해소 전까지 같은 범위의 새 효과 차단(workspace unknown → workspace 효과, 메모리 unknown → 메모리 쓰기). 해소는 에이전트의 `runtime_reconcile`(read-back attestation) 또는 사람의 `/runtime reconcile` | 외부 부작용의 실제 결과는 read-back으로 확인해야 한다 |
| 회상 | `recall.mode: require`면 goal의 첫 효과는 회상 도구(`recall`/`entity`/`context_pack`)가 **이전 turn에 settle**된 뒤에만 실행된다. 실패한 회상도 settle이다. goal이 바뀌거나 세션을 재개하면 다시 요구한다 | 절차의 형태만 보장한다; 회상의 품질은 `recall.shallow` telemetry로 잰다 |
| 사용량 | 세션당 도구 호출·효과 카운트(관측용, 상한 없음). 재개해도 이어진다. 카운터가 작업을 멈추는 경로는 없다 | 모델 토큰·하위 에이전트 과금은 미포함 |
| 근거 | `runtime_evidence`: 파일 범위 hash 영수증. 메모리 쓰기가 인용하면 전송 전 현재성 검사 | hash는 진위·의미를 증명하지 않음 |
| 검색 | `mcp__zvec_grep_search`는 read로 저널에 남을 뿐이다. 입력을 바꾸지 않고, 실패는 `failed`(unknown 아님). 결과 첫 줄의 `freshness:`와 `hidden/noIgnore/follow` 사용을 관측하고(`search.scope` 이벤트), zvec 전에 순차 read한 파일 수를 센다. `before_agent_start`에 라우팅 힌트: 의미·cross-file 탐색은 zvec 먼저, 정확·전수 검색은 native, 확정은 현재 소스 | 검색 전략·freshness·limit은 OMP와 zvec의 책임 |
| 메모리 쓰기 | `remember`/`forget`은 원격 효과다. 오류 응답은 `unknown`(기록됐는지 불명)이고, 실행 입력이 게이트 통과 후 바뀐 호출도 `unknown`이다. 해소는 기록을 read-back한 뒤의 `runtime_reconcile`뿐 — 문구를 바꿔 다시 쓰는 것은 허용되지 않는다. 전송 전 검사: 자격증명·인용 근거의 현재성·직전 메모리 호출의 성공 | 도구 결과 본문은 전부 telemetry다; 상태를 바꾸는 것은 사람·에이전트의 attestation뿐 |
| 호환성 | API/컨텍스트 멤버 probe, 이벤트 counters(`turns` 포함), 버전별 report | 이벤트 payload 의미 변경은 counters로만 드러남 |

## 정책 기본값과 기존 시스템과의 관계

사용자 설정은 `tools.approvalMode: yolo`이고 승인은 `kubernetes-approval.ts`가 유일하게 담당한다. 이 계층은 그것을 이중 프롬프트로 덮지 않는다. `~/.omp/runtime/config.json`:

```json
{
  "mode": "enforce",            // "observe": 저널·카운트만, 차단 없음
  "blockOnUnknown": true,       // false: unknown 을 기록만 하고 효과를 계속 허용
  "headlessEffects": "allow",   // "deny": hasUI=false 세션(omp -p)의 write/edit/bash 등 차단
  "requireApproval": [],        // 예: ["eval"] → 정확 입력·1회용 승인 프롬프트
  "memoryReadTools": ["mcp__gbrain_recall", "mcp__gbrain_entity", "mcp__gbrain_context_pack", "mcp__gbrain_delta", "mcp__gbrain_synthesize"],
  "memoryWriteTools": ["mcp__gbrain_remember", "mcp__gbrain_forget"],
  "recall": { "mode": "require", "tools": ["mcp__gbrain_recall", "mcp__gbrain_entity", "mcp__gbrain_context_pack"] },
  "structuredOperationTools": [], "targets": {}
}
```

`recall.mode: require`는 운영자의 선언("이 환경에는 정본 메모리가 붙어 있다")이지만 **막다른 길이 될 수 없다**. 게이트는 세 가지로 스스로 열린다: settle된 회상, 회상 시도의 실패(도구 미등록·백엔드 무응답 → `recall.unavailable`), 그리고 같은 goal에서 회상이 settle되지 않은 채 3회 거절(`recall.forced`). 어느 경우든 상태와 저널에 왜 열렸는지 남는다. `/runtime recall skip`은 운영자용 최후 수단이며 정상 경로가 아니다.

`headlessEffects: allow`가 기본인 이유: AGENTS.md의 headless fail-closed 조항은 **Kubernetes 변경** 한정이고 그 경계는 이미 `kubernetes-approval.ts`가 강제한다. 서브에이전트는 확장을 로드하지 않으므로 이 옵션이 실제로 닿는 경로는 사용자가 직접 실행하는 `omp -p`뿐이며, `deny`는 그 경로를 읽기 전용으로 만든다. 더 보수적으로 가려면 한 줄을 바꾸면 된다. 이 결정에는 advisor의 이견이 있었다(`docs/ARCHITECTURE.md` §7).

`memoryReadTools`/`memoryWriteTools`의 이름은 `~/.omp/agent/mcp.json`의 서버명 `gbrain`과 그 서버가 노출하는 메모리 verb에서 온다: 읽기는 `recall`/`entity`/`context_pack`/`delta`/`synthesize`, 쓰기는 `remember`/`forget`. 한 도구가 두 목록에 동시에 들어갈 수 없다 — 두 부류의 게이트가 다르다. 쓰기에는 서버가 강제하는 멱등 키가 없으므로 이 계층은 결과 본문을 신뢰하지 않는다: 오류는 `unknown`이고, 닫는 방법은 read-back 뒤의 attestation뿐이다.

## 운영 명령

```text
/runtime status
/runtime pause | resume
/runtime reconcile <action-id|all> [evidence-id…]     # 사람의 확인 기록. 자동 재실행 없음
/runtime recall skip                                  # 회상 도구가 없는 세션을 위한 운영자 해제(goal 단위)
/runtime compat
```

모델 도구: `runtime_status`, `runtime_evidence`, `runtime_checkpoint`, `runtime_reconcile`. 정본 메모리에 쓰는 런타임 도구는 없다 — 쓰는 주체는 모델이고 이 계층은 검증·게이트·원장이다. 불명 해소는 에이전트의 attestation(`observed`에 read-back 결과)이며 저널에 `by: session`으로 남는다.

## 검증

```sh
node --experimental-strip-types --test tests/*.test.mjs   # 81 tests
node scripts/check.mjs                                    # JS syntax + tsc (types/pi-coding-agent.d.ts 기준)
node scripts/demo.mjs                                     # offline: recall gate → uncertain write → read-back attestation
```

`docs/VERIFICATION.md`와 `evidence/`가 실제 수행 결과다. OMP 18.1.10·18.1.11 바이너리에서 `-e` 명시 로드와 auto-discovery 두 경로로 라이브 검증했고, 라이브에서만 드러난 결함(중첩 `xd://` 디스패치가 외부 호출과 같은 `toolCallId`를 공유) 하나를 고쳐 회귀 테스트로 남겼다.

## 아직 아닌 것

- **런타임은 정본 메모리에 직접 쓰지 않는다.** 이 프로세스는 MCP 도구를 호출할 수 없다(`ctx.invokeTool`은 같은 이름의 built-in 위임뿐). 전송 주체는 모델이고 이 계층은 검증·게이트·원장이다(`docs/ARCHITECTURE.md` §6).
- **결과 본문으로 상태를 바꾸지 않는다.** 성공·실패는 호출의 `isError`와 exit code로만 판정하고 결과 텍스트는 telemetry다. 오류나 입력 변경으로 `unknown`이 된 메모리 쓰기는 read-back 뒤의 attestation으로만 닫힌다. `doctor`의 `memory-tools`는 도구 목록과 recall 모드만 확인한다.
- **Kubernetes/GitOps 구조화 정책의 resolver/broker 없음.** `structuredOperationTools`/`targets`는 테스트된 정책 seam이지만 연결된 어댑터가 없다. 현재 클러스터 승인은 전적으로 `kubernetes-approval.ts`다.
- **격리 아님.** in-process 확장은 같은 프로세스의 다른 코드를 막지 못한다. OS sandbox/credential broker의 대체재가 아니다.

## 읽을 문서

`docs/ARCHITECTURE.md` 최종 구조와 결정. `docs/SOURCE-AUDIT.md` v18.1.10 소스에서 확인한 이벤트 계약. `docs/OPERATIONS.md` 설치·업데이트·복구. `docs/VERIFICATION.md` 수행한 검사.
