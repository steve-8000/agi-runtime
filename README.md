# OMP Native Runtime 0.5

**모델에는 판단을, OMP에는 실행을, Sharpshooter에는 기억을, lazy-intel에는 코드 인텔리전스를 맡긴다.**

이 패키지는 OMP 이벤트를 관측하고 불명확한 실행 결과의 복구를 돕는 얇은 계층이다. 모델 선택, 별도 에이전트 루프, completion judge, 실행 budget, 강제 회상 절차를 추가하지 않는다.

```text
OMP native agent loop
├─ source / edit / build / test
├─ native approvals
├─ Sharpshooter                 durable project memory
└─ lazy-intel → code_intel       one code-intelligence entry point
   ├─ zvec-grep                 semantic retrieval
   ├─ CodeGraph                 architecture / impact
   └─ Serena                   live code semantics

OMP events → runtime → journal / uncertain outcomes / recovery context
```

## 정책 정리와 lazy-intel

[호스트 정책](config/AGENTS.md)은 완료 조건, 책임, 안전 경계와 필수 검색 라우팅을 담는다. 의미·구조·영향·교차 파일 질문은 `code_intel`부터 시작하고, 알려진 경로·문자열·전수 검색은 native 도구를 사용한다. 정확한 파일명이 있다는 이유로 의미 탐색을 생략하지 않는다. 모든 intelligence 호출에는 실제 프로젝트의 canonical absolute `root`를 명시한다.

세부 규칙은 필요할 때만 읽는다. OMP의 rulebook은 설명을 노출하고 본문은 `rule://`로 읽을 수 있다. 이 저장소의 규칙에는 `alwaysApply`나 TTSR 강제 실행을 추가하지 않았다.

| 문서 | 읽는 시점 |
|---|---|
| [search-routing](config/rules/search-routing.md) | operation 선택, live semantics, 검색 장애/복구 |
| [implementation-loop](config/rules/implementation-loop.md) | 검증 범위 또는 독립 리뷰 판단 |
| [design-routing](config/rules/design-routing.md) | 새 화면·실질적인 시각/상호작용 변경 |
| [정책 검증](docs/POLICY-VALIDATION.md) | 정책 변경 검토와 자연어 라우팅 평가 |
| [마이그레이션](docs/MIGRATION.md) | 활성 호스트에 정책을 병합하거나 복구할 때 |

정책 개정은 runtime 기능 릴리스가 아니다. 버전은 **0.5.0**을 유지한다. `config/`는 검토·적용할 템플릿이며, GitHub의 파일 변경만으로 사용자 호스트가 갱신되지는 않는다. 과거 호스트 실행 기록은 [VERIFICATION.md](docs/VERIFICATION.md)에 그대로 보존하며 이번 정책의 실모델 검증으로 재사용하지 않는다.

## Runtime의 경계

정상 상태의 runtime projection은 0 bytes / 추가 메시지 0개다. pause, degraded, unknown, resume 또는 기억 통합 오류처럼 다음 행동을 바꾸는 상태만 전달한다. recovery projection의 packing 상한은 4 KiB이며 작업 실행 quota가 아니다. AGENTS, tool schemas, native memory와 대화의 크기는 별도다.

SQLite journal은 관측 기록이지 원격 상태의 증명이 아니다. 불명 효과는 실제 대상 read-back 후 명시한 action ID만 reconcile한다. 자동 재전송, exactly-once, 모든 잘못된 완료 선언 방지, OS crash 후 프로세스 재기동은 보장하지 않는다.

`/runtime pause`는 advisory pause다. journal을 읽지 못한 새 프로세스에서 이전 pause 복원을 보장하지 않는다. OMP native approval과 기존 Kubernetes hook이 안전 경계를 소유한다. 이 runtime을 production interlock으로 사용하지 않는다.

## 설치와 검증

Node 22.16 이상과 Node/Bun builtin SQLite를 사용한다. runtime 자체에는 production npm dependency가 없으며 lazy-intel과 backend 설치는 별도다.

```sh
node scripts/install.mjs             # read-only 설치 계획
node scripts/install.mjs --activate  # extension symlink 교체
node scripts/install.mjs --rollback  # 직전 extension target 복원
```

설치기는 AGENTS, MCP credentials, 승인 설정 또는 journal을 덮어쓰지 않는다. 새 OMP 프로세스에 적용되며 이미 로드된 세션은 hot-patch하지 않는다. 정책 적용과 extension 활성화의 차이는 [MIGRATION.md](docs/MIGRATION.md)를 따른다.

검증은 변경 범위에 맞춰 선택한다. 아래 명령을 모든 수정마다 순서대로 실행하지 않는다.

```sh
npm run test:runtime
npm run check
npm run test:live -- --output evidence/live-default.json
node scripts/upgrade-check.mjs --json --live
```

`test:live`와 `--live`는 실제 모델, 호스트 설정과 credentials를 사용한다. scratch scope의 Sharpshooter bank가 생길 수 있으며 승인 hook을 끄지 않는다. 정책 문구 수정의 기본 검증이 아니다.

## 참고

[ARCHITECTURE.md](docs/ARCHITECTURE.md)는 책임과 복구 계약, [SOURCE-AUDIT.md](docs/SOURCE-AUDIT.md)는 소스 근거, [IMPLEMENTATION-WORKORDER.md](docs/IMPLEMENTATION-WORKORDER.md)는 runtime 유지 기준을 설명한다.

선택적인 runtime 도구는 `runtime_status`, `runtime_checkpoint`, `runtime_evidence`, `runtime_reconcile` 네 개다. 일반 개발에 호출 의무를 만들지 않는다.
