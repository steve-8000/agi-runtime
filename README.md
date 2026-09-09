# OMP Native Runtime 0.5

**모델에는 판단을, OMP에는 실행을, Sharpshooter에는 기억을, lazy-intel에는 코드 인텔리전스를 맡긴다.**

```text
OMP
├─ Sharpshooter                # memory owner
├─ native source/edit/build/test
└─ lazy-intel                  # ONE code-intelligence MCP
     └─ code_intel             # ONE exposed intelligence tool
          ├─ zvec-grep        # retrieval
          ├─ CodeGraph        # architecture / call flow / impact
          └─ Serena           # live LSP semantics
```

목표는 하네스 자체를 정교하게 만드는 것이 아니라, OMP 안의 에이전트가 Sharpshooter 기억·lazy-intel·네이티브 도구를 자유롭게 연결해 일을 끝내는 것이다. 이 패키지는 그 연결에 필요한 얇은 경계만 맡는다. 메인 모델과 reasoning 설정은 OMP 기본 선택에 맡기며, Fable/Astra 같은 이름을 runtime 설정이나 실행 분기로 만들지 않는다. 별도 모델 루프, supervisor/judge, 실행 budget, 회상 의무, 강제 도구 순서, 중간 사용자 승인 절차를 만들지 않는다. 필요한 안전 승인과 명시적 사용자 stop은 보존한다.

## 0.5 변경

- 실제 활성 0.4 Sharpshooter 구현을 기준으로 통합했다. 기억을 다시 구현하지 않는다.
- `code_intel`과 xd envelope의 조회는 read, 명시적 `sync`·`reindex`·`repair`는 `derived-effect`로 관측한다. 파생 상태 변경은 source/memory 쓰기가 아니지만 journal·pause·unknown/read-back에 포함한다. 외부 memory MCP 쓰기/ack/gate 경로와 임의 도구를 read로 승격시키던 `searchTools` override를 제거했다.
- 독립 `zvec-autoindex.ts`를 로딩 경로 밖으로 이동했다. 파생 인덱스는 lazy-intel만 관리한다.
- 평상시 runtime projection은 **0 bytes / 추가 메시지 0개**다. unknown/degraded/pause/resume 때만 복구 상태를 제공한다.
- compaction이 최신 Sharpshooter bank sample을 기다리도록 했다. 통합된 기억은 중복 주입하지 않는다.
- queue·session queue·delta의 실제 읽기 실패는 빈 기억이 아닌 미관측(`null`)으로 보존한다. 권한 복구 뒤 관측도 검증했다.
- `jsconfig.json`으로 `.mjs` cross-file Serena references를 복구했다.
- 실제 호스트 AGENTS·검색 규칙·MCP launch 계약을 비밀 없이 `config/`에 추적한다.

## 실제 검증

검증도 모델을 지정하지 않은 실제 `omp -p`로 수행한다. scratch 프로젝트에서 검색·구조·참조 조회, 실패 재현, 소스 수정, 재실행을 거치며 verifier 불변과 runtime 상태를 확인한다. 이는 연결을 확인하는 일회성 시나리오이며 일반 작업에 이 순서를 강제하지 않는다. 최신 결과와 과거 모델 지정 시험은 [VERIFICATION.md](docs/VERIFICATION.md)에 구분해 기록한다.

```sh
npm run test:runtime
npm run check
npm run test:live -- --output evidence/live-default.json
node scripts/upgrade-check.mjs --json --live
```

`test:runtime`은 runtime/extension/Sharpshooter 회귀만 실행한다. `test:live`는 실제 모델 호출을 사용하며 scratch workspace에서 네이티브 편집·실행과 lazy-intel을 검증한다. 설치된 OMP의 승인 hook을 끄지 않는다. 실제 활성 호스트 설정과 credentials를 사용하므로 native Sharpshooter가 scratch scope의 bank를 호스트에 만들 수 있다. 결과의 `memory.scope`에 기록하며, probe 자체는 이 경로를 삭제하지 않고 자신이 만든 scratch 트리만 정리한다. 기본 `upgrade-check`는 installer와 foreign-bank 보존 회귀까지 포함한다. `--live`는 이 gate에 end-to-end probe를 추가한다. 공개 진단은 필드별 최대 2,048 UTF-8 bytes로 제한하고 기존 obvious-secret 검사를 적용하며, raw provider/tool trace를 자동 저장하지 않는다. gate의 공개 `probe`는 고정된 typed allowlist이며 모델 표시는 `<configured>`다. 원문 선택자·추가 child 필드·live child stdout/stderr는 공개 보고서로 전달하지 않는다. 단일 응답이나 journal 파일 생성만으로 성공을 선언하지 않는다.

Node 22.16 이상, Node/Bun builtin SQLite를 사용한다. runtime 자체에는 production npm dependency가 없다. lazy-intel과 그 backend는 별도 설치된 MCP가 소유한다.

## 활성화

```sh
node scripts/install.mjs             # read-only 경로 계획
node scripts/install.mjs --activate  # extension symlink 하나를 원자 교체
node scripts/install.mjs --rollback  # 직전 extension target으로 복구
```

이 호스트의 symlink는 현재 이 checkout을 가리킨다. 새 OMP 프로세스에 적용되며 이미 로드된 세션 객체를 hot-patch하지 않는다. `--activate`는 사용자 AGENTS·MCP credentials·승인 설정·journal을 덮어쓰지 않는다. [MIGRATION.md](docs/MIGRATION.md)의 호스트 설정 병합과 이전 target 복구 범위를 구분한다.

`ompupdate` 설치기는 기존 zsh managed block만 갱신한다. native `omp update` 성공 후 runtime gate를 실행한다. 업데이트 자체를 이 extension이 재구현하거나 자동 rollback하지 않는다.

## Pause와 안전 경계

`/runtime pause`는 **runtime advisory pause**다. 로드된 runtime과 읽을 수 있는 journal 안에서는 명시적 effect를 중단하지만, journal을 읽지 못한 새 프로세스에서 이전 pause를 복원한다고 보장하지 않는다. 관측 장애는 일반 개발을 막지 않는다. OMP의 native approval, Kubernetes 승인 hook, 사용자 stop이 안전 경계를 소유한다. runtime을 production interlock이나 권한 부여자로 사용하지 않는다.

## 구조와 한계

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): 책임·데이터 흐름·자율 실행·복구
- [VERIFICATION.md](docs/VERIFICATION.md): 실제 명령·결과·미검증 범위
- [SOURCE-AUDIT.md](docs/SOURCE-AUDIT.md): 현재 소스와 upstream 계약
- [IMPLEMENTATION-WORKORDER.md](docs/IMPLEMENTATION-WORKORDER.md): 이후 변경의 유지 기준
- `config/AGENTS.md`, `config/rules/`: 호스트 정책 정본의 추적본
- `config/mcp.json`, `config/runtime.json`: 비밀 없는 도구 연결·관측 계약

runtime tool은 `runtime_status`, `runtime_checkpoint`, `runtime_evidence`, `runtime_reconcile` 네 개이며 정상 개발에는 호출 의무가 없다. 도구 관측과 agent attestation은 외부 사실의 독립 증명이 아니다. 프로세스 crash 후 OS 재기동, 모든 모델의 잘못된 완료 선언 방지, 모든 네트워크 효과의 exactly-once를 보장하지 않는다. 검증한 자율 실행과 ‘AGI 완성’이라는 주장을 구분한다.
