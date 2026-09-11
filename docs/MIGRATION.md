# Policy migration and runtime activation

## 범위

이번 개정은 정책·규칙·참조 문서 변경이다. runtime 0.5.0, MCP launch 설정, 승인 hook, journal, memory, backend 코드와 버전은 변경하지 않는다. GitHub의 파일 변경은 활성 호스트에 적용했다는 뜻이 아니다.

`config/AGENTS.md`는 병합할 호스트 정책 정본이다. `config/AGENTS.runtime.md`는 마이그레이션 안내일 뿐 별도 주입 대상이 아니다. 두 정책을 중복 주입하지 않는다. 저장소 루트의 `AGENTS.md`는 이 저장소 작업을 위한 진입점이며 사용자 홈을 수정하지 않는다.

## 기존 호스트에 정책만 적용

먼저 실제 active agent directory를 확인한다. 기본은 `~/.omp/agent`지만 profile 또는 `PI_CODING_AGENT_DIR`가 다르면 그 경로를 따른다. 경로를 추측해서 다른 profile에 설치하지 않는다.

변경 전 활성 AGENTS와 해당 규칙의 원본·권한을 복구 가능한 위치에 보존한다. 사용자 고유 정책, credentials, 승인 설정, 다른 rule은 그대로 둔다. 기존 정책의 해당 절만 새 정본과 병합하고, 변경 diff에서 안전 경계가 동일한지 확인한다. 기존 `clab-cluster` 예외를 다른 대상의 권한으로 확장하지 않는다.

| 저장소 템플릿 | 호스트의 대응 위치 |
|---|---|
| `config/AGENTS.md` | active agent directory의 `AGENTS.md`에 해당 절 병합 |
| `config/rules/search-routing.md` | `rules/search-routing.md` |
| `config/rules/implementation-loop.md` | `rules/implementation-loop.md` |
| `config/rules/design-routing.md` | `rules/design-routing.md` |

OMP 18.1.11에서 description을 가진 이 규칙들은 rulebook 항목이며 본문이 항상 주입되는 파일이 아니다. `alwaysApply`, catch-all trigger 또는 TTSR enforcement를 추가하지 않는다. `agents` 필터는 노출 제어이지 쓰기 권한 강제가 아니다.

rule 이름은 파일명 기준이고 동일 이름은 discovery 우선순위에 따라 가려질 수 있다. project `.omp/rules`, 다른 provider, profile에 같은 이름의 오래된 규칙이 남아 있지 않은지 확인한다. 무관한 규칙을 삭제하지 말고 충돌하는 소유 사본만 정리한다. 새 세션에서 실제 `rule://search-routing`이 새 본문으로 해석되는지 확인한다.

## lazy-intel 사용이 유지되는지 확인

이 확인은 최초 적용 또는 연결 변경 때의 검증이지 모든 검색 전 preflight가 아니다.

실제 tool discovery에서 lazy-intel의 intelligence 도구가 `code_intel` 하나인지 확인하고, standalone zvec-grep/CodeGraph/Serena MCP와 경쟁 autoindex extension은 비활성 상태를 유지한다. 하위 backend 실행은 lazy-intel의 책임이다. lazy-ios/figma-bridge는 이 단일 intelligence 경계와 무관하다.

`config/mcp.json`은 기존 호스트의 절대 경로를 포함한 추적본이다. 다른 호스트에 그대로 복사하지 않는다. 실제 checkout의 canonical path가 설정된 `LAZY_INTEL_ALLOWED_ROOTS`에 들어가는지 확인하고 모든 query에 실제 `root`를 명시한다. 경로 거부를 해결한다며 `/`, 전체 home 또는 임의 부모 경로로 allowlist를 넓히지 않는다. 필요한 권한 변경은 별도로 승인받는다.

새 세션에서 [POLICY-VALIDATION.md](POLICY-VALIDATION.md)의 자연어 시나리오로 의미 질문의 intelligence 선택과 정확한 검색의 native 선택을 각각 확인한다. 도구명 사용을 프롬프트에 지시한 smoke는 연결 검증일 뿐 자발적 라우팅 검증은 아니다.

호스트 적용에는 기존 승인 경계를 유지한다. 이 저장소의 extension installer는 정책을 병합하지 않으므로 activation만 실행하고 정책 적용까지 완료됐다고 보고하지 않는다.

## Runtime 자체를 설치/변경하는 경우만

정책 문구만 바꿀 때는 extension 재설치나 live probe가 필요하지 않다. runtime을 실제로 전환할 때는 설치된 OMP/event 계약을 확인하고 다음 기존 경로를 사용한다.

```sh
node scripts/install.mjs
node scripts/install.mjs --activate
```

첫 명령의 target을 확인한 뒤 활성화한다. 새 OMP 프로세스가 새 target을 로드하며 이미 실행 중인 세션은 hot-patch되지 않는다. 필요한 integration 검증에만 기존 `upgrade-check --live`를 사용한다. 실제 모델/credentials/호스트 memory를 사용하는 검증이므로 disposable local test로 취급하지 않는다.

## Rollback과 보존

정책 rollback은 앞서 보존한 AGENTS와 해당 rule만 복원한다. 적용 이후의 사용자 변경과 충돌하면 자동 덮어쓰지 말고 해당 절을 병합한다. 새로 추가한 rule의 제거도 이번 적용에서 소유한 파일임이 확인된 경우에만 한다.

```sh
node scripts/install.mjs --rollback
```

이 명령은 직전 extension symlink만 복원한다. AGENTS, rules, MCP 설정, OMP 버전은 되돌리지 않는다. 두 rollback을 혼동하지 않는다.

journal, lease, native session, memory bank/queue와 사용자 데이터는 삭제하지 않는다. scratch 밖의 child-reported 경로는 cleanup 권한이 아니다. lazy-intel과 독립 autoindex를 동시에 되살리지 않는다. Kubernetes/Argo CD/production 변경은 이 절차에 포함되지 않는다.

기존 0.5 cutover의 호스트 경로와 실행 이력은 [개정 전 MIGRATION.md](https://github.com/steve-8000/agi-runtime/blob/da7a671c63dbf62c672a4189a0001a4716866c47/docs/MIGRATION.md)와 [VERIFICATION.md](VERIFICATION.md)에 보존되어 있다. 그 이력은 이번 정책의 적용 증거가 아니다.
