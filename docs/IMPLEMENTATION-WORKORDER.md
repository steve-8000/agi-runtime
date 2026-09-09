# Runtime Maintenance Contract

현재 기준은 native OMP 18.1.11 + 이 runtime 0.5.0 + lazy-intel 0.2.0이다. Main이 유일한 writer다. Scout는 근거, Reviewer는 구현 후 한 번의 read-only 검토만 맡는다. disabled `task` worker를 되살리지 않는다.

## 지켜야 할 책임

- OMP: 모델 선택, 도구 루프, source/edit/build/test, session/compaction, 승인 경계.
- Sharpshooter: 사용자 결정 추출, queue, 통합, 다음 세션 memory injection.
- lazy-intel: 단일 `code_intel`과 zvec/CodeGraph/Serena, 파생 인덱스 수명주기.
- runtime: journal, 불명 효과, lease/recovery, checkpoint, compatibility 관측.

다른 소유자를 추가해서 실패를 감추지 않는다. runtime은 task completion 판정, 모델 성능 보정, 회상/검색 의무, 강제 follow-up turn, 도구/시간/session budget을 소유하지 않는다. 일반적인 도구 루프의 중간마다 사용자 응답을 요구하지 않는다. 필요한 안전 승인은 유지한다.

## 변경 절차

1. 현재 환경·소스에서 입출력과 영향을 확인한다. semantic 질문은 `code_intel`, 정확한 위치/전수 검색은 native tools. exported symbol 변경 전 live references를 확인한다.
2. 한 일관된 변경을 Main이 구현한다. 새 abstraction을 만들기 전에 기존 레이어로 문제를 해결한다.
3. 관측한 실패의 좁은 재현으로 검증·수리한다. 정상 gate는 한 번 실행한다. 같은 passing 검사를 이유 없이 반복하지 않는다.
4. coherent diff에 Reviewer를 한 번 요청한다. 실제 결함만 고친다.
5. docs·호스트 추적본·source pins·측정 증거를 맞춘다. scratch script와 테스트가 생성한 고유 memory bank를 정리한다.

## 검증 기준

- `test:runtime`: 효과 correlation, read failure, uncertainty/reconciliation, pause, degraded journal, recovery context, compaction과 Sharpshooter observer.
- `tests/install.test.mjs`: activation/rollback 및 기존 alias 보존.
- `scripts/live-probe.mjs`: 실제 OMP가 실패하는 scratch 프로그램을 수정하고 재실행한다. `search`, `architecture`, `references`, read-only intelligence 분류, 다중 model turn, verifier 불변, runtime 건강을 확인한다.
- Sharpshooter 변경 시 native 추출→통합→다음 세션 주입을 검증한다. 즉시 끝나는 print mode의 수명과 비동기 추출을 구분하고 extension handler를 기다림 루프로 막지 않는다.
- “도구를 등록했다”, “응답 한 번 나왔다”, “DB가 생겼다”는 end-to-end 완료의 충분조건이 아니다.

Tests는 계약과 plausible regression을 지킨다. source text, 문구, forwarding mock echo, 우연한 기본값을 pin하지 않는다. 모델별 live smoke는 설치 환경과 credentials에 의존하므로 deterministic gate와 결과를 분리한다.

사용자가 명시적으로 요구한 범위를 끝까지 수행하되 OS supervisor·새 memory service·새 index workflow·completion judge를 ‘자율성 강화’ 명목으로 추가하지 않는다.
