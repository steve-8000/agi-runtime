# 기존 runtime에서 전환

이 패키지는 `580f0e52…` 위에 이미 커밋된 변경이 아니다. 새 0.3.0 구현 후보이며 실제 OMP integration 검증 후 기존 한 개의 extension을 교체한다. 병렬로 두 runtime을 로드하면 이벤트/lease가 충돌할 수 있다.

## 제거 및 유지

제거: execution budgets, requireApproval/structuredOperationTools 중복 승인, recall require/strike/skip/turn gate, memory outbox transport, 세션 종료 시 note 압박, 반복 상태 append.

유지: 기존 OMP loop와 model roles, task worker 비활성, K8s hook, zvec/gbrain MCP, source evidence primitive, 기존 SQLite 데이터, 모델 기반 read-back 복구.

변경: 결과 first-wins를 관측 합산으로, xd envelope+child를 logical action 하나로, workspace unknown을 전역 차단 대신 복구 안내로, DB 장애를 degraded + managed retry로, 컨텍스트를 단일 projection으로.

## 데이터

journal schema 2/3/4를 읽는다. 필요한 schema4 테이블/인덱스를 만들되 legacy outbox/approvals의 데이터를 삭제하지 않는다. 원래 파일은 같은 runtime journals 위치에 유지한다. 이미 존재하는 v4의 drop된 데이터는 복구할 수 없다.

새 action ID는 논리 호출 기준이다. 새 events에 `semantics: logical-v3`를 남긴다. 이전의 physical-call 카운트와 새 logical effects를 무조건 같은 의미로 합산하지 않는다. 이전 records에 없는 source reference를 만들어내지 않는다.

기존 config의 예산/회상/중복 승인 키는 경고 후 무시한다. 새 production 설정은 tool identity 세 목록뿐이다. operator config를 자동으로 지우거나 auth/AGENTS/OMP settings를 덮어쓰지 않는다. 무시되는 이전 옵션이 있었다는 로그와 README를 확인한다. 새로운 이름의 비표준 MCP 도구는 그 실제 identity를 세 목록에 명시해야 한다.

## 전환 순서

1. 이 디렉터리에서 `node --test tests/*.test.mjs`와 `node scripts/check.mjs` 실행.
2. 실제 OMP 18.1.11에서 별도 임시 workspace와 runtime 디렉터리로 explicit extension load smoke를 수행. 현재 설치의 Kubernetes hook을 끄는 flag나 설정을 사용하지 않는다. 모델 호출이 든다. 실제 tool names와 protocol ack shape를 확인한다.
3. 기존 `task.disabledAgents`에 `task`가 남아 있고, main sole-writer 정책과 existing K8s hook이 유지되는지 확인. modelRoles를 다시 설계하지 않는다.
4. 같은 workspace의 이전 OMP 프로세스를 종료한 뒤 journal SQLite의 online backup 또는 WAL checkpoint 후 안전한 백업을 수행. 실행 중 DB 본체만 복사하면 WAL 데이터가 빠질 수 있다. 이 패키지는 DB를 자동 삭제/이동하지 않는다.
5. `node scripts/install.mjs`로 경로 계획 확인. `node scripts/install.mjs --activate`로 기존 symlink 하나만 원자 교체. 프로파일은 `--agent-dir`로 명시한다. archive 임시 디렉터리가 아니라 유지할 checkout에서 실행한다.
6. 새 OMP 프로세스로 기존 native session을 재개. `runtime_status`에서 health, 원본 참조, 불명 이력을 확인. 필요하면 에이전트가 read-back하고 계속한다.

원격 GitHub 저장소 반영은 이 패키지의 `src/`, `extension/`, `scripts/`, `tests/`, 문서를 한 coherent commit으로 옮기는 별도 작업이다. 이전 테스트를 전부 실패한 채 버리는 대신 제거된 정책의 테스트는 제거 이유를 남기고, 유지하는 evidence/recovery 경계의 회귀는 보존한다.

## rollback

`node scripts/install.mjs --rollback`은 마지막 activation의 이전 symlink만 복구한다. DB/config/K8s hook은 그대로다. 복구한 extension은 새 OMP 프로세스에서 로드된다. 기존 version이 schema4를 지원하는지 먼저 확인한다. code rollback과 data rollback은 서로 다른 작업이며, 새 이력을 버리는 DB 덮어쓰기를 자동 수행하지 않는다.

## 수행하지 않은 것

이 컨테이너에서 실제 Mac symlink, user config, gbrain, zvec index, Kubernetes, origin/main은 변경하지 않았다. 포함된 install 테스트는 임시 디렉터리에서만 실행했다.
