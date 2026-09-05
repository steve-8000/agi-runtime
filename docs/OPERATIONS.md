# 운영: 설치, 업데이트, 복구

## 1. 범위

기존 OMP 바이너리, `~/.omp/agent/*`, Utopia(`mem.clab.one`), zvec index, Kubernetes를 수정하지 않는다. 이 계층이 쓰는 곳은 두 군데다: `~/.omp/agent/extensions/agi-runtime` symlink 하나, 그리고 `~/.omp/runtime/`. workspace 안에는 아무것도 쓰지 않는다. 메모리 receipt 계약의 반대편은 clab-mem MCP 서버(`lazy-project/clab-mem/mcp/`, 별도 저장소)이고 그 서명키는 `~/.clab-mem/receipt-signing.key`다 — Utopia 자체는 그대로다.

파일 위치가 OMP 밖이라고 같은 OS 사용자의 프로세스에서 보호되는 것은 아니다. 권한 격리는 별도 OS account/sandbox/broker의 일이다.

## 2. 설치

```sh
cd <checkout>
node scripts/install.mjs
```

- `~/.omp/agent/extensions/agi-runtime → <이 저장소>` symlink. 대상에 우리 것이 아닌 파일/링크가 있으면 `FOREIGN_EXTENSION_AT_TARGET`으로 중단한다.
- `~/.omp/runtime/{journals,compat}` 생성(0700), `config.json`이 없으면 `config/runtime.json`으로 시드. 이후 파일은 운영자 소유다.
- `--uninstall`은 우리 symlink만 지운다. `~/.omp/runtime`은 남긴다.

OMP는 `~/.omp/agent/extensions/*`를 한 단계 스캔하며 디렉터리의 `package.json#omp.extensions`를 진입점으로 쓴다(`omp://extension-loading.md`). 이 저장소의 `package.json`이 `./extension/index.ts`를 선언한다. `--profile <name>`을 쓰면 `~/.omp/profiles/<name>/agent/extensions`에 별도 설치가 필요하고 runtime dir도 `~/.omp/profiles/<name>/runtime`이 된다(`pi.pi.getAgentDir()` 기준).

확장은 **새 세션**부터 로드된다. 이미 열린 OMP 세션은 영향을 받지 않는다.

## 3. 확인

```sh
node scripts/doctor.mjs
```

`omp-binary`, `tested-version`(`compat/tested-versions.json`에 라이브 검증 기록이 있는가), `extension-link`, `runtime-config`, 그리고 현재 OMP 버전의 `compat-report`를 보여 준다. `compat-report: none`은 아직 어떤 세션도 이 버전으로 확장을 로드하지 않았다는 뜻이다.

```sh
OMP_COMPAT_MODEL=openai-codex/gpt-5.6-luna node --experimental-strip-types scripts/compat.mjs --live
```

임시 workspace에서 실제 `omp -p`를 `OMP_RUNTIME_REQUIRED=1`로 실행해 `read`와 `bash`가 저널에 `succeeded`로 남고 compat report가 `ok`인지 확인한다. 모델 호출 1회가 든다. `--live` 없이 실행하면 mock 계약만 검사한다.

## 4. OMP 업데이트 절차

```sh
brew upgrade omp
omp --version
omp                      # 아무 저장소에서 새 세션 한 번 (또는 compat --live)
node scripts/doctor.mjs
```

| doctor 결과 | 뜻 | 조치 |
|---|---|---|
| `compat-report: ok`, `tested-version: untested` | 계약 유지. 이 버전은 아직 목록에 없음 | `compat --live` 통과 후 `compat/tested-versions.json`에 추가 |
| `compat-report: degraded`, `missing: [...]` | API/컨텍스트 멤버가 사라짐 | `extension/compat.ts`의 멤버 목록과 `types/pi-coding-agent.d.ts`를 새 소스로 갱신. `attachError` 참고 |
| `compat-report: ok`, `counters.unmatched* > 0` | 이벤트 순서/식별자 의미 변경 | `docs/SOURCE-AUDIT.md` 절차로 새 태그의 `wrapper.ts`/`shared-events.ts`를 다시 읽고 커널 매핑 수정 |
| `compat-report: none` (새 세션 후에도) | 확장이 로드되지 않음 | OMP 로그의 extension load error 확인. `omp -e /path/extension/index.ts -p "…"`로 직접 로드해 오류 재현 |

새 태그의 소스는 `https://raw.githubusercontent.com/can1357/oh-my-pi/v<version>/packages/coding-agent/src/…`에서 받는다. 검사 대상은 `extensibility/extensions/types.ts`, `extensibility/shared-events.ts`, `extensibility/extensions/wrapper.ts`, `index.ts`(`VERSION`, `getAgentDir` export).

probe한 멤버가 사라져 attach가 실패하면 기본 동작은 **runtime 비활성**이다: 알림 한 줄(`AGI Runtime disabled: EXTENSION_CONTRACT_MISMATCH …`), 저널 없음, OMP 도구는 평소처럼 동작, report는 `degraded`. 무인 실행처럼 경계가 필수인 곳은 `OMP_RUNTIME_REQUIRED=1`로 실행한다 — attach 실패 시 모든 `tool_call`을 `RUNTIME_HANDLER_REQUIRED`로 차단한다. 단, `pi.on`이 없거나 factory가 load 중 throw해 핸들러가 설치되지 않으면 REQUIRED도 차단하지 못한다; 그 경우 `compat-report: none`과 OMP의 extension load error가 유일한 신호다. 이벤트 의미만 바뀐 경우(`counters.unmatched* > 0`)는 report만 `degraded`이고 커널은 설정된 `mode`로 계속 동작한다.

## 5. 운영자 정책 (`~/.omp/runtime/config.json`)

| 키 | 기본 | 효과 |
|---|---|---|
| `mode` | `enforce` | `observe`: unknown·poison으로 차단하지 않고 기록만 |
| `blockOnUnknown` | `true` | lapse한 효과가 해소될 때까지 workspace의 새 효과 차단 |
| `headlessEffects` | `allow` | `deny`: `hasUI=false` 세션의 효과 차단(`omp -p` 포함). k8s는 어느 쪽이든 `kubernetes-approval.ts`가 headless 차단 |
| `requireApproval` | `[]` | 나열한 도구는 정확 입력·1회용 승인 프롬프트(UI 필요) |
| `memoryReadTools` | `[]` (샘플: clab-mem 읽기 5종) | 정확한 이름만 read로 분류. 근거: `mcp.json` 서버명 `clab-mem`, `lazy-project/clab-mem/mcp/server.ts` 도구 정의, OMP 라우트 `mcp__clab_mem_mem_*` |
| `memoryWriteTools` | `[]` (샘플: clab-mem 쓰기 4종) | 비멱등 원격 append. 오류는 `unknown(remote)`, 같은 `idempotency_key` 재발행만 허용, 전송 전 검사(자격증명·stale evidence·백엔드 상태·task key) |
| `memoryTaskStartTool` | `''` | `memoryWriteTools` 중 새 task key를 처음 말해도 되는 도구. 나머지 쓰기는 이 세션에서 start/read로 확인된 키만 |
| `memoryPublishTool` | `''` | 후보 승격 도구. 입력이 `runtime_memory_candidate`가 준 후보·payloadHash와 정확히 일치해야 통과 |
| `memoryReceiptPublicKey` | `''` | clab-mem 서버의 Ed25519 공개키(hex 64). 비어 있으면 receipt는 telemetry, 불명 해소는 attestation뿐. 값은 `cd lazy-project/clab-mem && bun mcp/receipt.ts` 출력의 `publicKeyHex` |
| `recall` | `{mode: advise, tools: []}` | `require`: goal의 첫 효과 전에 `tools` 중 하나가 이전 turn에 settle되어야 함. `tools ⊆ memoryReadTools`, `require`면 비어 있을 수 없음. 자동 해제 없음 — clab-mem이 없는 환경은 `advise` |
| `structuredOperationTools` / `targets` | `[]` / `{}` | 신뢰된 infra 어댑터가 공급하는 descriptor와 target fingerprint. 현재 어댑터 없음 |

잘못된 파일은 attach를 실패시킨다(`INVALID_RUNTIME_MODE` 등). 조용히 기본값으로 떨어지지 않는다. `OMP_RUNTIME_CONFIG`로 경로를, `OMP_RUNTIME_DIR`로 runtime dir 전체를 바꿀 수 있다.

config에 **새 키**를 넣으면 이미 실행 중인 OMP 세션은 다음 attach(`/new`, `/resume`)에서 메모리에 올라 있는 옛 검증기로 그 파일을 읽어 `UNKNOWN_RUNTIME_CONFIG_KEY`로 disabled가 되고 compat report를 `degraded`로 덮어쓴다(실측: `memoryWriteTools` 추가 뒤 옛 세션의 `session_switch`). 코드와 config를 함께 올린 뒤에는 열려 있는 세션을 재시작한다. `doctor`가 `degraded`를 보이면 `attachError`를 먼저 본다.

cwd가 `$HOME`인 세션은 runtime dir이 workspace 안이므로 `STATE_MUST_BE_OUTSIDE_WORKSPACE`로 attach하지 않는다(의도된 거절; 도구는 평소처럼 동작). 프로젝트 디렉터리에서 연다.

## 6. 복구

### 6.1 결과 불명 효과

세션 시작 시 알림: `N건의 결과 불명 변경이 있습니다`. `runtime_status`/`/runtime status`로 `uncertainActions`(action id, tool, input hash 앞부분, 세션)를 본다. 실제 대상(working tree, git, 원격 기록)을 읽은 뒤:

```text
runtime_reconcile({ actionIds: ["<id>"|"all"], observed: "<읽어서 확인한 내용>", evidenceIds: [] })   # 에이전트
/runtime reconcile <action-id|all> [evidence-id…]                                                      # 사람
```

둘 다 attestation이고 저널에 `by: session`으로 남는다. 자동 재실행은 없다. `unknown`은 범위가 있어서 메모리 쓰기의 불명은 메모리 쓰기만 막고(`uncertainRemote`), working tree 효과는 `blockedUntilReconciled`가 true일 때만 막힌다. 메모리 쓰기의 불명은 같은 `idempotency_key`로 재발행할 수 있고, 서버의 서명 receipt가 검증되면 그 행이 `by: receipt`로 자동으로 닫힌다. `blockOnUnknown:false`로 두면 차단 없이 기록만 남는다.

### 6.1.1 회상 게이트에 막힘

`RECALL_REQUIRED`는 이 goal에서 아직 회상 도구가 이전 turn에 settle되지 않았다는 뜻이다. `mem_search`/`mem_task_lookup`/`mem_task_read`를 부르고 **다음 메시지**에서 효과를 다시 낸다. 같은 메시지에 병렬로 낸 효과는 항상 거절된다. clab-mem이 없는 환경이면 `recall.mode`를 `advise`로 — 게이트는 횟수로 풀리지 않는다.

### 6.1.2 메모리 쓰기가 막힘

| 코드 | 뜻 | 조치 |
|---|---|---|
| `MEMORY_BACKEND_DEGRADED` | 직전 clab-mem 호출이 실패/불명 | `mem_status` 한 번 성공시킨 뒤 다시 |
| `MEMORY_TASK_NOT_STARTED` | 이 세션에서 그 task key를 start/read한 적 없음 | `mem_task_lookup`으로 키 확인 → `mem_task_read` 또는 `mem_task_start` |
| `MEMORY_SECRET` | 입력에 자격증명 패턴 | 값을 빼고 다시. 서버 redact는 안전망이지 허가가 아니다 |
| `STALE_EVIDENCE` | 인용한 evidence의 파일이 바뀜 | `runtime_evidence`로 다시 받아 인용 |
| `MEMORY_CANDIDATE_MISMATCH` | publish 입력이 staged 후보와 다름 | `runtime_memory_candidate`가 준 candidateId·payloadHash와 같은 kind/title/content/evidence_ids 로 |
| `RECONCILIATION_REQUIRED` (메모리) | 불명인 메모리 쓰기가 있음 | 같은 `idempotency_key`로 재발행하거나, `mem_task_read`로 확인 후 `runtime_reconcile` |

### 6.2 사용량 카운터

`/runtime status`의 `toolCalls`·`effectsUsed`는 관측용이다. 상한·갱신 명령·차단 코드는 없다. 예전 config의 `maxToolCalls` / `maxEffects` / `maxWallMs`는 `UNKNOWN_RUNTIME_CONFIG_KEY`로 attach를 실패시키므로 `~/.omp/runtime/config.json`에서 지운다.

### 6.3 저널 손상·디스크

실행 후 저널 쓰기가 실패하면 `RUNTIME_JOURNAL_POISONED`로 이후 효과를 차단한다(enforce). 세션 재시작으로 풀린다. 저널 파일은 `~/.omp/runtime/journals/<digest>.sqlite`; 삭제하면 그 workspace의 이력·unknown·사용량이 사라진다. 알려진 이전 스키마(v2)는 열 때 전진 마이그레이션한다(outbox 상태 `approved→candidate`, `sending→unknown`, `acked→published`, `user_version=3`). 그 밖의 스키마는 `UNSUPPORTED_SCHEMA`로 거절한다 — 파일을 옮기고 새로 시작한다.

### 6.4 lease

`FENCED_WRITER`는 이 세션의 lease가 만료됐다는 뜻이다(프로세스 정지, 시계 점프). 확장은 `abort()`를 호출하고 알린다. 새 세션이 답이다. `SESSION_WRITER_BUSY`는 같은 세션 ID를 다른 프로세스가 잡고 있다는 뜻이다(같은 세션을 두 터미널에서 resume). 하나를 닫고 30초 뒤 다시.

### 6.5 롤백

```sh
node scripts/install.mjs --uninstall
```

symlink만 제거한다. 다음 세션부터 확장이 로드되지 않는다. `~/.omp/runtime`은 그대로 남아 재설치 시 이력이 이어진다.

## 7. 메모리

두 경로, 전송은 둘 다 모델이다.

**작업 원장** — `mem_task_start/note/complete`, `mem_supersede`. 서버가 `idempotency_key`를 필수로 받는다: 새 절이면 새 값, 타임아웃 뒤 재시도는 **같은 값**(서버가 같은 절을 두 번 붙이지 않고 `action=duplicate`를 돌려준다). 결과 첫 줄이 서명 receipt다.

**정본 승격** — `runtime_memory_candidate`(kind·title·content·evidenceIds) → 돌려받은 `candidateId`·`payloadHash`로 `mem_publish({candidate_id, idempotency_key: candidate_id, payload_hash, kind, title, content, evidence_ids})` → `submitted` → 검증된 receipt로 `published`. `pendingMemory`는 `candidate|submitted|unknown` 수다. `/runtime reject <id>`로 폐기.

**서명 키** — clab-mem 쪽에서 한 번:

```sh
cd ~/lazy-project/clab-mem && bun mcp/receipt.ts      # ~/.clab-mem/receipt-signing.key (0600) 생성, publicKeyHex 출력
```

출력의 `publicKeyHex`를 `~/.omp/runtime/config.json`의 `memoryReceiptPublicKey`에 넣는다. 키 교체는 파일을 지우고 다시 만든 뒤 config를 갱신한다 — 그 사이의 receipt는 검증되지 않고 telemetry로 남는다. `node scripts/doctor.mjs`의 `memory-receipts: verifiable`이 확인이다.

**crash·lapse** — 쓰기 도중 프로세스가 죽으면 그 행은 `unknown(remote)`이다. 다음 세션의 resume card와 `uncertainRemote`에 보인다. `mem_task_read`로 절이 붙었는지 읽고 `runtime_reconcile`, 또는 같은 `idempotency_key`로 재발행.
