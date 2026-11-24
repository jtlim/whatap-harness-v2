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

`node run.js --build-only --local-source /path/to/original-mcp --config config.example.json`은 기존 원본 빌드·회귀·오류 응답 진단입니다. `--failure-example`은 통제된 AI 실행 실패를, `--agent-smoke`는 Codex 초기화를 검사합니다. 과거 고정 시나리오의 Full Build는 기록 재현용으로 `node run.js --legacy-full`에서 명시적으로 실행할 수 있습니다. 이 모드는 고정 UTC 구간 MCP 수정과 GitHub 제출을 시도하므로 일반 검수에는 Codex와 `verify.js`를 사용합니다. 기존 결과는 [실행 기록](docs/execution.md)을 참조합니다.
