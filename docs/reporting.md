# 보고서와 PR 제출

## 산출물

| 파일 | 읽는 방법 |
| --- | --- |
| `runs/<실행 ID>/report.md` | 검증 배치의 상세 한국어 보고서. 기간, 근거 코드, 오류, 실제 비교표 및 통계 |
| `runs/<실행 ID>/report.json` | MCP 요청·응답, 독립 HTTP 응답, 판정, Git SHA와 빌드 산출물 SHA-256. 보호된 원본 증거 |
| `runs/<실행 ID>/public.md` | 배치별 비식별 판정 요약 |
| 보고서 출력의 `pr-body.md` | GitHub PR에 올릴 본문 |
| 보고서 출력의 `report.md`, `evidence.json` | 각 시도의 결과, 원본 JSON 포인터, 비교 근거와 첨부 로그의 경로·SHA-256 |

배치에는 실제 비교에 사용한 키, 필드, 기간, MCP·HTTP 표본, 누락·중복·집계, 정규화 전후 최대 오차가 기록됩니다. 키 차이로 판정이 끝난 경우 교집합 통계는 별도의 진단입니다. APM 표시 범위 밖의 HTTP 행도 통계에서 확인할 수 있습니다. 상대시간의 전후 값은 각각의 Period에 대한 기준 응답과 비교합니다.

## Codex의 보고서 생성

Codex가 입력을 작성하고 사용자는 증거와 최종 반영 근거를 검토합니다. 기록된 보고서를 다시 생성할 때도 다음 계약을 사용합니다.

1. **Harness 루트**에서 [예제 매니페스트](review.example.json)를 로컬 작업 디렉터리에 복사합니다. `kind`는 변경 대상에 따라 `mcp`, `harness`, `audit`로 지정합니다. 기준·후보·Harness의 전체 커밋 SHA를 채웁니다.
2. `runs`에 실행별 원본 `report.json`을 연결합니다. MCP 변경 보고서에는 깨끗한 원본과 검증을 통과한 깨끗한 후보의 실제 실행을 `before`, `after`로 연결합니다. 보고서 빌더는 지정한 MCP/Harness SHA와 실행 증거, 전후 고정 구간의 일치를 확인합니다. 과거 근거, 실패, 재생은 각각 `history`, `failure`, `replay`로 구분합니다.
3. `attachments`에 `test` 또는 `reproduction` 역할의 로그를 연결합니다. Harness 변경은 동일 입력을 대조한 `comparison` 첨부도 필요합니다. 경로는 매니페스트 파일 기준 상대 경로로 해석됩니다.
4. `sections`의 14개 항목을 채워 재현, 원인, 영향, 변경, 테스트, 실패 이력, 한계와 근거를 설명합니다. 모든 섹션 문장은 공개 범위를 따릅니다. 공개용 본문 검토 후 `publicReviewed`를 설정합니다.
5. MCP·Harness 수정은 변경마다 `mergeRationale`을 제공합니다. 유지 시 위험, 서비스 영향, 대안, 선택 이유, 이점, 호환성 및 최종 반영 근거를 기록합니다. 예제의 분류와 대상 항목에는 아래 값을 사용합니다. 변경 없는 `audit`는 생략할 수 있습니다.

| 필드 | 허용값 |
| --- | --- |
| `classification` | 구현 결함 수정, 기능 개선, 호환성 개선, 보고·운영 개선 |
| `scope` | MCP 동작 품질, Harness 검증, Harness 보고·운영 |

다음은 **Harness 루트**에서 실행하는 예입니다. `runs/task/review.json`은 작성 완료된 매니페스트이며, 출력 폴더는 아직 없어야 합니다.

```bash
umask 077
mkdir -p runs/task
test -f runs/task/review.json || cp docs/review.example.json runs/task/review.json
# 매니페스트를 위 절차대로 채운 뒤 실행
node review.js build runs/task/review.json runs/task/published-review
```

변경별 반영 근거, 실패 또는 검증 불가, 전후 판정과 핵심 테스트는 펼쳐집니다. 실제 비교표는 시나리오 한 곳에서 전후를 접고 펼칠 수 있습니다. `testDetails`로 상세 테스트 내용을 별도 접기 영역에 둘 수 있습니다. 시나리오마다 대표 표본은 최대 5개이며 불일치와 한쪽에만 존재하는 행을 먼저 표시합니다. 표시용 소수 측정값은 최대 유효숫자 8자리, 차이와 오차는 5자리입니다. 작은 비영값은 과학적 표기법을 사용합니다. 원본 JSON 정밀도, 비교와 판정 기준은 유지됩니다.

## 구조화 AI 답변 증거

서버 CPU 답변 검증은 `runs/ai-cpu-*/`에 MCP 호출 및 실제 응답(`capture.json`), 제출한 최종 답변(`submission.json`), 독립 HTTP 및 계산 근거(`report.json`), 두 판정과 차이(`report.md`)를 남깁니다. `public.md`에는 별도 판정과 사유 코드가 표시됩니다. 답변 원문과 실제 조회 조건·수치는 로컬 기록으로 보호하고, 공개할 때 기존 승인·비식별화 정책을 적용합니다. 검증에 사용한 JSON과 별도의 자연어 답변을 작성하는 경우 그 자연어는 검증 범위에 포함되지 않습니다.

## 데이터 공개 설정

공개가 승인된 환경은 **Harness 루트**에 `publication.local.json`을 만듭니다. 승인 근거와 범위를 모를 때는 파일을 만들지 않습니다. 이 설정은 표·통계의 공개 범위를 결정하며 GitHub 검토나 제공자의 허가를 대신하지 않습니다.

```bash
test -f publication.local.json || install -m 600 publication.example.json publication.local.json
```

이 명령은 승인된 환경에서만 실행하며 복사 후 실제 값으로 편집합니다. 예제의 빈 승인과 프로젝트 목록은 유효한 정책이 아닙니다.

| 설정 | 의미 |
| --- | --- |
| `authorization` | 제공자 제한에 부합하는 실제 공개 승인 참조 |
| `projectCodes`, `fields` | 승인된 프로젝트 양의 정수 코드와 검증 대상의 정확한 수치 필드명 |
| `includeDifferences` | 표본의 원값·정규화 후 차이를 공개. 기본값 `false` |
| `includeStatistics` | 비교 필드 전체가 승인된 시나리오의 행 수 등의 자동 통계를 공개. 기본값 `false` |

CPU, 메모리, TPS, 오류·예외와 호출 수, 응답시간 및 집계 중 빌더가 지원하는 필드만 설정할 수 있습니다. 같은 프로젝트·지표의 승인 범위는 이후 실행에도 적용됩니다. 별도 설정을 쓰려면 `node review.js build MANIFEST OUTPUT --publication-policy FILE`을 사용합니다. 과거 `publishSamples`, `publishCounts`는 공개를 허가하지 않습니다.

공개 표는 조회 시작 기준 상대 위치와 일관된 가명을 사용합니다. 실패 사례에는 보호 대상 문자열이 없는 오류 안내와 공개 가능한 독립 HTTP 대조 표본을 사용합니다. 승인되지 않은 수치, 인증정보, 원본 UTC 시각, IP, 호스트명, 프로젝트·트랜잭션 식별자와 전체 응답은 공개하지 않습니다. 설정 및 실행 디렉터리는 Git에서 제외합니다.

## GitHub PR과 검토

MCP 변경은 [후보 확정과 제출 순서](usage.md#후보-확정과-제출-순서)에 따라 빌드·테스트와 배포 산출물 커밋을 마친 깨끗한 후보에서 검증합니다. 보고서의 후보 SHA와 PR의 head는 같아야 합니다.

Codex는 변경한 저장소별로 실제 원격과 기준 SHA, 현재 GitHub 계정과 쓰기 권한을 확인한 뒤 별도의 작업 브랜치에 커밋합니다. MCP의 제출 대상은 `config.local.json`의 본인 Fork입니다. Harness의 제출 대상은 권한 있는 Harness 원격입니다. 한 저장소만 변경했다면 그 저장소의 PR만 만듭니다. 두 저장소에 변경이 있으면 PR을 상호 참조하고 MCP PR에 실제 검증한 Harness SHA를 명시합니다.

검토용 브랜치를 Push한 뒤 **Harness 루트**에서 실행하는 예입니다. 아래의 변수에는 위에서 이미 확인한 제출 대상과 브랜치를 지정합니다.

```bash
gh pr create --repo "$MCP_FORK" --base "$BASE_BRANCH" --head "$HEAD_BRANCH" \
  --title "변경 요약" --body-file runs/task/published-review/pr-body.md
```

기존 PR의 본문 갱신에는 `gh pr edit "$PR_NUMBER" --repo "$MCP_FORK" --body-file runs/task/published-review/pr-body.md`를 사용할 수 있습니다. 제목, 코드 차이, 검증 실패와 한계, 공개된 비교 표본을 확인한 뒤 사용자가 GitHub에서 최종 Merge합니다. 객관적 근거가 없으면 그 이유를 보고합니다.

## 기존 근거로 재생성

- **보고서 서식만 재생성.** 기존 원본과 테스트 로그를 가리키는 매니페스트를 `review.js build`에 전달합니다. 새 출력 경로를 사용하면 기존 실행 파일을 보존합니다.
- **판정 재생.** `node verify.js --replay runs/실행ID/report.json`은 저장된 MCP 요청·응답과 독립 HTTP 구간이 맞는지 확인하고 이전·현재 판정을 새 실행에 함께 남깁니다. 과거 오류 플래그를 추정한 경우 표시됩니다. 재생에는 서비스 접근이 필요하지 않습니다.
- **실데이터 재검증.** 새로운 검증을 주장하려면 [직접 검증](usage.md#직접-검증)을 실행합니다. 저장 입력 재생은 최신 실제 서비스 검증 근거와 구분합니다.
