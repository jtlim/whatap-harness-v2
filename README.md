# WhaTap AI Agent Harness v2

Codex에 “MCP의 APM 조회 기능을 검수해 줘”처럼 요청합니다. Codex는 저장소의 [작업 지침](AGENTS.md)에 따라 검증 시나리오를 선택하고, 독립 비교 결과로 원인을 분석한 뒤 MCP 또는 Harness를 수정하고 재검증합니다. 변경은 저장소별 PR로 제출하며 사용자가 검토와 Merge를 담당합니다.

## 준비

Linux, Bash, Git, Node.js 22, npm과 Codex를 사용합니다. PR 제출에는 GitHub CLI와 Fork 쓰기 권한이 필요합니다. Harness 자체의 npm 의존성은 없습니다. MCP 원본 기준은 `c1001155538114e811e8ecf311904723aa131115`입니다.

```bash
cp -n config.example.json config.local.json
chmod 600 config.local.json
npm test
npm run run -- --list
```

`config.local.json`에 데모 Server와 APM 프로젝트의 숫자 코드(`serverProject`, `apmProject`)를 입력합니다. `WHATAP_API_TOKEN`과 `WHATAP_HTTP_API_TOKEN`은 기존 비밀 관리 방식으로 환경에 주입합니다. 기본 API 주소는 `https://api.whatap.io`이며, 로컬 설정의 `apiOrigin`에는 승인된 WhaTap 데모 주소만 설정합니다. `fork`와 `baseBranch`는 아래의 레거시 자동 제출 명령에서만 사용됩니다.

## Codex에서 검수하기

Harness 저장소를 프로젝트로 열고 자연어로 요청합니다. Codex가 시나리오를 선택하며 같은 명령을 각 빌드 체크아웃에 사용할 수 있습니다. 사람도 아래 명령으로 직접 재현할 수 있습니다.

```bash
node verify.js --list
node verify.js --mcp /path/to/built-baseline --select apm --select timeseries --phase before
node verify.js --mcp /path/to/built-candidate --select server-absolute --phase after --fixed-end "$fixed_end"
node verify.js --replay runs/실행ID/report.json
```

`--mcp`는 대상 Git 체크아웃이며 먼저 그 위치에서 `npm ci`, `npm run build`, `npm test`를 수행합니다. `--select`를 생략하면 등록된 9개 시나리오를 실행합니다. `all`, `server`, `apm`, `timeseries`, `range` 또는 개별 ID를 선택할 수 있습니다. `timeseries`는 APM의 TPS·오류 건수 시계열을 선택합니다. `--request`에는 로컬 보고서에 남길 요청 요약을 넣을 수 있습니다.

절대시간 전후 비교에는 두 명령에 같은 `--fixed-end`를 적용합니다. 이 값은 5분 경계의 UTC Unix 밀리초이며, 종료 시각까지의 15분을 검증합니다. 생략하면 로컬 설정의 `fixedEnd`, 그 값도 없으면 실행 시각보다 최소 20분 앞선 최신 5분 경계를 사용합니다. 상대시간은 MCP의 실제 출력 Period를 독립 HTTP 요청에 그대로 전달합니다.

시나리오 배치에는 최대 8분, MCP 호출당 45초, HTTP 요청당 30초 제한을 적용합니다. Harness는 배치 안에서 자동 재시도하지 않습니다. Codex가 근거를 확인한 후 정책 범위에서 재시도합니다. 무인 Codex CLI 세션에는 예를 들어 `timeout --kill-after=10s 35m codex exec "MCP 전체를 검수해 줘"`로 전체 실행 시간을 제한할 수 있습니다. 개별 수정과 테스트에는 [작업 지침](AGENTS.md)의 제한을 적용합니다.

## 검증 기준과 결과

| 영역 | 기계적 검증 |
| --- | --- |
| Server | 상대·절대 조회 기간, CPU·메모리 값, 행 키와 완전성, 출력 요약 |
| APM | 상대·절대 트랜잭션·예외 통계, 표시 제한 안내, 그룹 합계, 고정 구간의 별도 v2 집계, 잘못된 기간 오류 |
| 시계열 | TPS·오류 건수 값, 전체 5초 격자, 중복·누락·조회 제한 |

MCP 표의 수치는 기존 표시 정밀도로 비교합니다. APM 표시가 제한되면 명시적으로 안내된 표시 행 전체를 대조합니다. 별도 v2 집계는 절대 구간에서 검증합니다. 기준 HTTP 데이터가 희소하거나 제한되거나 API 간 의미가 다른 경우 확인 가능한 범위를 판정에 반영합니다. 이는 MCP가 출력한 데이터와 요약의 일치 검증입니다. 자유 형식 Codex 답변의 모든 수치·추론이나 등록 시나리오 외 도구는 기계적으로 판정하지 않으므로 검수 보고서에 해당 범위를 적습니다.

`verify.js`의 종료 코드는 `0` 검증 통과, `1` 검증 실패, `2` 검증 불가 또는 환경·인증 문제입니다. 개별 판정과 상세 사유는 `runs/실행ID/report.json`과 한국어 `report.md`에 기록하며, 대상 Git SHA와 빌드 산출물 SHA-256도 남깁니다. 증거만 재생할 때는 기존 요청과 HTTP 시간 구간을 재확인하고 이전 판정과 현재 판정을 함께 기록합니다. 과거 보고서에서 MCP 오류 플래그를 복원한 경우는 JSON에 표시됩니다. 재생에는 실제 API 접근이 필요하지 않습니다.

원본 응답, 프로젝트 코드와 실제 조회 조건은 권한이 제한된 로컬 실행 디렉터리에 보존합니다. `public.md`는 비식별 판정 요약입니다. PR 본문에는 리뷰에 필요한 분석과 비식별 근거를 사용합니다.

## 실행 보고와 제출

검증 배치가 남긴 보고서와 JSON을 근거로 Codex가 전체 작업의 한국어 보고서를 완성합니다. 여러 배치가 있는 경우 시도별 실행 ID를 연결합니다.

- 작업 개요에 요청, 검수 범위, 기준과 후보 SHA, 환경과 선택 시나리오를 기록합니다.
- 문제마다 재현 절차, 관찰 결과, 기대 동작, 원인과 책임 영역, 영향, 수정 필요성을 기록합니다.
- 변경 파일, 선택한 방법과 대안, 기술적 근거, 기존 동작에 미치는 영향을 설명합니다.
- 전후 MCP·HTTP 비교를 각 배치의 로컬 증거와 연결합니다. 조회 기간, 식별자·수치·누락·중복·집계 검사, 빌드·회귀 결과와 Harness 판정 차이를 포함합니다. 상대시간은 각 응답과 그 응답의 독립 기준을 비교합니다.
- 최종 결과에 재시도 이력, 해결 여부, 검증 한계, 재현 명령, 관련 커밋과 PR을 기록합니다. 변경한 저장소에만 PR을 제출합니다.

## 기존 진단 재현

`node run.js --build-only --local-source /path/to/original-mcp --config config.example.json`은 기존 원본 빌드·회귀·오류 응답 진단입니다. `--failure-example`은 통제된 AI 실행 실패를, `--agent-smoke`는 Codex 초기화를 검사합니다. 과거 고정 시나리오의 Full Build는 기록 재현용으로 `node run.js --legacy-full`에서 명시적으로 실행할 수 있습니다. 이 모드는 고정 UTC 구간 MCP 수정과 로컬 검증을 수행하므로 일반 검수에는 Codex와 `verify.js`를 사용합니다. 기존 결과는 [실행 기록](docs/execution.md)을 참조합니다.

## 보고서 생성과 PR 제출

새 환경에서는 이 저장소를 Clone한 뒤 Node.js 22와 Git을 준비하고 위 예시로 `config.local.json`을 설정합니다. 읽기 전용 토큰은 환경변수로 주입합니다. Codex에서 이 저장소를 프로젝트로 열면 버전 관리된 `AGENTS.md`가 적용됩니다. 홈 디렉터리의 Codex 설정이나 이전 실행 기록은 필요하지 않습니다.

`verify.js`는 각 배치의 `report.json`에 실제 요청, MCP 원문, HTTP 응답, 비교용 키·필드, 원본 및 표시 변환 후 최대 오차, 행 수, 누락·중복, 표본, 집계 판정과 종료 이유를 저장합니다. `report.md`의 JSON 포인터로 해당 비교를 찾을 수 있습니다. 원래 비교가 키 차이에서 종료된 경우에도 교집합의 진단 통계를 볼 수 있으며, 이 수치는 원래 성공 판정에 사용되지 않습니다. APM의 표시 범위 밖 HTTP 행도 통계에서 별도로 확인합니다.

1. [보고서 입력 양식](docs/review.example.json)을 쓰기 제한된 작업 실행 디렉터리로 복사하고 14개 항목을 채웁니다. `kind`는 `mcp`, `harness`, `audit` 중 하나입니다. MCP 수정은 깨끗한 기준과 검증을 통과한 깨끗한 후보의 실제 실행 JSON을 `before`, `after` 역할로 제공합니다. 실패는 `failure`, 이전 증거는 `history`, 재생은 `replay` 역할로 연결합니다. 비데이터 검증은 동일 입력의 수정 전후 결과와 테스트 로그를 첨부합니다.
2. `attachments`에는 로그 또는 비교 증거를 연결합니다. 테스트나 재현 로그에 각각 `role: "test"` 또는 `role: "reproduction"`을 지정합니다. Harness 변경은 `role: "comparison"`의 동일 입력 전후 근거도 필요합니다. 입력 양식 기준 상대 경로를 사용합니다. `sections`의 문장은 공개에 적합하게 작성하고, 공개 범위를 확인한 뒤 `publicReviewed`를 설정합니다. 실제 표본과 자동 생성 통계는 아래의 공개 정책으로 관리합니다. 대표 원본 값과 요청 인수는 로컬 보고서에서 확인합니다.
3. 출력 디렉터리는 아직 존재하지 않는 경로를 지정합니다. 아래 명령은 원본 파일을 읽고 새 디렉터리에만 출력합니다.

```bash
node review.js build runs/task/review.json runs/task/published-review
```

`pr-body.md`는 제출용입니다. `report.md`와 `evidence.json`은 제출용 설명에 실제 데이터 표본·통계를 연결한 로컬 산출물입니다. 원본 파일과 테스트 로그의 상대 경로 및 SHA-256을 로컬 색인에 남깁니다. 권한 있는 리뷰어는 PR에 적힌 실행 ID의 `runs/<실행 ID>/report.json`을 열거나 승인된 환경에서 재현할 수 있습니다. 객관적인 증거가 없으면 해당 항목에 이유를 남깁니다. 출력 검사를 통과한 후 별도 작업 브랜치에서 `gh pr create --body-file` 또는 `gh pr edit --body-file`로 제출합니다.

### 비교표와 공개 승인

생성된 두 보고서는 요약, 문제와 수정, 독립 검증, 테스트와 재현, 근거 순서로 읽습니다. 공개 보고서의 시나리오별 판정과 로컬 보고서의 실제 요청·표본·통계는 펼쳐진 상태로 표시됩니다. 로컬 보고서 하단 링크에서 같은 환경의 원본 실행 JSON과 로그를 바로 열 수 있습니다. 보고서 파일과 근거는 권한이 제한된 실행 디렉터리에 보관합니다.

승인된 환경에서는 `publication.example.json`을 저장소 루트의 `publication.local.json`으로 복사합니다. 실제 승인 참조를 `authorization`에, 공개가 허용된 프로젝트 코드와 수치 지표를 `projectCodes`와 `fields`에 지정합니다. 예시의 빈 승인과 프로젝트 목록은 사용할 수 없습니다. 정책 파일이 없으면 측정값과 자동 집계 통계를 공개하지 않습니다. 로컬 정책 파일은 Git에서 제외되며 승인 참조나 프로젝트 코드를 PR 본문에 싣지 않습니다.

- 지표는 CPU·메모리 사용률, TPS, 오류·예외 수, 트랜잭션 호출 수, 응답시간 및 기존 비교기가 검증하는 합계 중 승인된 정확한 필드명으로 설정합니다. 실행 ID와 시나리오 순서와 무관하게 같은 프로젝트의 새 시나리오에도 적용됩니다.
- `includeDifferences`는 표본의 원값·정규화 후 차이를, `includeStatistics`는 시나리오의 모든 비교 필드가 승인된 경우 행 수·일치·불일치 통계를 공개합니다. 두 항목은 기본값이 `false`입니다. 기존 판정은 유지합니다.
- 자동 표본은 시나리오마다 최대 5개이며 불일치와 한쪽에만 존재하는 행을 우선합니다. 실제 UTC 시각을 생략하고 원본 복합 키는 보고서 안에서 일관된 별칭으로 대체합니다. 원문과 승인되지 않은 값은 로컬 보고서에 보관합니다.
- 특정 제출에 범위를 한정하려면 `node review.js build MANIFEST OUTPUT --publication-policy FILE`로 별도 정책 파일을 지정합니다. 이전 매니페스트의 실행별 `publishSamples` 및 `publishCounts`에는 공개 권한이 부여되지 않습니다.
