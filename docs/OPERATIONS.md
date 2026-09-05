# 운영: 설치, 업데이트, 복구

## 1. 범위

기존 OMP 바이너리, `~/.omp/agent/*`, 정본 메모리(gbrain), zvec index, Kubernetes를 수정하지 않는다. 이 계층이 쓰는 곳은 두 군데다: `~/.omp/agent/extensions/agi-runtime` symlink 하나, 그리고 `~/.omp/runtime/`. workspace 안에는 아무것도 쓰지 않는다.

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

probe한 멤버가 사라져 attach가 실패하면 기본 동작은 **runtime 비활성**이다(`OMP_RUNTIME_REQUIRED=1`이 도구를 막는 것은 이 호스트 계약 위반뿐이다 — 낡은 운영자 config나 다른 세션이 쥔 lease는 비활성으로만 이어진다): 알림 한 줄(`AGI Runtime disabled: EXTENSION_CONTRACT_MISMATCH …`), 저널 없음, OMP 도구는 평소처럼 동작, report는 `degraded`. 무인 실행처럼 경계가 필수인 곳은 `OMP_RUNTIME_REQUIRED=1`로 실행한다 — attach 실패 시 모든 `tool_call`을 `RUNTIME_HANDLER_REQUIRED`로 차단한다. 단, `pi.on`이 없거나 factory가 load 중 throw해 핸들러가 설치되지 않으면 REQUIRED도 차단하지 못한다; 그 경우 `compat-report: none`과 OMP의 extension load error가 유일한 신호다. 이벤트 의미만 바뀐 경우(`counters.unmatched* > 0`)는 report만 `degraded`이고 커널은 설정된 `mode`로 계속 동작한다.

## 5. 운영자 정책 (`~/.omp/runtime/config.json`)

| 키 | 기본 | 효과 |
|---|---|---|
| `mode` | `enforce` | `observe`: unknown·poison으로 차단하지 않고 기록만 |
| `blockOnUnknown` | `true` | lapse한 효과가 해소될 때까지 workspace의 새 효과 차단 |
| `headlessEffects` | `allow` | `deny`: `hasUI=false` 세션의 효과 차단(`omp -p` 포함). k8s는 어느 쪽이든 `kubernetes-approval.ts`가 headless 차단 |
| `requireApproval` | `[]` | 나열한 도구는 정확 입력·1회용 승인 프롬프트(UI 필요) |
| `memoryReadTools` | `[]` (샘플: gbrain 읽기 5종) | 정확한 이름만 read로 분류. 근거: `mcp.json` 서버명 `gbrain`과 그 서버의 메모리 verb, OMP 라우트 `mcp__gbrain_*` |
| `memoryWriteTools` | `[]` (샘플: `remember`, `forget`) | 원격 쓰기. 오류·입력 변경은 `unknown(remote)`, 해소는 read-back 뒤 attestation, 전송 전 검사(자격증명·인용 근거 현재성·직전 호출 성공). 읽기 목록과 겹칠 수 없다 |
| `recall` | `{mode: advise, tools: []}` | `require`: goal의 첫 효과 전에 `tools` 중 하나가 이전 turn에 settle되어야 함. `tools ⊆ memoryReadTools`, `require`면 비어 있을 수 없음. turn 3회 거절 또는 회상 시도의 실패로 스스로 열림(§6.1.1). 메모리 도구가 상시 없는 환경은 `advise` |
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
/runtime recall skip                    # recall 게이트를 이 goal에 한해 해제한다. 세션에 회상 도구가 아예 없을 때만; 이벤트 `recall.override`로 기록되고 모델은 호출할 수 없다
```

둘 다 attestation이고 저널에 `by: session`으로 남는다. 자동 재실행은 없다. `unknown`은 범위가 있어서 메모리 쓰기의 불명은 메모리 쓰기만 막고(`uncertainRemote`), working tree 효과는 `blockedUntilReconciled`가 true일 때만 막힌다. `blockOnUnknown:false`로 두면 차단 없이 기록만 남는다.

### 6.1.1 회상 게이트에 막힘

`RECALL_REQUIRED`는 이 goal에서 아직 회상 도구가 이전 turn에 settle되지 않았다는 뜻이다. `recall`/`entity`/`context_pack`을 부르고 **다음 메시지**에서 효과를 다시 낸다. 같은 메시지에 병렬로 낸 효과는 항상 거절된다.

게이트는 막다른 길이 되지 않는다 — 사람 개입 없이 세 경로로 열린다:

| 경로 | 조건 | 상태 / 저널 |
|---|---|---|
| settle된 회상 | 이전 turn에 회상이 마감 | `recall.state: done` |
| 시도의 실패 | 회상이 `failed`로 마감(백엔드 오류·타임아웃). 결과 문구가 도구 미등록(`No such tool`)이면 부재로 구분한다 | `failed`, 부재는 `unavailable` / `recall.unavailable` |
| 반복 거절 | 같은 goal에서 회상 settle 없이 3회 거절 | `forced` / `recall.forced` |

`/runtime recall skip`은 운영자 override(goal 하나)로 남아 있지만 정상 경로가 아니다. 도구가 상시 없는 환경은 `recall.mode: advise`가 맞다.

### 6.1.2 메모리 쓰기가 막힘

| 코드 | 뜻 | 조치 |
|---|---|---|
| `MEMORY_BACKEND_DEGRADED` | 직전 메모리 호출의 결과가 **불명** | 기록을 읽어 확인(`recall`/`entity`)한 뒤 다시. 실패(확정)는 막지 않는다 — 재시도가 blind가 아니므로 |
| `MEMORY_SECRET` | 입력에 자격증명 패턴 | 값을 빼고 다시. 서버 redact는 안전망이지 허가가 아니다 |
| `STALE_EVIDENCE` | 인용한 evidence의 파일이 바뀜 | `runtime_evidence`로 다시 받아 인용 |
| `RECONCILIATION_REQUIRED` (메모리) | 불명인 메모리 쓰기가 있음 | `recall`/`entity`로 실제 기록을 확인한 뒤 `runtime_reconcile` |

### 6.2 사용량 카운터

`/runtime status`의 `toolCalls`·`effectsUsed`는 관측용이다. 상한·갱신 명령·차단 코드는 없다. 예전 config의 `maxToolCalls` / `maxEffects` / `maxWallMs`는 `UNKNOWN_RUNTIME_CONFIG_KEY`로 attach를 실패시키므로 `~/.omp/runtime/config.json`에서 지운다.

### 6.3 저널 손상·디스크

실행 후 저널 쓰기가 실패하면 그 세션은 **관측으로 강등**된다: 효과는 계속 실행되고, `journal.degraded` 이벤트 한 건과 `/runtime status`의 `poisoned: true`로 원장이 불완전하다는 사실만 남는다(차단하지 않는다 — 예전에는 세션 재시작이 유일한 해제였다). 이후 기록은 신뢰할 수 없으니 그 세션의 완료 보고에 명시한다. 저널 파일은 `~/.omp/runtime/journals/<digest>.sqlite`; 삭제하면 그 workspace의 이력·unknown·사용량이 사라진다. 알려진 이전 스키마(v2·v3)는 열 때 전진 마이그레이션한다(후보 큐 테이블을 버리고 `user_version=4`). 행위 저널은 그대로 남는다. 그 밖의 스키마는 `UNSUPPORTED_SCHEMA`로 거절한다 — 파일을 옮기고 새로 시작한다.

### 6.4 lease

lease는 **저널의 소유권**을 정하고 workspace 파일을 잠그지 않는다. 그래서 lease 문제로 도구가 막히지 않는다:

- 이 세션의 lease가 만료됐고(프로세스 정지·시계 점프) 아무도 안 잡고 있으면 다음 저널 쓰기에서 **되찾는다**: 새 epoch, `writer.reclaimed` 이벤트, 이전 epoch의 in-flight 행은 sweep이 `unknown`으로 넘긴다.
- 살아 있는 다른 프로세스가 같은 세션을 잡고 있으면(`SESSION_WRITER_BUSY`) 빼앗지 않는다. 이 세션은 **저널 없이** 계속 일하고 `poisoned: true`로 그 사실을 노출한다 — 완료 보고에 명시해야 한다. 저널이 필요하면 다른 쪽을 닫고 30초 뒤 새 세션.

### 6.5 롤백

```sh
node scripts/install.mjs --uninstall
```

symlink만 제거한다. 다음 세션부터 확장이 로드되지 않는다. `~/.omp/runtime`은 그대로 남아 재설치 시 이력이 이어진다.

## 7. 메모리

정본 메모리는 gbrain이고 쓰는 주체는 모델이다. 런타임은 검증·게이트·원장이며 이 프로세스에서 나가는 메모리 트래픽은 없다.

**사실 기록** — `remember`(사실 하나, `provenance` 필수, 대상이 있으면 `entity`), `forget`(id 만료). 결과 본문은 telemetry다: 오류는 `unknown(remote)`이고, 문구를 바꿔 다시 쓰는 것은 두 번 기록할 위험이므로 허용되지 않는다.

**불명 해소** — 기록을 `recall`/`entity`로 읽어 실제 상태를 확인한 뒤 `runtime_reconcile`에 관측 내용을 적는다. 저널에 `by: session`으로 남는다. 사람이 대신 확인했다면 `/runtime reconcile <action-id> [evidence-id…]`.

**crash·lapse** — 쓰기 도중 프로세스가 죽으면 그 행은 `unknown(remote)`이다. 다음 세션의 resume card와 `uncertainRemote`에 보이고, 같은 방식으로 read-back 뒤 닫는다.

**근거** — `runtime_evidence`로 파일 범위 hash 영수증을 받고 사실 본문에 그 id를 인용하면, 전송 전에 파일이 그대로인지 검사한다(`STALE_EVIDENCE`). 인용하지 않은 사실은 허용되고 `memory.unverified`로 센다.
