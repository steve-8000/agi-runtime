# 이번 패키지의 검증

기준일 2026-09-06. 환경: macOS arm64, Node v26.7.0, OMP 18.1.11(Homebrew). 이 기록은 이전 repository의 81/87 tests를 재사용한 것이 아니다.
최초 패키지 작성은 Linux x64 / Node v22.16.0 컨테이너였고, 아래 수치는 실제 설치 호스트에서 다시 실행한 값이다.

## 실제 실행

| 명령/검사 | 결과 | 범위 |
|---|---|---|
| `node --test tests/*.test.mjs` | 54 passed, 0 failed | 실제 SQLite/임시 파일 시스템 + OMP-shaped mock event adapter |
| `node scripts/check.mjs` | 17 MJS parser checks + runtime config validation passed | TypeScript/OMP SDK build 아님 |
| `node scripts/measure.mjs` | 1,000 synthetic complete hook cycles | 실제 로컬 SQLite, fake tool 결과, 모델 호출 없음 |
| install 테스트 | default plan, explicit activation/idempotency/rollback, foreign file/package 거절, `ompupdate` rc 블록의 고정점·바이트 단위 uninstall·마커 불균형 거절 | 임시 디렉터리와 임시 rc 파일만 변경 |
| `node scripts/upgrade-check.mjs --live` | PASS, OMP 18.1.11, probe가 저널 1개 생성, 응답 `done` | scratch workspace/runtime dir에서 실제 `omp -p` 1회. 설치된 바이너리의 discover/import/attach를 확인 |

원본 로그: evidence/tests.tap, evidence/check.jsonl, evidence/measure.json, evidence/summary.json.

## 주요 확인

- Local result/end 충돌과 exit-code-only 충돌에서 false-success를 만들지 않음.
- Known memory write의 오류/불완전 ack/입력 수정은 unknown. 이후 성공 관측이 앞선 ambiguity를 지우지 않음.
- 같은 toolCallId의 xd outer/inner: logical action/effect 하나, physical observation 둘. timeout에도 unknown 하나.
- zvec 요청 인자와 범위 옵션 그대로, read failure는 memory/workspace를 잠그지 않음.
- 실행 카운터가 605회 이상이고 simulated clock이 24시간 경과해도 작업 차단 없음. heartbeat는 테스트 시계에서 유지.
- persistent DB 오류 시 더 이상 매 호출 DB에 접근하지 않음. 일반 작업 진행, 메모리 쓰기 보류. failed persistence도 불명 상태에 표시.
- lease 상실 후 managed timer에서 재attach. 사람의 renewal command 없음.
- Local unknown은 workspace 전역 lock이 아님. User pause는 자동 해제하지 않음.
- read-back 없이 unknown을 닫지 않음. 같은 clock tick의 이전 읽기도 read-back으로 오인하지 않음. 의미적 참/거짓 판단은 에이전트 attestation으로 표시.
- resolved journals directory가 symlink로 workspace에 들어가는 경우 거절.
- legacy nonempty outbox 데이터 보존. unsupported schema를 삭제하거나 초기화하지 않음.
- context 1,000회 생성 후 own message 한 개. 사용자/다른 extension 메시지 불변. unchanged checkpoint/usage telemetry 미주입.
- 기존 Kubernetes 거절을 runtime이 allow로 덮지 않는 mock 비간섭 검사.

## 크기와 속도

측정 당시 정상 projection 317 bytes, 큰 checkpoint + 100 unknown stress projection 2,296 bytes, packing 최대 4,096 bytes. 이 byte 수는 runtime projection만이며 도구 schema, AGENTS, 원래 대화, zvec/gbrain 응답은 별도다. 토큰 수는 측정하지 않았다. 이 한도는 반환 콘텐츠의 크기이며 실행을 중단시키는 budget이 아니다.

1,000 synthetic read lifecycle의 median 0.276 ms, p95 0.517 ms, max 1.639 ms. 로컬 임시 파일 시스템과 OS cache의 영향을 받으며, 실제 SSD crash durability, Mac/Bun 또는 긴 tool output의 overhead를 뜻하지 않는다. 실제 도구/LLM/network latency는 포함하지 않는다. 운영 SLO나 향상률로 인용하지 않는다.

## 아직 검증하지 않은 것

- 실제 OMP v18.1.11 바이너리에서 factory load, live zod schema 및 context custom message 변환.
- Bun 내장 SQLite 실행과 실제 Mac filesystem/power-loss durability.
- 실제 gbrain의 인증, 노출 이름, 응답/에러 shape와 timeout-after-commit.
- 실제 zvec index/freshness/embedding 모델과 검색 품질.
- 현재 설치된 kubernetes-approval.ts의 모든 tool/eval/subagent 경로.
- provider-native 실행/직접 subprocess가 event를 우회하는 경로, 모든 advisor/Scout coverage.
- OMP 프로세스 자체 종료 후 OS 자동 재기동과 동일 세션 복원.
- 장기 실제 개발 성공률, 모델 비용 감소, context cache hit, 업무 처리량의 A/B 비교.

따라서 이 패키지는 소스 계약 기반으로 구현·로컬 검증한 통합 후보이지, 사용자 Mac과 클러스터에 설치 완료한 production release가 아니다. 원격 repository push나 실제 서비스 배포는 하지 않았다.
