# WhaTap AI Agent Harness v2

깨끗한 WhaTap MCP에서 고정 조회 구간 문제를 재현하고, Codex CLI에 분석과 수정을 맡긴 뒤 별도 검증기로 수정 결과를 확인합니다. 통과하면 본인 MCP Fork에 새 브랜치를 Push하고 사람 검토용 PR을 엽니다.

현재 작업의 실제 검증 범위와 남은 조건은 [실행 기록](docs/execution.md)에 있습니다.

## 준비

- Linux Ubuntu, Bash, Git, Node.js 22, npm, GitHub CLI 및 Codex CLI. Codex CLI는 `exec --ignore-user-config`, `--ephemeral`을 지원해야 합니다. 로컬 검증에는 Node.js 22.23.5와 Codex CLI 0.171.0을 사용했습니다.
- `codex login status`로 자동 실행에 사용할 인증을 준비합니다. Codex가 세션을 초기화할 수 있는 쓰기 가능한 사용자 설정 디렉터리와 AI 서비스 네트워크 접근이 필요합니다.
- `gh auth status` 및 `gh api user --jq .login`으로 계정과 연결을 확인합니다. GitHub CLI 계정에는 MCP Fork의 브랜치 Push와 PR 생성 권한이 필요합니다.
- npm 레지스트리, 데모 API, GitHub에 연결되는 셸에서 실행합니다. 쓰기 가능한 임시 디렉터리와 실행 결과 보관용 디스크 공간을 준비합니다.
- WhaTap 데모 담당자가 제공한 Server 프로젝트 코드, APM 프로젝트 코드와 읽기 전용 계정 API 토큰을 준비합니다.

MCP Fork에는 아래 기준 커밋을 가리키는 깨끗한 기준 브랜치가 있어야 합니다. 기존 Fork의 `submission`이 이 커밋을 가리키면 그대로 사용합니다. 다른 곳을 가리키면 원격 브랜치를 이동시키지 말고, 검증 전용 기준 브랜치를 새로 만들어 `baseBranch`에 지정합니다.

```text
c1001155538114e811e8ecf311904723aa131115
```

신규 브랜치가 필요한 경우 본인 Fork의 복제본에서 다음 명령을 사용합니다.

```bash
git fetch https://github.com/whatap/whatap-open-mcp.git c1001155538114e811e8ecf311904723aa131115
git push origin FETCH_HEAD:refs/heads/harness-baseline
```

## 설정 및 실제 실행

Harness의 `submission`을 체크아웃한 뒤 아래 명령을 실행합니다. Harness 자체의 npm 의존성은 없습니다.

```bash
cp config.example.json config.local.json
chmod 600 config.local.json
npm test
```

`config.local.json`의 `fork`를 본인 MCP Fork로 지정하고 `baseBranch`를 위에서 확인한 브랜치로, 두 프로젝트 코드를 각각 실제 데모 프로젝트의 숫자 코드로 바꿉니다. 선택 사항인 `fixedEnd`는 데이터가 이미 발행된 UTC 종료 시각을 Unix 밀리초로 고정하며 5분 경계에 정렬해야 합니다. 기본값은 실행 시각보다 적어도 20분 앞선 최근 5분 경계입니다. 절대시간 조회는 해당 종료 시각까지의 15분을 검증합니다. `apiOrigin`을 생략하면 `https://api.whatap.io`를 사용합니다.

토큰은 비밀 관리 도구 또는 셸 환경으로 공급합니다. 아래 예는 대화형 입력을 최초 실행 **전에** 수행하며 입력을 화면에 표시하지 않습니다. 동일한 읽기 전용 계정 토큰이 두 클라이언트에 허용된 경우 같은 값을 공급할 수 있습니다.

```bash
read -rs -p 'WhaTap MCP token: ' WHATAP_API_TOKEN
printf '\n'
read -rs -p 'WhaTap HTTP reference token: ' WHATAP_HTTP_API_TOKEN
printf '\n'
export WHATAP_API_TOKEN WHATAP_HTTP_API_TOKEN
npm run run
```

실행기가 매회 독립 클론과 `harness-v2/<실행 ID>` 브랜치를 만듭니다. 기준 MCP 빌드 및 테스트부터 접속 검증, 수정, 재검증, Commit·Push·PR까지 자동 실행합니다. 실행 결과가 `SUBMITTED`이면 로컬 보고서의 PR URL에서 diff와 결과를 확인하고 사람이 Merge합니다.

## 판정과 아티팩트

| 영역 | 확인 사항 |
| --- | --- |
| Server | 상대시간 5분과 고정 15분의 Period, CPU·메모리 값, 전체 행 및 포맷된 요약 |
| APM | 트랜잭션 호출·오류·응답시간 합계와 예외 발생 건수, 잘못된 기간 오류 구분, 표시 행 정확성, 절대구간의 전체 5분 버킷별 원본과 v2 그룹 집계 |
| 시계열 | TPS·오류 건수의 5초 격자, 모든 동일 키의 값, 누락과 제한 |

상대시간은 MCP가 출력한 UTC Period를 밀리초로 파싱해 독립 HTTP에 그대로 전달합니다. 절대시간 기준은 명시한 고정 입력이며 MCP 응답의 Period도 정확히 일치해야 합니다. 지원하지 않는 고정 기간을 깨끗한 기준 MCP가 명시적으로 거부하고 같은 기간의 독립 HTTP에 유효한 행이 있을 때만 Codex 수정을 시작합니다. 수정 전후 상대시간 조회는 각각의 독립 기준과 대조합니다.

표의 숫자는 MCP 자릿수 표현에 맞춰 비교합니다. APM 표시가 제한되면 제한 고지가 있는 경우에만 해당 표시 행 전부를 대조하며, 고정 시간에서는 전체 HTTP MXQL과 별도 v2 API를 추가로 대조합니다. 참조 API의 누락, 조회 제한이나 역할이 다른 API 간 불일치로 검증이 불가능하면 코드 오류로 단정할 근거로 사용하지 않습니다.

`runs/<ID>/report.md`는 한국어 판정 및 AI 분석, `report.json`은 요청 조건·원본 응답·실제 비교값·집계·판정 근거를 담습니다. 후보 diff와 명령 로그도 같은 로컬 디렉터리에 있습니다. `public.md`와 PR 본문은 실행기에서 정해진 상태·검증 항목으로 생성합니다. 실제 응답, 프로젝트 코드와 AI 출력은 서비스 정보가 포함될 수 있어 로컬에만 보존합니다. 토큰은 도구별 환경으로 전달하고 검증 보고서에서 알려진 계정·프로젝트 토큰을 제거합니다. Codex에는 서비스 토큰과 원본 데이터를 주지 않습니다.

| 상태 | 의미 |
| --- | --- |
| `SUBMITTED` | 독립 검증과 MCP 회귀 테스트를 마쳤고 PR URL을 받았습니다. |
| `AI_FAILED` | Codex 시작, 응답 또는 실행에 실패했습니다. |
| `VALIDATION_FAILED` | 후보 변경 범위, 빌드, 기존 테스트 또는 독립 데이터 비교가 통과하지 못했습니다. |
| `UNVERIFIABLE` | 인증·네트워크·참조 데이터 부족 등으로 완료를 판정할 수 없습니다. |
| `SUBMISSION_FAILED` | 검증 이후 Commit·Push·PR 단계가 완료되지 않았습니다. 로컬 보고서와 커밋을 확인할 수 있습니다. |

자동 수정은 2회 이내이며 각 시도는 최대 8분입니다. 명령별 빌드·테스트·GitHub·MCP·HTTP 제한 시간도 적용합니다. 재시도는 독립적인 새 MCP 클론에서 후보 변경만 초기화하고 기준과 판정 규칙을 유지합니다.

## 분리된 진단 실행

```bash
# 실제 Codex 실행환경 점검. 질문만 보내며 코드 변경은 수행하지 않습니다.
node run.js --agent-smoke

# 의도적인 비정상 종료로 실패 분류 및 리포트를 검증합니다. 종료 코드는 1입니다.
node run.js --failure-example

# 원본 MCP 빌드 및 테스트와 stdio 오류 응답 확인. 데모 서비스·AI·GitHub를 사용하지 않습니다.
node run.js --config config.example.json --local-source /path/to/original-mcp --build-only
```

오프라인 빌드 진단에는 기존 npm 캐시를 쓰기 가능한 디렉터리에 복사한 뒤 `npm_config_cache`로 지정하고 `--offline-install`을 추가합니다. 이때 잠금 파일대로 설치하되 패키지 설치 스크립트를 건너뛰므로 Linux용 esbuild 선택 패키지도 캐시에 있어야 합니다.

## 설계와 한계

- Node 기본 기능, Codex CLI, Git과 GitHub CLI를 사용했습니다. 실행 순서는 기준 검사 → 수정 → 재검증 → 제출이며, Harness를 실행 중에 수정하는 경로는 없습니다.
- 비교 검증기는 API 호출 및 에이전트와 분리했습니다. 이전 Harness에서 stdio, Period 파서, 숫자·시계열 비교, APM 집계 비교 부분을 가져왔습니다. 앱 실행기와 보고서는 별도 구현입니다.
- 시나리오 정의는 `lib/scenarios.js`, 도구·HTTP 비교는 `lib/probe.js`에 있습니다. 프로젝트·기준 브랜치·기준 시점 변경은 로컬 설정으로 처리할 수 있습니다. 새 지표는 같은 검증 모델에 시나리오 정의를 추가할 수 있습니다. 신규 결함 유형은 재현 기준과 코딩 에이전트 작업 지시의 정의가 필요합니다.
- 5분 버킷 데이터가 없는 희소 프로젝트, 보존 기간을 지난 구간, API 페이지 제한 및 서로 다른 백엔드 응답은 `UNVERIFIABLE`이 될 수 있습니다. 표시 제한이 있는 APM 결과를 전체 MCP 결과로 해석하지 않습니다. 대상 범위는 MCP 표와 요약이며 자유 형식 AI 답변은 검증하지 않습니다.
- 데모 값은 조회 사이에 변할 수 있습니다. MCP와 HTTP는 순차 조회하고 상대시간 기준으로 MCP가 반환한 시각을 그대로 사용합니다. 백엔드 요청 시점이나 조회 중 동시성에 따른 변화를 하네스가 추정하지 않습니다.
- 자동 제출은 직접 관리하는 Fork에서만 실행합니다. PR 단계가 막힌 경우 로컬 검증 증거를 먼저 확인하고 기록된 브랜치와 커밋으로 제출을 복구할 수 있습니다.
