# 0.5 Cutover

## 기준과 현재 상태

활성 0.4 Sharpshooter 구현 `4d50040`을 이 checkout으로 fast-forward한 뒤 0.5 변경을 적용했다. 기존 사용자 작업을 다른 구현으로 덮지 않았다. 이 호스트의 `~/.omp/agent/extensions/agi-runtime` symlink를 현재 checkout으로 전환했고 실제 새 OMP 프로세스에서 0.5.0 로드를 확인했다. 이미 실행 중인 세션은 시작 시 로드한 extension을 유지한다.

두 runtime extension을 동시에 설치하지 않는다. 모델 루프·메모리·인덱스 소유자를 복제하지 않는다.

## 실제 호스트 변경

| 대상 | 적용 |
|---|---|
| `~/.omp/agent/extensions/agi-runtime` | `/Users/steve/orca/workspaces/omp-agi-runtime/scallop`으로 활성화 |
| `~/.omp/runtime/config.json` | `{}`; 도구 read 분류는 고정 identity이며 override 없음 |
| `~/.omp/agent/AGENTS.md` | 완료 전 네이티브 루프 지속, 현재 code_intel 입력·JS cross-file semantics 규칙 명시 |
| `~/.omp/agent/rules/search-routing.md` | standalone zvec 우선 규칙을 lazy-intel 단일 경로로 교체 |
| `~/.omp/agent/extensions/zvec-autoindex.ts` | `~/.omp/runtime/retired/zvec-autoindex.ts`로 이동; 삭제하지 않음 |

MCP launch와 `memory.backend=sharpshooter`는 이미 맞는 호스트 설정을 유지했다. `config/AGENTS.md`, `config/rules/`, `config/mcp.json`은 현재 계약을 추적하는 비밀 없는 사본이다. 설치기가 이 파일들을 사용자 홈에 무조건 복사하지 않는다.

## 다른 호스트 적용

1. 설치된 OMP 버전과 extension event 계약을 확인한다. 이번 검증은 OMP 18.1.11이다.
2. 활성 사용자 AGENTS와 `config/AGENTS.md`의 정책 변경만 병합한다. 사용자 고유 정책·credentials·승인 hook을 보존한다.
3. lazy-intel MCP 하나에서 `tools/list`가 `code_intel` 하나를 내놓는지 확인한다. standalone zvec/CodeGraph/Serena MCP와 경쟁 auto-index extension을 비활성화한다. 하위 backend 자체는 lazy-intel이 실행할 수 있어야 한다.
4. `memory.backend=sharpshooter`를 유지한다. 외부 memory MCP와 수동 bank 쓰기를 도입하지 않는다.
5. runtime config를 `config/runtime.json`에 맞춘다. 사라진 memory gate/budget 키는 무시되며 경고되므로 정리한다.
6. `node scripts/install.mjs`의 target을 읽은 뒤 `--activate`한다. 새 프로세스로 `node scripts/upgrade-check.mjs --live`를 실행한다. 모델과 reasoning 설정은 OMP 메인 기본값을 그대로 사용한다.

이 설치기는 OMP/lazy-intel/Serena를 다운로드하거나 credentials를 배포하지 않는다. `config/mcp.json`의 절대 실행 경로는 이 호스트의 값이다. 다른 호스트는 실제 설치 경로에 맞춘다.

## 데이터와 호환성

- 기존 SQLite journal, lease, native session transcript, checkpoints를 삭제하지 않는다.
- retired external-memory unknown은 보존하되 로컬 read로 완료 인증하지 않는다. workspace 효과가 uncertain이면 실제 target을 읽고 `runtime_reconcile`한다.
- memory queue/state는 OMP Sharpshooter만 쓴다. runtime은 backend scope를 따라 읽고 resume 시 최대 5개 미통합 결정만 비권위 데이터로 전달한다.
- `.mjs` 프로젝트의 LSP 참조에 프로젝트 경계가 필요하므로 `jsconfig.json`을 추가했다. 빈 결과를 무호출 근거로 취급하지 않는다.

## Rollback 범위

```sh
node scripts/install.mjs --rollback
```

직전 extension symlink만 복구한다. 사용자 정책·runtime config·MCP·native OMP 버전은 되돌리지 않는다. 이전 target은 `/Users/steve/omp-agi-runtime`이었다. 구형 독립 zvec 인덱싱을 의도적으로 되살릴 경우에만 retired 파일을 원위치한다. lazy-intel과 동시 소유하게 만드는 기본 rollback은 권장하지 않는다.

Kubernetes/Argo CD/production workload는 변경하지 않았다. 이 cutover가 다른 클러스터의 배포 승인으로 확장되지 않는다.
