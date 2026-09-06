# OMP Native Runtime 0.3

**판단은 모델에, 검색은 zvec에, 기억은 gbrain에. Runtime은 관측·복구와 작은 context projection만 담당한다.**

2026-09-06 작성. `steve-8000/agi-runtime`의 580f0e52를 검토한 뒤 만든 경량 replacement candidate. AGI 달성 주장이나 실제 host 배포 완료본이 아니다.

## 달라진 것

실행 예산, 회상 강제/strike/skip, runtime 승인 대화상자, memory outbox, note due 압박, 매턴 상태 append를 없앴다. 새 agent, network client, vector DB, scheduler도 없다. generic task worker는 계속 disabled, Main sole writer다.

zvec 입력을 수정하지 않는다. gbrain의 기존 seven verbs를 모델이 직접 사용한다. 불명 memory write는 read-back 전 보류하지만 작업 공간의 코드 개발을 잠그지 않는다. SQLite 오류는 degraded 관측과 timer 재접속으로 처리한다. 결과 충돌과 xd 중첩 호출을 단일 logical action 기준으로 기록한다.

기존 OMP·Kubernetes 승인 hook·사용자 모델 설정·MCP credentials는 변경하지 않는다. headless/subagent K8s deny와 other-target approval 정책은 그대로다.

## 파일

- docs/ARCHITECTURE.md: 최종 책임, 데이터 흐름, 자율성, 복구, 컨텍스트 및 한계
- docs/MIGRATION.md: 데이터 보존, 설치, rollback
- docs/SOURCE-AUDIT.md: OMP/gbrain/zvec 고정 소스 근거
- docs/VERIFICATION.md: 이번에 실제 실행한 검사와 미검증 범위
- docs/IMPLEMENTATION-WORKORDER.md: 실제 repository/host에 옮길 에이전트 지시서
- config/AGENTS.runtime.md: 기존 정책에 병합할 짧은 운영 원칙

## 로컬 확인

```sh
node --test tests/*.test.mjs
node scripts/check.mjs
node scripts/measure.mjs
```

Node 22.16 이상과 builtin SQLite를 사용한다. production npm dependency는 없다. 테스트는 54개, 실제 SQLite와 임시 filesystem을 사용하며 OMP/provider는 mock이다. 전체 OMP SDK/Bun/live MCP test를 대신하지 않는다.

## 설치 계획과 선택적 활성화

```sh
node scripts/install.mjs                       # read-only plan
node scripts/install.mjs --activate            # 기존 runtime symlink 하나를 교체
node scripts/install.mjs --rollback            # 이전 symlink 복구
```

기존 OMP process를 먼저 종료하고, 유지할 checkout에서 활성화한다. 새 process부터 반영된다. 두 runtime을 병렬 로드하지 않는다. 자세한 검증/backup 절차는 MIGRATION.md에 있다.

이 호스트에서는 이미 활성화되어 있고 링크는 이 checkout을 가리킨다. `--rollback`은 동작하지 않는다:
`~/.omp/runtime/activation.json`의 `candidate`가 활성화 당시의 임시 checkout 경로이고 그 디렉터리는
cutover에서 삭제됐으므로 installer는 `TARGET_CHANGED_SINCE_ACTIVATION`으로 거부한다(dangling
symlink를 만들지 않는 fail-closed). 코드 롤백은 git 작업이다 — 이전 구현은 `580f0e5`에 있다.

## `ompupdate`

```sh
npm run install-ompupdate-alias   # ~/.zshrc에 zsh 함수 ompupdate 하나를 설치
source ~/.zshrc
ompupdate                         # omp update -> upgrade-check --live
ompupdate --gate-only             # 업데이트 없이 게이트만; 남은 플래그는 게이트로 전달
node scripts/install-ompupdate-alias.mjs --uninstall
```

업데이트 자체는 OMP의 native updater가 수행하고 플래그는 그대로 전달된다. 성공하면
`scripts/upgrade-check.mjs`가 설치 버전, `check.mjs`, `tests/*.test.mjs`, 그리고 로드되는 확장
심링크가 이 checkout인지 확인한다. `--live`는 scratch workspace와 scratch runtime 디렉터리에서
`omp -p`를 한 번 실행해 새 바이너리가 확장을 discover/import/attach 하는지 저널 생성으로 확인한다
(모델 호출 1회, `OMP_UPDATE_PROBE_MODEL`로 모델 지정). `ompupdate`는 업데이트 성공 후 항상 `--live`를
실행한다: 업데이트가 깨뜨리는 것은 정적 검사가 아니라 확장 로딩과 이벤트 계약이므로 매 업데이트마다
모델 호출 1회를 쓴다. native 업데이트가 실패하면 게이트는 실행되지 않고 native exit code가 그대로
반환된다. 업데이트는 성공했으나 게이트가 실패하면 **업데이트는 이미 적용된 상태**로 non-zero를
반환하고 실패 단계를 알려준다 — 되돌리는 것은 OMP 쪽 작업이다. 게이트만 따로 돌리려면
`ompupdate --gate-only [--live]`. `alias`가 아니라 함수인 이유는 zsh alias가 인자를 확장 끝에만
붙여서 `omp update`에 플래그를 넘기며 뒤에 게이트를 실행할 수 없기 때문이다. 이 설치는 `omp` 명령
자체를 감싸지 않고, OMP·Kubernetes hook·runtime config·MCP 설정을 바꾸지 않는다.

## 모델에 노출하는 표면

도구는 runtime_status, runtime_checkpoint, runtime_evidence, runtime_reconcile 네 개다. 정상 개발에는 호출 의무가 없다. 평상시 request projection은 317 bytes였으며 1,000번 만들어도 message 하나만 남았다. 최대4 KiB는 출력 packing이지 작업 quota가 아니다.

사용자는 처음 목표를 주고 기존 권한을 제공한다. 그 범위에서 모델이 조사/구현/테스트/수정을 계속한다. 이미 승인하지 않은 Kubernetes 작업, 권한 없는 서비스 또는 알 수 없는 사실을 이 runtime이 우회하지 않는다. 프로세스 자체를 자동 재기동하는 OS supervisor는 포함하지 않았다.

## 정확한 보장 범위

관측된 outcome과 agent attestation을 기록한다. 모든 subprocess/네트워크 부작용의 exactly-once를 보장하지 않는다. gbrain remember의 semantic dedup/idempotentHint를 request-key 보장으로 오인하지 않는다. 일반 unknown은 현재 소스를 다시 읽고 판단해야 한다. 계속 검증을 반복하는 judge loop를 만들지 않는다.
