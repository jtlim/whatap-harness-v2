# 검증 실행 기록

## 과제 검수 결과

검수는 깨끗한 기준에서 실제 데이터를 다시 조회하고 독립 HTTP로 대조했습니다. 아래 URL과 실행 ID는 과제의 역사적 결과입니다. 해당 계정이나 저장소 이름은 새 사용자의 설정 요구사항과 무관합니다.

### MCP 전체 검수와 수정

- 기준 MCP `c1001155538114e811e8ecf311904723aa131115`
- 새 후보 `16ecd97388428311f9085b03954e7b9f949d43d7`
- 검증 Harness `e04a5f68c4effcf6fbd4a8fc92e650dfe963611d`
- [MCP 검토 PR #5](https://github.com/jtlim/whatap-open-mcp/pull/5)

| 구분 | 원본 | 새 후보 |
| --- | --- | --- |
| 실행 ID | `2026-11-24T20-00-13-079Z-9uXWn8` | `2026-11-24T20-01-55-307Z-r2h8lO` |
| 실데이터 판정 | 6/9 통과. 절대 구간 3건 거부 | 9/9 통과 |
| 서버 절대 15분 | MCP 기간 오류, HTTP 900행 | 900행 대조 일치 |
| APM 절대 15분 | 트랜잭션·예외에 MCP 기간 오류, 독립 HTTP 정상 | 각 표시 100행 대조 일치. 별도 v2 전체 집계 검증 통과 |
| 상대 서버, APM, 시계열 및 오류 처리 | 통과 | 통과 |
| MCP 단위·회귀 | 147개 통과 | 156개 통과 |

Codex는 기존 상대 파서를 유지하고 데이터 조회 도구에 한정해 고정 UTC 구간을 추가했습니다. 별도의 모의 stdio 실험에서 같은 조회를 보낸 두 버전의 표시 오차를 대조했습니다. 원본 Period는 양끝에서 731ms를 잃었고 후보는 보존했습니다. 이번 실제 상대 시계열은 두 버전 모두 통과했으므로 실데이터의 불일치가 해결됐다고 해석하지 않습니다. 이때 Harness 테스트 25개가 통과했습니다.

권한이 있는 기존 환경에서 두 실행의 `runs/<실행 ID>/report.json`과 `runs/fresh-codex-audit-PhrzHC/final/report.md`, `evidence.json`을 열 수 있습니다. PR에는 승인된 실제 비교표 16개와 판정 근거가 있습니다. 보호된 원본과 로컬 경로는 Clone에 포함되지 않으므로 새 사용자는 [직접 검증](usage.md#직접-검증)에서 같은 종류의 증거를 생성할 수 있습니다. 개발 중 사용한 [MCP PR #4](https://github.com/jtlim/whatap-open-mcp/pull/4)는 비교 사례이며 Merge 없이 닫혔습니다.

### Harness 자체 결함 수정과 판정 보존

과거 Full Build 실행 `2026-11-24T17-48-14-970Z-8foWt6`에서 후보의 실데이터 비교를 통과한 뒤, 빌드 후 경로 검사에서 두 번 `CANDIDATE_SCOPE_INVALID`로 중단됐습니다. 패치를 기록하는 `git add --intent-to-add` 이후 신규 테스트가 `git diff HEAD`에 나타났고, 이전 검사가 이를 기존 테스트의 수정으로 분류했습니다.

[Harness PR #1](https://github.com/jtlim-bot/whatap-harness-v2/pull/1)에서 Git 변경 유형으로 신규 추가를 구분했습니다. 동일한 후보의 경로 검사에서 이전 거부와 수정 후 허용을 확인했습니다. 기존 테스트 수정·삭제와 빌드 전 산출물 변경은 계속 거부됨을 [회귀 테스트](../test/scope.test.js)로 확인했습니다. 같은 실행에 보존된 25개 판정과 근거 코드는 재생 결과와 일치했습니다.

보고서 근거와 공개 범위, 반영 근거 및 상세 표의 개선은 [Harness PR #2](https://github.com/jtlim-bot/whatap-harness-v2/pull/2)와 [Harness PR #3](https://github.com/jtlim-bot/whatap-harness-v2/pull/3)에서 확인할 수 있습니다.

### 실패 사례와 한계

| 사례 | 결과와 증거 |
| --- | --- |
| 통제된 AI 실행 실패 | 프로세스 종료 코드 17을 `AI_FAILED`로 기록. 실행 `2026-11-24T18-33-45-741Z-qY64iE` 및 [비식별 예제](examples/controlled-failure.json) |
| 실제 Codex 초기화 실패 | 당시 파일 시스템이 읽기 전용이어서 시작하지 못함. [비식별 예제](examples/agent-start-failure.json) |
| 실데이터 검증 실패 | 신규 원본의 절대시간 조회 세 건이 거부됨. 후보는 같은 고정 구간에서 재검증 통과. [MCP PR #5](https://github.com/jtlim/whatap-open-mcp/pull/5) |
| 인증 및 네트워크 환경 | 초기 실행의 토큰 미주입, 셸 DNS 오류를 보존. 환경 복구 후 수행된 실데이터 실행과 구분합니다. [비식별 예제](examples/full-preflight-blocked.json) |

성공 사례는 공식 Codex 주도 경로의 실데이터와 회귀 검증입니다. 모든 MCP 도구와 자유 형식 AI 응답을 검증한 것은 아니며, 몇몇 APM 대조는 MCP 표시 행을 대상으로 합니다. 절대 기간의 전체 집계는 별도 API를 사용합니다.

## 초기 구현 당시의 진단 기록

초기 기록에서는 **레거시 Full Build 성공 예시가 미확보였습니다.** 로컬 원본 빌드 및 테스트와 절대시간 문제의 별도 진단을 완료했습니다. AI 수정 후보, 수정 후 실데이터 검증, 원격 저장소 및 PR은 이 환경에서 만들지 못했습니다.

| 항목 | 관찰 결과 |
| --- | --- |
| 초기 MCP | `c1001155538114e811e8ecf311904723aa131115`, 별도 클론에서 빌드 |
| 초기 Harness 구현 | `a3f2332`, 이후 검증 및 문서 보강. 개별 실행의 전체 Harness SHA는 각 실행 보고서에 기록 |
| Harness 테스트 | 단위 테스트 12건 통과 |
| 원본 MCP 테스트 | 15개 테스트 파일, 147건 통과 |
| 절대시간 문제 | 별도 빌드한 원본 MCP의 실제 stdio 호출이 ISO 8601 고정 구간에 `Invalid time range format`을 반환 |
| 독립 HTTP 확인 | 연결된 WhaTap HTTP 도구가 위와 동일한 고정 구간에 HTTP 200과 비어 있지 않은 서버 지표 데이터를 반환. 셸 실행과 별도인 분리 진단 |
| 실제 AI 오류 처리 | `--agent-smoke` 실행은 `AI_FAILED`로 끝났으며 Codex app-server 초기화 로그에 `Read-only file system (os error 30)`이 기록됨 |
| 실패 분류 재현 | `--failure-example`은 하위 프로세스 종료 코드 17을 `AI_FAILED`로 분류. 보고서 생성과 CLI 종료 코드 1 확인 |
| 전체 실행 | `WHATAP_DEMO_TOKENS_MISSING`에서 `UNVERIFIABLE`. 셸에서 WhaTap 및 GitHub DNS 조회도 실패 |
| 제출 | GitHub 계정의 서버 인증과 권한 확인이 연결 실패로 중단됨. 저장소 생성, Push, PR 생성 및 Collaborator 초대 미완료 |

### 진단 해석

기준 MCP의 `whatap_query_data`는 문자열 `timeRange`를 상대시간 파서로 처리합니다. 원본 파서는 절대 시작 및 종료를 받지 못하므로 기존 구현의 고정 구간 거부는 재현됩니다. 이 설명은 로컬 소스 확인과 실제 호출 결과에 기반합니다. Codex의 변경 결과나 수정 후 데이터를 의미하지 않습니다.

오프라인 설치의 첫 진단에서 esbuild 설치 스크립트의 `spawnSync`가 EPERM으로 실패했습니다. 잠금 파일을 사용한 오프라인 설치에 한해 설치 스크립트를 건너뛰고 이후 실제 빌드를 수행했습니다. 기준 MCP stdio 호출은 별도 진단에서 Node 하위 프로세스가 소켓 fd를 처리하지 못해 종료되었습니다. Bash에서 실제 파이프를 연결하도록 수정한 뒤 새 빌드에서 MCP 시작과 요청 거부를 확인했습니다.

공유용 기록은 데모 조회 기간, 프로젝트 식별자, 행과 필드 값을 제외합니다. 서비스 접근이 가능한 환경에서 전체 실행이 완료되면 원시 근거는 그 실행 디렉터리의 로컬 보고서에 보관합니다. 과거 Harness 결과는 아키텍처와 응답 구조 조사에 참고했습니다.
