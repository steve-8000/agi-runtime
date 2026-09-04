# 운영: 설치, 업데이트, 복구

## 1. 범위

기존 OMP 바이너리, `~/.omp/agent/*`, `mem.clab.one`, zvec index, Kubernetes를 수정하지 않는다. 쓰는 곳은 두 군데다: `~/.omp/agent/extensions/agi-runtime` symlink 하나, 그리고 `~/.omp/runtime/`. workspace 안에는 아무것도 쓰지 않는다.

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
| `mode` | `enforce` | `observe`: 예산·unknown·poison으로 차단하지 않고 기록만 |
| `maxToolCalls` / `maxEffects` / `maxWallMs` | 500 / 100 / 3,600,000 | 세션당. 재개해도 유지. `/runtime renew-budget` |
| `blockOnUnknown` | `true` | lapse한 효과가 해소될 때까지 workspace의 새 효과 차단 |
| `headlessEffects` | `allow` | `deny`: `hasUI=false` 세션의 효과 차단(`omp -p` 포함). k8s는 어느 쪽이든 `kubernetes-approval.ts`가 headless 차단 |
| `requireApproval` | `[]` | 나열한 도구는 정확 입력·1회용 승인 프롬프트(UI 필요) |
| `memoryReadTools` | clab-mem 읽기 5종 | 정확한 이름만 read로 분류. 근거: `mcp.json` 서버명 `clab-mem`, `lazy-project/clab-mem/mcp/server.ts` 도구 정의, OMP 라우트 `mcp__clab_mem_mem_*` |
| `structuredOperationTools` / `targets` | `[]` / `{}` | 신뢰된 infra 어댑터가 공급하는 descriptor와 target fingerprint. 현재 어댑터 없음 |

잘못된 파일은 attach를 실패시킨다(`INVALID_RUNTIME_MODE` 등). 조용히 기본값으로 떨어지지 않는다. `OMP_RUNTIME_CONFIG`로 경로를, `OMP_RUNTIME_DIR`로 runtime dir 전체를 바꿀 수 있다.

## 6. 복구

### 6.1 결과 불명 효과

세션 시작 시 알림: `N건의 결과 불명 변경이 있습니다`. `/runtime status`로 `uncertainActions`(action id, tool, input hash 앞부분, 세션)를 본다. 실제 대상(working tree, 원격)을 직접 확인한 뒤:

```text
/runtime reconcile <action-id>            # 하나
/runtime reconcile all                    # 전부
/runtime reconcile <action-id> <evidence-id…>   # runtime_evidence 영수증을 근거로 첨부(선택)
```

확인 대화상자는 사람의 attestation이다. 자동 재실행은 없다. `blockOnUnknown:false`로 두면 차단 없이 기록만 남는다.

### 6.2 예산

`TOOL_BUDGET_EXHAUSTED` / `EFFECT_BUDGET_EXHAUSTED` / `WALL_BUDGET_EXHAUSTED` → `/runtime renew-budget`. unknown이 남아 있으면 갱신을 거절한다.

### 6.3 저널 손상·디스크

실행 후 저널 쓰기가 실패하면 `RUNTIME_JOURNAL_POISONED`로 이후 효과를 차단한다(enforce). 세션 재시작으로 풀린다. 저널 파일은 `~/.omp/runtime/journals/<digest>.sqlite`; 삭제하면 그 workspace의 이력·unknown·예산이 사라진다. 스키마가 다르면(`UNSUPPORTED_SCHEMA`) 마이그레이션하지 않고 거절한다 — 파일을 옮기고 새로 시작한다.

### 6.4 lease

`FENCED_WRITER`는 이 세션의 lease가 만료됐다는 뜻이다(프로세스 정지, 시계 점프). 확장은 `abort()`를 호출하고 알린다. 새 세션이 답이다. `SESSION_WRITER_BUSY`는 같은 세션 ID를 다른 프로세스가 잡고 있다는 뜻이다(같은 세션을 두 터미널에서 resume). 하나를 닫고 30초 뒤 다시.

### 6.5 롤백

```sh
node scripts/install.mjs --uninstall
```

symlink만 제거한다. 다음 세션부터 확장이 로드되지 않는다. `~/.omp/runtime`은 그대로 남아 재설치 시 이력이 이어진다.

## 7. 메모리 outbox

`runtime_memory_candidate`(모델) → `/runtime publish <id>`(사람) → 전송 → `acked` 또는 `unknown`. 전송 계층이 바인딩되지 않은 현재는 `publish`가 `MEMORY_PORT_UNBOUND`로 멈춘다. 후보는 저널에 남으며 `/runtime status`의 `pendingMemory`로 보인다. `/runtime reject <id>`로 폐기. 실제 기록은 지금처럼 clab-mem 도구(`mem_task_*`)를 모델이 직접 호출하는 경로가 정본이다; 그 호출은 이 계층에서 효과로 저널된다.
