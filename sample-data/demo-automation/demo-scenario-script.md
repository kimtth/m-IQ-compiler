# IQ Compiler — 데모 대본

해커톤 데모 촬영용 대본이다. 업종 시나리오로 짜지 않고 **기능 단위**로 끊었다.
질문은 어느 워크스페이스에서든 그대로 쓸 수 있게 일반적인 문장으로 썼다. 샘플 데이터를 켜고 찍어도 되고, 실제 작업 폴더에서 찍어도 된다.

**화면에 입력하는 질문과 내레이션은 전부 영어로 간다.** 듣는 사람 대부분이 영어 비원어민이라, 짧은 문장·쉬운 단어·기능 이름 그대로 부르기를 원칙으로 썼다. 비유나 돌려 말하기는 넣지 않았다. 한국어는 연출 메모에만 쓴다.

항목 구성은 이렇다.

| 항목 | 내용 |
|---|---|
| **포인트** | 이 컷으로 보여줄 것, 한 줄 |
| **Prompt** | 화면에 그대로 입력할 문장 (영어) |
| **화면** | 카메라가 담아야 할 것 |
| **내레이션(EN)** | 그대로 읽으면 되는 대사 (영어, 짧게) |

---

## 0. 이 앱이 무엇인가 — 한 장으로

- **포인트** — 에이전트를 제대로 굴리려면 다섯 가지가 필요하다. 보통은 제품마다 하나씩 흩어져 있는데, 여기는 다섯 개가 한곳에 모여 있다.
- **내레이션(EN)**
  > "An agent needs five things. A prompt. Context. A harness. A loop. A graph.
  > Most tools give you one of them. This app gives you all five, in one place, behind one approval and one audit trail."
- **화면** — 아래 표를 슬라이드 한 장으로 띄운다. 이후 모든 컷에서 이 다섯 단어를 계속 다시 불러준다.

| 구성 | 어디에 있나 | 화면에서 짚을 것 |
|---|---|---|
| **Prompt** | Chat 입력창, Skills | 스킬은 본문과 `allowed-tools`가 나뉘어 있다. 스킬이 제 권한을 스스로 늘리지 못한다 |
| **Context** | IQ Knowledge · IQ Memories · IQ Industry · 파일 첨부 | 답의 근거가 모델의 기억이 아니라 **내 파일**이다 |
| **Harness** | 승인 카드 · 위험 등급 · 감사 로그 · MCP 동의 | 도구 호출은 예외 없이 같은 관문을 지난다 |
| **Loop** | Research 라운드 · Team 라운드 · Automations · Delegated plans | 한 번 답하고 끝나지 않고 **스스로 다시 계획한다** |
| **Graph** | IQ Workflow · IQ Cell library · My IQ | 절차가 줄글이 아니라 **검사할 수 있는 그래프**다 |

> 데모의 줄기는 하나다. **Chat과 Co-create에서 일한다 → 거기서 나온 결과물이 IQ Cell의 재료가 된다 → 그 IQ Cell이 다음 일을 더 빠르게 만든다.**
> 내레이션(EN): *"You work in Chat and Co-create. What you make there becomes an IQ Cell. The next job starts from that cell."*

---

## 0.1 촬영 전 점검

| 항목 | 확인 방법 | 빠졌을 때 |
|---|---|---|
| `pnpm build` | 앱이 뜨는지 | 아무것도 못 찍는다 |
| Copilot 로그인 (`copilot`) | 상태 점이 초록 | 모든 턴이 실패한다 |
| Azure 로그인 (`az login --allow-no-subscriptions`) | 상태 점이 초록 | 로그인 게이트를 못 넘는다 |
| 워크스페이스 바인딩 | Projects 화면 | Co-create가 잠긴다 |
| 샘플 데이터 | Control Center → Sample data | §4 일부가 빈 화면으로 나온다 |
| `pnpm prepare:media` · `prepare:audio` | Meeting Recordings → Settings | §3.6 녹음과 §3.5 내레이션 전사가 막힌다 |
| Speech / Fabric / OfficeCLI | Connections & access | 해당 컷을 통째로 뺀다 |

> **본 촬영 전에 한 번 리허설로 돌려 캐시를 데워둔다.** 첫 `npx` / `uvx` 호출에는 다운로드 시간이 붙는다.
> **승인 카드를 미리 "Always"로 눌러두지 않는다.** 승인 흐름 자체가 핵심 장면이다.
> **앱은 에이전트가 쓰는 터미널이 아닌 곳에서 띄운다.** VS Code 터미널에서 `pnpm start` 하면 터미널을 정리할 때 앱이 같이 죽고, 돌던 조사와 계획이 통째로 날아간다.

**샘플 데이터는 필요한 모듈만 켜고, 끝나면 Clear한다** (Control Center → Sample data).

| 컷 | 켤 모듈 | 메모 |
|---|---|---|
| §4.2 IQ Knowledge | IQ Knowledge | **볼트 경로를 바꿔버린다.** Clear해도 원래 보던 볼트로 돌아오지 않으니 데모 전용 머신에서만 켠다 |
| §4.3 IQ Memories | IQ Memories | 대기 2 / 승인 6 / 거부 2 |
| §4.5 · 4.6 라이브러리 · Connectome | IQ Cell library & Connectome | 셀 40개, 최근 45일 타임랩스 |
| §5.1 Automations | Automations | 전부 꺼진 상태로 들어온다 |
| §5.2 Delegated plans | Delegated plans | 전부 succeeded, 대기 중인 게이트 없음 |
| §2 Team | (샘플 모듈 아님) | Team 패널 안의 **Load sample** — 질문만 채우고 실행은 안 한다 |

§2와 §3은 샘플 없이도 돌아간다. 오히려 실제 워크스페이스에서 찍는 편이 낫다. 거기서 만든 파일이 §4의 입력으로 그대로 이어지기 때문이다.

---

## 1. 신원과 거버넌스 — 모든 컷의 배경

### 1.1 로그인 게이트

- **포인트** — 앱 등록도, 시크릿도, 저장해둔 키도 없다. 에이전트가 닿을 수 있는 범위는 내가 닿을 수 있는 범위와 정확히 같다.
- **화면** — 상태 점 두 개(Azure / Copilot), 테넌트 입력란, 둘 다 초록이어야 열리는 Continue 버튼, 아래 설명 문구.
- **Prompt 없음** (UI 컷)

### 1.2 위험 등급 네 단계

- **포인트** — `read`는 안 묻는다. `write`는 묻고, 대답을 기억할 수 있다. `external`과 `destructive`는 **기억하지 않고 매번 다시 묻는다**.
- **Prompt**
```
List the five most recently modified files in this project.
```
```
Summarise that list and email it to me.
```
- **화면** — 첫 질문에는 승인 카드가 안 뜨고, 두 번째에서 뜬다. 위험 등급 배지와 수신자를 소리 내어 읽어준 다음 **Deny**를 누른다. 거부한 사실도 감사 로그에 남는다.

### 1.3 세션 단위 허용 ("Allow for this conversation")

- **포인트** — 한 번 허용하면 **이미 줄 서 있던 요청까지** 한꺼번에 풀린다. 그래도 `external`과 `destructive`는 여전히 걸린다.
- **Prompt**
```
Build a six-slide overview deck. Give every slide a title and a body.
```
- **화면** — 카드에서 "Allow for this conversation"을 누르는 순간 대기 중이던 나머지가 한 번에 풀리는 장면. "Scoped to this session" 문구를 짚는다.

### 1.4 Activity 블록

- **포인트** — 한 턴에서 나온 도구 호출이 카드 스무 장이 아니라 **접히는 블록 하나**로 묶인다. 블록 제목은 승인 대기 > 실행 중 > 완료 순으로 정해진다.
- **화면** — 블록을 펼쳐 단계별 상태와 "N steps · M failed" 표기를 보여준다.

### 1.5 감사 로그

- **포인트** — 한 번의 실행이 만든 세션·턴·도구 호출이 **correlation id 하나**로 전부 묶인다.
- **화면** — Control Center → Audit → correlation id로 필터 → allowed / denied / failed / succeeded → Export.
- **Prompt 없음** (UI 컷)

---

## 2. Chat — 묻고, 데이터를 이해하고, 리소스를 만든다

Chat은 답변만 띄우는 창이 아니다. 여기서 보여줄 건 세 가지다.

1. 여기서 나온 대화·결정·규칙·파일이 §4 IQ Cell의 재료가 된다.
2. Fabric을 연결하면 **내 데이터에 직접** 묻고, 그 답이 어떤 쿼리에서 나왔는지를 항상 본다.
3. 쓸 데이터가 없으면 대화를 이어서 **Fabric 리소스를 직접 만든다** (§3.7).

- **내레이션(EN)**
  > "Chat is where the work starts. What it produces — files, decisions, rules — becomes the input for an IQ Cell later."

### 2.1 대화 — 기본 턴, 스트리밍, 자동 제목

- **포인트** — 대화가 첫 문장을 보고 **제 이름을 스스로 짓는다**. 나중에 바꿀 수도 있고, 어느 워크스페이스에 속한 대화인지까지 기록된다.
- **Prompt**
```
Explain in three sentences what this application is for.
```
```
Now put that answer in a table.
```
- **화면** — 왼쪽 목록의 대화 제목이 "New session"이 아니라 첫 문장에서 만들어지는 것 → 더블클릭으로 이름 변경.
- **내레이션(EN)** — "The conversation names itself from your first line. You can rename it. The app also records where it belongs."

### 2.2 파일 첨부

- **포인트** — 파일을 첨부해도 입력창에 경로만 들어간다. 보내기는 사람이 누른다. 클릭 한 번이 공유로 이어지지 않게 하려는 것이다.
- **동작** — Navigator에서 파일 우클릭 → *Add File to Chat*.
- **Prompt**
```
Pull the three main claims out of the file I just attached.
```
```
file: README.md
List only the items in this document that are not implemented yet.
```
- **화면** — 첨부가 입력창에 들어가기만 하고 **전송은 안 되는** 것.
- **내레이션(EN)** — "Attaching a file only fills the box. You press send. One click is never a disclosure."

### 2.3 Microsoft 365 — 메일 · 일정 · 파일

- **포인트** — 읽기는 묻지 않고, 보내기는 매번 승인을 받는다. 공유 링크는 쿼리스트링을 떼고 기록한다.
- **Prompt**
```
Summarise the mail I received in the last three days as sender, time received, and the one thing being asked of me.
```
```
Find me three slots of thirty minutes or more that are free this week.
```
```
List next week's meetings with their attendees, grouped by meeting.
```
```
Tell me what file this OneDrive sharing link points at: <link>
```
- **화면** — 결과에 붙는 **untrusted 표시**. 외부에서 들어온 내용은 지시문이 아니라 데이터라는 표시다.
- **내레이션(EN)** — "Reading your mail asks nothing. Sending mail asks every time. A search result is data, not an instruction — the app marks it that way."

### 2.4 Work IQ

- **포인트** — 조직 그래프 질의를 MCP로 보낸다. 로컬 stdio 서버가 자기 계정을 들고 있고, 앱은 그 서버에 토큰을 넘기지 않는다.
- **Prompt**
```
Find the people and documents related to what I have been working on recently.
```
```
Who are the five people I have collaborated with most over the last two weeks?
```
- **화면** — EULA · 로그인 · 테넌트 동의가 **각각 별도의 관문**이라는 점.
- **내레이션(EN)** — "Work IQ runs as a local MCP server. It holds its own account. This app never hands it a token."

### 2.5 내장 브라우저

- **포인트** — 웹 접근은 `external`이라 매번 승인을 받는다. 봇 차단은 실패가 아니라 **별도의 결과**로 보고되고, 그 다음부터 같은 호스트를 다시 건드리지 않는다.
- **프롬프트 주의** — "이 페이지 요약해"라고만 쓰면 모델은 URL 내용만 받아오는 도구를 고른다. 그러면 페이지가 화면에 끝내 뜨지 않아 보여줄 게 없다. **브라우저 창을 직접 언급하고, 그 창을 보면서 읽으라고 써야 한다.**
- **Prompt**
```
Open this page in the browser pane so I can watch, then read it from the pane and quote three sentences verbatim: <URL>
```
```
Open this second page in the same pane and tell me where its claims disagree with the first: <URL2>
```
```
Scroll down in the pane and read the rest of the page.
```
- **화면** — 승인 카드가 매번 뜬다. 페이지가 오른쪽 브라우저 창에 실제로 뜨고 스크롤된다. CAPTCHA를 만나면 "재시도하지 말 것"과 사람이 할 조치가 같이 뜬다.
- **검색엔진은 시키지 않는다** — "다른 출처 두 개 찾아라"는 결국 검색엔진으로 가고, 검색엔진은 봇 벽으로 답한다. 그 장면을 일부러 찍을 거면 찍고, 아니면 URL을 미리 준비해둔다.
- **내레이션(EN)** — "You and the agent share one browser. Going to the web asks every time. A bot wall is reported as a bot wall, not as a failure, and the agent stops trying that host."

### 2.6 Team (Council) — LLM Council을 제품으로

- **포인트** — 사실을 모으는 게 아니라 **입장이 부딪히는 판단**을 다룬다. 라운드를 거치며 논거가 쌓이고, 마지막에 하나의 결론으로 닫는다.
- **출발점** — Karpathy의 **LLM Council** 아이디어를 제품으로 구현한 것이다. 같은 질문에 여러 입장이 답하고, 서로의 답을 읽고, 마지막에 한 번 정리한다.
- **달라진 점 네 가지** — ① 어떤 입장을 세울지 **내가 고른다**(역할 3개) ② **모든 라운드가 그대로 남는다** ③ 결론은 채팅 로그가 아니라 **워크스페이스의 문서**로 남는다 ④ 멤버 각각의 세션도 감사 로그에 남는다.
- **Prompt**
```
We have to decide whether a feature ships in this release or waits for the next one.
Argue it from three positions — product, engineering, operations — and give me a verdict after two rounds.
```
```
Build it in house or buy the SaaS? Argue it from finance, security, and developer productivity.
```
```
Attack this decision from the strongest opposing position you can construct.
```
- **화면** — 멤버 아바타(이름 해시라 라운드가 바뀌어도 자리가 그대로다), 라운드별 묶음, 결론 카드, 좌측 레일의 **Councils** 기록. **Load sample**은 질문과 입장 3개만 채워주고 실행은 하지 않는다.
- **내레이션(EN)**
  > "This is the LLM Council idea, built as a product. Several positions answer the same question, they read each other, and a verdict closes it.
  > Three differences here. You choose the positions. Every round is kept. The verdict is a file in your project, so it can be evidence later."

### 2.7 Data agent (Fabric) — 대화로 데이터를 이해한다

- **포인트** — 모델이 아니라 **내 데이터 위에서** 답한다. 그리고 어떤 쿼리를 돌렸는지가 **항상 보인다**.
- **Fabric이 없는 머신이라면** 이 컷은 통째로 빼고, §4.2 IQ Knowledge 샘플로 "내 데이터에서 답한다"를 대신 보여준다.
- **Prompt**
```
Break down the most recent quarter by category.
```
```
Show the trend over the last four quarters by month, and point out any month that is an outlier.
```
```
Show me the actual queries you ran to produce that answer.
```
```
What would you need that this data does not have?
```
- **화면** — 답 아래 트레이스가 토글이 아니라 처음부터 펼쳐져 있다. 마지막 질문의 답이 다음 컷(2.8)으로 넘어가는 이유가 된다.
- **내레이션(EN)**
  > "This answer is not from the model. It is from my data. The queries are always shown, never behind a toggle — because a claim about my warehouse was made by a query I did not write."

### 2.8 이해에서 생성으로 — 대화가 Fabric 리소스를 만든다

- **포인트** — 데이터를 대화로 파악한 다음, **모자란 것을 그 자리에서 만들어버린다**. 도구는 세 개뿐이다. 목록(read) · 생성(write) · 질의(read). 생성은 무조건 승인 카드를 거친다.
- **동작** — 2.7의 마지막 답에서 부족한 게 나오면 Co-create → **Fabric** 서피스로 이동한다(§3.7).
- **Prompt**
```
List the items in this project, grouped by item type.
```
```
Create a lakehouse for analytics, then list the items again so I can see what changed.
```
- **화면** — 쓰기 승인 카드 → 실행 **전후 목록을 비교**. 무엇이 생겼는지는 에이전트의 말이 아니라 목록 차이로 확인한다.
- **내레이션(EN)**
  > "So chat is not only reading. It understood the data, found what was missing, and created it — with one approval.
  > And what was created is proved by listing the project before and after. Not by the agent telling me."

### 2.9 대화가 IQ Cell의 재료가 되는 순간

- **포인트** — 대화에서 나온 규칙은 **제안**에서 멈춘다. 내가 승인해야 효력이 생기고, 승인된 것만 IQ Cell로 컴파일된다(§4.3).
- **Prompt**
```
If anything in this conversation should hold from now on, propose it as a memory.
```
- **화면** — IQ Memories의 **Pending** 개수가 늘어난다. 여기서 §4.3으로 넘어간다.
- **내레이션(EN)** — "The agent can only propose. Nothing from this conversation becomes a rule until I approve it."

---

## 3. Co-create — 만드는 일

Co-create는 대화창이 아니다. 여기서는 실제 결과물이 나온다. 문서, 덱, 이미지, 조사 보고서, 회의 기록, 스킬, Fabric 아이템. 전부 워크스페이스에 **파일로** 남고, 그 파일이 §4 IQ Cell의 재료가 된다.

- **내레이션(EN)**
  > "Co-create is not chat. It makes things: documents, decks, images, research reports, meeting notes, and Fabric items.
  > Every result is a real file in my project. That is what makes the next step possible."

일곱 개를 한 컷씩 전부 보여준다. 하나도 빼지 않는다.

### 3.1 Office — 문서 (docx / xlsx)

- **포인트** — 진짜 파일이 나온다. 문서마다 자기 폴더를 하나씩 가지고, 워크스페이스 밖으로는 쓸 수 없다.
- **Prompt**
```
Draft a project status report as a docx: overview, progress, risks, next steps.
```
```
Turn the risks section of that document into a table and put it back.
```
```
Put the same content in an xlsx with two sheets, summary and detail.
```
- **화면** — Navigator에 `Report/Report.docx`처럼 **폴더까지 같이 생기는 것**, 작성 중인 파일에 붙는 표시.
- **내레이션(EN)** — "This is a real docx, not a preview. Each document gets its own folder, and it cannot be written outside the project."

### 3.2 Office — 덱 (배치 + 프리뷰 + 네이티브 렌더)

- **포인트** — 배치 도구 한 번이면 승인 카드도 한 장이다. 그리고 **빠른 프리뷰는 레이아웃을 보장하지 않는다**.
- **Prompt**
```
Build a five-slide pptx: cover, three KPI cards, a flowchart, a comparison table, and a recommendation.
Add it in one batch, not one slide at a time.
```
```
Make the diagram on slide 3 larger and cut the text down.
```
```
Give the cover a gradient background and an accent bar.
```
- **화면** — 승인 카드가 **한 장**만 뜨는 것 → 슬라이드마다 갱신되는 라이브 프리뷰 → 슬라이드 인덱스 클릭 → **네이티브 렌더** 버튼.
- **내레이션(EN)**
  > "One batch, one approval card. Seventeen calls would be seventeen cards.
  > The left preview is fast, but it draws 24pt text at 18pt and cuts the overflow. A broken slide can look fine there. So the real check is this — rendered by PowerPoint itself."

### 3.3 Image Creation — 인포그래픽을 만든다

- **포인트** — 생성한 이미지는 곱바로 워크스페이스에 저장되고, 어떻게 만들었는지 적힌 `.provenance.json`이 옆에 같이 남는다. 평범한 PNG라 그대로 덱이나 문서에 넣어 쓴다.
- **먼저 알아둘 것** — 여기는 대화창이 아니라 입력 폼이다. 생성 한 번은 앞의 생성을 기억하지 못한다. "아까랑 같은 스타일로" 같은 말은 통하지 않고, 프롬프트는 매번 처음부터 다 적어야 한다. 가로/세로는 프롬프트가 아니라 **Size 드롭다운**에서 고른다(`1536x1024`가 가로, `1024x1536`이 세로).
- **Prompt** (Size는 `1536x1024`, Quality는 `high`)
```
A flat vector infographic for a quarterly business review. A 2x2 grid of four panels labelled Revenue, Cost, Headcount, Risk. Each panel shows one large number and one short caption under it. Deep navy background, white text, a single orange accent colour. Clean geometric shapes, no photographs, no gradients, no logos.
```
```
A flat vector infographic showing a four step process from left to right: Collect, Compile, Review, Publish. Each step is a numbered circle with a short caption under it, joined by a thin arrow. White background, dark grey text, a single teal accent colour. No photographs, no gradients, no logos.
```
- **글자 주의** — 이미지 안의 글자는 모델이 그리는 것이라 철자가 틀어질 수 있다. 라벨은 짧게 주고 결과를 확대해 확인한 뒤 쓴다. 글자가 중요한 장표라면 배경만 이미지로 뽑고 글자는 덱에서 얹는 편이 안전하다.
- **화면** — 생성이 끝나자마자 Navigator의 `images/` 아래에 PNG와 `.provenance.json`이 같이 생기는 것 → 카드의 **i** 버튼을 눌러 배포 이름·엔드포인트·프롬프트·저장 경로가 다 적혀 있는 것.
- **이어서 (Co-create → Office 대화창)** — 방금 저장된 경로를 그대로 적어준다.
```
Put images/<file>.png on the cover slide of the deck and place the title on top of it.
```
- **내레이션(EN)** — "The image is saved to the project the moment it is made, with a file next to it that records the model, the prompt and the time. It is a normal PNG, so the deck just uses it."

### 3.4 Research (심층 조사) — 스스로 계획하고, 스스로 부족한 곳을 찾는다

- **포인트** — **계획을 먼저 승인**하고, 병렬로 모은 뒤 **매니저 라운드가 부족한 데를 스스로 짚어** 후속 질문을 만든다. 예산은 매니저가 아니라 코드가 정한다.
- **Prompt**
```
Research this topic along three separate lines and attach a source to every claim: <topic>
```
```
Keep only the claims backed by two or more sources, and list the contradictions separately.
```
```
Pick the parts of this report that are still weakly evidenced and turn them into follow-up questions.
```
- **동작 포인트** — 계획 화면에서 **질문 하나를 지우고** *Approve plan & gather*. 지운 질문은 따로 저장을 누르지 않아도 실행되지 않는다.
- **화면** — 추론 그래프(계획 → 질문 팬아웃 → 반영 → 종합). 위치는 고정이고 색은 상태만 나타낸다. 라운드 노트 목록도 같이 본다. 끝나면 워크스페이스에 `research/<topic>-<id>.md`가 남는다.
- **내레이션(EN)**
  > "I approve the plan before anything runs. I deleted one question, so that question is never asked.
  > After the first round the manager reads its own results, says what is weak, and writes follow-up questions. That is the loop. The budget is set by code, not by the manager."

### 3.5 Skill Recording — 한 번 한 일을 다음부터 재사용한다

- **포인트** — **Record → Reconstruction → Build**, 세 단계가 순서대로 서로의 게이트다. 여기엔 채팅 상자가 없다. 프롬프트로 만드는 게 아니라, 실제로 한 번 해 보이는 것이 입력이다.
- **찍을 절차** (60~90초, 비밀 없는 것으로). 링크는 공개 문서이고 로그인이 필요 없다.
  1. Edge에서 🔗 <https://learn.microsoft.com/en-us/azure/well-architected/pillars> 를 연다
  2. 다섯 기둥을 설명하는 한 문단을 복사한다
  3. 메모장으로 전환해 붙여넣고 `Owner: me` 한 줄을 더한다
  4. 프로젝트 폴더에 `waf-notes.txt`로 저장한다
  5. Edge로 돌아가 🔗 <https://learn.microsoft.com/en-us/azure/well-architected/reliability/> 를 연다

  > 단계는 **앱 전환과 URL 변경**에서 끊긴다. 제목만 바뀌는 건 같은 단계로 본다. 한 창에만 머무는 작업은 분석이 거부된다 — 의미 있는 이벤트가 3개 미만이면 재구성할 게 없다.
- **동작 포인트**
  - 녹화 카드에서 화면 캡처를 켜고 고지 동의(버전 `2026-08`)를 확인한 뒤 시작한다. 이벤트 수 · 프레임 수가 실시간으로 올라간다.
  - 3번 단계에서 앱으로 돌아와 **마커**를 남긴다: `this line is the rule: every note names an owner`. 왜 그렇게 했는지는 마커와 내레이션에만 남는다.
  - 멈추면 곧장 Reconstruction으로 넘어간다. 여기서 **Open folder**를 먼저 눌러 `events.jsonl`을 보여준다. 저게 그대로 올라간다.
  - 분석 후 단계 하나를 직접 고치고 **Approve**. 승인해야 Build가 열린다.
  - Build에서 **skill** 또는 **automation**을 고른다. 계획 화면에 녹화 때의 구체값(그 URL, 그 파일명)이 이름 붙은 상수로 올라와 있다. 거기서 `waf-notes.txt`를 `{{output_file}}` 처럼 바꿔야 다음부터 쓰이는 절차가 된다. 그냥 두면 그날 그 한 번을 반복할 뿐이다.
- **화면** — 녹화 중 상단 바(경과 시간 · 이벤트 · 프레임), `events.jsonl`이 열린 탐색기 창, 재구성된 번호 매긴 단계와 그 근거 프레임, 초안의 프론트매터(`allowed-tools`)와 본문이 따로 놀고 있는 것.
- **경계** — 녹화는 전부 이 기기 안이다. 분석은 아니다. 이 앱에서 화면 내용이 대량으로 밖에 나가는 유일한 지점이라 캡처와 별도로 동의를 받고, 서명된 M365 계정을 요구한다. 누가 승인했는지가 기록에 남아야 하기 때문이다.
- **내레이션(EN)**
  > "I did the job once, in the applications I normally use. Nothing left this machine while I recorded it.
  > Analysing does send it, so that is a separate decision — I open the folder and read the timeline first.
  > What comes back is a draft. It only becomes a skill when I approve it, and it can never widen its own permissions."

#### 3.5.1 녹화한 것을 실제로 쓰는 단계

빌드로 끝나면 데모가 절반만 끝난 것이다. 산출물은 둘 중 하나로 떨어지고, **둘 다 꺼진 상태**다. 살리는 것까지 보여줘야 한 바퀴가 끝난다.

**skill을 골랐다면** — Control Center → **Skills** → *Proposed by the assistant*

1. 제안 카드를 열어 본문과 `allowed-tools`를 소리 내 읽는다. 녹화한 작업이 파일 쓰기였으면 파일 도구만 있어야 한다. 메일이 끼어 있으면 그게 바로 거부 사유다.
2. **Approve**. 이게 모델이 쓴 내용이 프롬프트로 들어가는 유일한 경로다. 승인 전에는 스테이징 영역에만 있고 에이전트는 그게 있는지도 모른다.
3. Chat으로 돌아와 **다른 입력으로 같은 일**을 시킨다. 스킬 이름을 부를 필요는 없다. 승인된 스킬은 세션에 이미 올라있고, 꺼진 것은 이름조차 넘어가지 않는다.
```
Do the notes routine for https://learn.microsoft.com/en-us/azure/well-architected/security/ and save it as security-notes.txt.
```
4. 좀 더 밀어봐도 좋다 — §5.3 **Improve…**를 같은 스킬에 걸면 본문만 진화하고 `allowed-tools`는 그대로라는 걸 바로 보여줄 수 있다.

- **내레이션(EN)** — "I recorded it once with one page. Now I give it a different page, and it does the same job. I never had to name the skill — approving it is what put it in front of the agent."

**automation을 골랐다면** — Control Center → **Automations**

1. 잡이 **꺼진 채로** 들어와 있다. 목표 문장과 트리거(시각/주기)를 먼저 읽는다.
2. 켤 때 경고가 뜨는 걸 보여주고 켠다. 무인 실행은 **매번 새 세션**에서 돌고, 결과는 프로젝트에 파일로 남는다.
3. 실행 후 Audit에서 correlation id 하나로 녹화·분석·생성·실행이 전부 이어지는 걸 보여준다.

- **내레이션(EN)** — "It was created disabled. A procedure a model reconstructed from one afternoon should not start running on a schedule because a dialog was dismissed. I turn it on, having read what it will do."

### 3.6 Meeting Recordings — 말한 것도 재료가 된다

- **포인트** — 네이티브 사이드카가 마이크와 시스템 오디오를 같이 잡는다. 안 되는 경우에도 버튼을 숨기지 않고 이유를 붙여 비활성화로 보여준다.
- **Prompt** (녹음/전사 후)
```
Split this meeting into what was decided, what is still open, and action items with an owner.
```
```
Give me only the items I have to follow up on, as a checklist.
```
```
Save those notes as a Markdown file in the project.
```
- **화면** — 항상 보이는 녹음 바(불가할 땐 이유가 붙은 비활성), 두 소스를 모두 켰을 때 뜨는 에코 주의 문구, 워크스페이스 `meetings/`에 남는 WAV.
- **내레이션(EN)** — "Audio is captured by a native sidecar, mic and system sound. If it cannot run, the button stays visible and tells you why. The recording and the notes stay in the project."

### 3.7 Fabric (빌드) — 대화에서 이해한 것을 리소스로

- **포인트** — 도구는 세 개뿐이다(목록·생성·질의). 그리고 공식 skills-for-fabric 번들이 없으면 아예 실행을 거부한다. 남의 워크스페이스에 대고 추측하지 않기 위해서다.
- **연결** — §2.7에서 데이터를 대화로 이해했고, §2.8에서 무엇이 없는지 알았다. 여기서 만든다.
- **Prompt**
```
List the items in this project, grouped by item type.
```
```
Create a lakehouse for analytics, then list the items again so I can see what changed.
```
```
Now ask the data agent the same question again and tell me what changed in the answer.
```
- **화면** — 쓰기 승인 카드 → 실행 **전후 목록을 비교**해 무엇이 생겼는지 보여준다. 에이전트의 자기 보고가 아니다.
- **내레이션(EN)**
  > "Only three tools: list, create, ask. Create always asks. And if the official Fabric skill bundle is missing, the run is refused — the app will not guess against someone's real workspace."

### 3.8 산출물 지도 — 무엇이 어디에 남고, 어디로 흘러가나

다음 컷(§4)으로 넘어가기 전에 이 표를 한 장 띄운다. **여기가 데모의 이음매다.**

| Chat / Co-create 산출물 | 남는 곳 | IQ Cell에서 쓰이는 곳 |
|---|---|---|
| docx · xlsx · pptx | `<project>/<Name>/<Name>.docx` | 볼트 `source/`에 넣고 IQ Knowledge **Compile** |
| 생성 이미지 | `<project>/images/*.png` + `.provenance.json` | 덱·문서의 자산, 출처는 감사 로그에 |
| Research 보고서 | `<project>/research/<topic>-<id>.md` | 볼트 `source/` → IQ Knowledge |
| 회의 오디오 · 노트 | `<project>/meetings/*.wav` + 노트 Markdown | 노트를 `source/`로 → IQ Knowledge |
| Council 결론 | 워크스페이스로 내보낸 문서 | 판단의 근거 문서 |
| 대화에서 나온 규칙 | IQ Memories (pending) | 승인 → **Compile** → IQ Cell |
| 녹화한 절차 (원본) | `~/.iq-compiler/recordings/<id>/` — **프로젝트 밖이다** | 그대로는 안 쓰인다. 재구성의 재료 |
| 수행한 절차 | Skill 초안, 또는 꺼진 자동화 잡 | 승인 → 스킬 → IQ Workflow 그래프 |

- **내레이션(EN)**
  > "Everything I just made is a file or a record in one place. Now I feed it back in. That is what IQ Cell does."

---

## 4. IQ Cell

### 4.1 IQ Industry

- **포인트** — 새 도메인에 들어갈 때 필요한 **첫날치 문맥**이다. 읽기 전용이고 컴파일 버튼이 없다.
- **Prompt**
```
Summarise the structure of this primer in five sentences.
```
```
Which parts of this will change most in the next two years?
```
```
List the terms in this industry that are most often confused internally.
```
- **화면** — 다섯 개 프라이머, 본문 안의 mermaid 다이어그램이 그려지는 것, 그리고 이것들이 IQ Cell 라이브러리에 **IQ Industry 출처**로 들어와 있는 것.

### 4.2 IQ Knowledge — LLM Wiki를 제품으로

- **포인트** — 일반 지식이 아니라 **내 문서**에서 답한다. 그리고 읽기 전에 무엇을 읽을지를 먼저 보여준다.
- **계보** — Karpathy의 **LLM Wiki** 아이디어를 구현한 것이다. 내 문서를 서로 링크된 위키로 만들고, 모델은 훈련 기억이 아니라 그 위키를 읽는다.
- **달라진 점** — ① 읽기 **전에** 소스 목록을 보여준다 ② 모든 주장에 **노트 경로**를 붙인다 ③ 결과가 **IQ Cell로 컴파일**돼 다음 작업에서 재사용된다 ④ 원본(`source/`)과 생성된 노트를 분리해 같은 내용이 두 번 세어지지 않게 한다.
- **여기서 §3의 산출물이 재료가 된다** — Co-create가 만든 보고서·회의 노트·문서를 볼트의 `source/` 폴더에 넣고 Compile하면 그것들이 위키의 노드가 된다. 데모에서는 §3.4의 Research 보고서 한 개를 넣고 컴파일한다.
- **내레이션(EN)**
  > "This is the LLM wiki idea, built as a product. My documents become a linked wiki, and the model reads that instead of guessing.
  > Two things are mine, not the model's: I see the source list before anything is read, and every point cites a note path.
  > And the report I just wrote in Co-create is one of these sources now."
- **동작** — *Load samples* 또는 볼트 선택 → (§3의 산출물을 `source/`에 넣고) 소스 목록 확인 → **Compile**(소스 읽기 → 그래프 생성 → 셀 컴파일 → 게시).
- **Prompt**
```
Which five notes in this vault are cited most, and why?
```
```
Are there any notes that nothing links to and that link to nothing?
```
```
What does this vault say about <topic>? Cite the note path for every point.
```
```
Find any pair of notes that contradict each other.
```
- **화면** — 노드에 마우스를 올리면 이웃만 남는 아이솔레이션, 우측 **Files** 패널(폴더별 원본), 컴파일 결과가 라이브러리에 한 장으로 게시되는 순간.

### 4.3 IQ Memories

- **포인트** — 에이전트는 규칙을 **제안**만 한다. 승인해야 효력이 생기고, **한 글자라도 고치면 승인이 취소된다.**
- **Prompt**
```
Using only approved memories, list the rules I have to follow when I write a document.
Do not use anything that is still pending.
```
```
If anything in this conversation should hold from now on, propose it as a memory.
```
```
Do any of the approved memories conflict with each other?
```
- **화면** — 대기 2 / 승인 6 / 거부 2, 메모리 타입 필(**factual · procedural · episodic**), 거부된 *episodic* 항목("한 번 일어난 일을 규칙으로 굳히지 않는다"), 승인 항목을 한 글자 고치면 배지가 `approved → pending`으로 되돌아가는 순간.

### 4.4 IQ Workflow (IQ Cell 에디터)

- **포인트** — 절차가 문장이 아니라 **검증 가능한 그래프**다.
- **동작** — 라이브러리에서 셀을 하나 열고 → 노드의 데이터 입력 연결을 끊는다 → **진단이 즉시 뜨고** → 되돌린 뒤 Compile로 v2를 게시한다.
- **Prompt**
```
Check whether any step in this workflow has an input that is not connected.
```
```
If I had to explain this procedure to a person, in what order should I say it?
```
- **화면** — 진단 목록(error / warning / info 구분), 저장된 초안 목록, 컴파일하면 버전이 올라가는 것.

### 4.5 IQ Cell 라이브러리

- **포인트** — 다섯 가지 출처(에디터 / IQ Knowledge / IQ Memories / IQ Industry / Connectome)로 컴파일된 셀이 **한 목록**에 모여 있고, **행을 누르면 자기를 만든 화면으로 돌아간다.**
- **화면** — 출처 필터를 All → 각 출처로 바꿔가며 행을 눌러 원래 화면으로 점프. 초안이 없는 행은 "Compiled in X — no editor draft"라고 정확히 말해준다.
- **Prompt 없음** (UI 컷)

### 4.6 My IQ

- **포인트** — 쌓인 절차가 **실제로 쓰이고 있는지**를 처음으로 볼 수 있다. 시간축 재생은 최근 45일 동안 일이 흘러간 경로만 밝혀준다.
- **Prompt** (Connectome 옆 채팅 — 모델이 아니라 분석 결과만으로 답한다)
```
Which three IQ Cells are used most, and how are they connected to each other?
```
```
Which cells have not been used once in the last 45 days?
```
```
Which cell is the hub — connected to the largest number of others?
```
- **화면** — 실행 버튼 → 진행률 % → 타임랩스 자동 재생 → *Back to the opening view* → Details 컬럼 → **Publish**(샘플 데이터 한정 MCP 서버로 게시).

---

## 5. Control Center

### 5.1 Automations (예약 실행)

- **포인트** — 샘플 자동화는 전부 꺼진 채로 오고 읽기 전용 도구만 쓴다. 샘플을 불러왔다는 이유로 일이 시작되면 안 되니까.
- **Prompt** (잡 생성)
```
Every weekday at 08:00, summarise yesterday's mail and leave it in the project as Markdown.
```
```
Every Friday, list the documents created this week.
```
- **화면** — 샘플 잡이 전부 비활성인 것, 하나를 켜면 뜨는 경고, 무인 실행이 **매번 새 세션**에서 도는 것.

### 5.2 Delegated plans (위임 계획)

- **포인트** — 위임에는 **한계가 있다**. 최대 `external`까지고 `destructive`는 아예 표현할 수도 없다. 즉 위임 작업은 셀 명령까지 가지 못한다.
- **화면** — Research가 만든 DAG, 노드별 상태와 재시도 횟수, 중단된 계획이 재시작 시 `ready`로 회수되는 것.
- **내레이션** — "아무도 보고 있지 않은 턴은 기다리지 않습니다. 거부하고, 무엇이 필요했는지 말합니다."
- **Prompt 없음** (UI 컷)

### 5.3 Skills · Improve (자기 진화)

- **포인트** — 스킬이 스스로 좋아질 수는 있어도 **스스로 권한을 넓힐 수는 없다**. 본문만 진화하고 프론트매터는 고정이다.
- **화면** — 스킬 목록과 각 스킬의 `allowed-tools` → **Improve…** → (미리 돌려둔) 결과: baseline 점수 → 채택된 점수, 심사된 후보 수, 베이스라인을 못 이기면 **원본을 유지**하는 것.
- **내레이션** — "약 30분 걸립니다. 툴팁에 그렇게 적혀 있습니다." (실시간 촬영 금지)
- **Prompt 없음** (UI 컷)

### 5.4 MCP

- **포인트** — 목록에 있다는 게 권한을 준다는 뜻은 아니다. 서버는 **비활성 + 승인된 도구 0개**로 등록된다.
- **화면** — 카탈로그에서 추가 → **Inspect** → 도구 목록 → 필요한 도구만 체크 → Enable. 인증이 필요한 서버는 401을 그대로 뱉지 않고 **리소스·스코프·발급자·클라이언트를 파싱해서** 알려준다.
- **Prompt**
```
Use the MCP tool I just approved to look up <target>.
```
- **캡션** — "권한이 없으면, 왜 없는지까지 말해준다."

### 5.5 Audit

- **포인트** — §1.5 참조. 한 실행이 correlation id 하나로 묶인다.
- **화면** — 필터(correlation id / 도구 패밀리 / 워크스페이스), 네 가지 결과, Export.

### 5.6 Sample data

- **포인트** — 데모를 켜보는 일이 내 데이터를 되돌릴 수 없게 바꿔버리면 안 된다.
- **화면** — 모듈 5개(IQ Memories / IQ Knowledge / IQ Cell 라이브러리 & Connectome / Automations / Delegated plans) → Load / Clear.
- **내레이션** — "스위치를 끄는 건 아무것도 지우지 않습니다. 지우는 건 Clear뿐이고, Clear는 스위치 상태와 무관하게 항상 쓸 수 있습니다."

### 5.7 Connections & access

- **포인트** — 어느 것도 키를 저장하지 않는다. 전부 Entra 신원이다.
- **화면** — 모델 레지스트리(역할별 기본값: reasoning / research / image), Speech 등록 + Test connection, Fabric 워크스페이스와 Data Agent가 **따로 등록되는 것**, 테넌트 전환.
- **Prompt 없음** (UI 컷)

### 5.8 Projects + Navigator

- **포인트** — 워크스페이스는 디렉터리와 거기 묶인 세션·산출물·스킬·지식·기억이다. **제거해도 파일은 지우지 않는다.**
- **화면** — 파일 트리가 **파일시스템을 따라 자동 갱신**되는 것, 우클릭 메뉴(Add File to Chat / Reveal in File Explorer).
- **Prompt 없음** (UI 컷)

---

## 6. 연결해서 보여주는 컷 (기능 체인)

업종 스토리 없이, 기능이 서로 물리는 것만 보여준다. 각 60~120초.
**체인 A가 이 데모의 본론이다.** Chat / Co-create의 산출물이 IQ Cell의 재료가 되는 과정이다.

### 체인 A — 만든 것이 다음 일의 재료가 된다 (필수 컷)

`Co-create → Research`(보고서 `.md` 생성) → 그 파일을 볼트 `source/`로 → `IQ Knowledge` **Compile** → `IQ Cell library`에 셀 게시 → `IQ Workflow`에서 열어 진단 → 그 셀로 `Office` 문서 생성 → `Audit`에서 한 줄기로 조회

```
Research this topic along three separate lines and attach a source to every claim: <topic>
```
```
What does this vault say about <topic>? Cite the note path for every point.
```
```
Turn what you just wrote into a draft docx report.
```

- **내레이션(EN)**
  > "Nothing here was typed twice. The research report became a note. The notes became a graph. The graph became an IQ Cell. The cell wrote the document.
  > And the whole thing is one line in the audit log."

### 체인 B — 규칙이 만들어지고 지켜지기까지

`Chat`에서 규칙 제안(§2.9) → `IQ Memories` 승인 → Compile → `Office` 문서를 만들 때 그 규칙이 지켜지는지 확인 → 규칙 하나를 수정 → 승인이 취소되는 것

```
If anything in this conversation should hold from now on, propose it as a memory.
```
```
Using only approved memories, list the rules for writing a document here.
```
```
Now draft that document following those rules. Leave out anything that breaks one.
```

- **내레이션(EN)** — "The rule came out of a conversation. It did nothing until I approved it. I edit one word, and the approval is gone."

### 체인 C — 데이터를 이해하고, 없는 것을 만든다

`Chat → Data agent`로 질문하고 트레이스 확인 → "무엇이 없는가" → `Co-create → Fabric`에서 생성(승인 1회) → 전후 목록 비교 → 같은 질문을 다시

```
Show the trend over the last four quarters by month, and point out any month that is an outlier.
```
```
What would you need that this data does not have?
```
```
Create a lakehouse for analytics, then list the items again so I can see what changed.
```

- **내레이션(EN)** — "Chat is not only asking. It understood my data, said what was missing, and built it — with one approval and a before-and-after list."

### 체인 D — 조사에서 판단까지

`Research`(계획 승인 → 수집 → 반영 라운드 → 보고서) → `Team`으로 같은 주제 판단 → `Delegated plans`에서 그 실행의 DAG 확인

```
Research this topic along three separate lines and attach a source to every claim: <topic>
```
```
Using that research as the evidence, argue which option to take from three positions and give me a verdict.
```

- **내레이션(EN)** — "Evidence first, then judgement. Both are recorded. The plan that ran it is a graph I can open."

---

## 7. 녹화 운영 노트

### 7.1 전체 투어 자동화 — `tour.mjs`

이 문서의 챕터를 **샘플 데이터로 자동 재생**하는 스크립트다. 인증과 승인만 사람에게 맡기고, 나머지 조작(모드 전환·서피스 이동·샘플 로드·Compile·Connectome 실행·필터 순회·프롬프트 전송)은 전부 대신한다.

```powershell
cd iq-compiler
pnpm build                                              # 한 번

node sample-data/demo-automation/tour.mjs --list        # 챕터 목록
node sample-data/demo-automation/tour.mjs               # 전체 23챕터
node sample-data/demo-automation/tour.mjs --only=knowledge,memories,connectome
node sample-data/demo-automation/tour.mjs --skip=fabric,dataagent --record
node sample-data/demo-automation/tour.mjs --only=chat --dry    # 입력만 하고 보내지 않기
node sample-data/demo-automation/tour.mjs --speed=0.5   # 모든 홀드를 절반으로
```

스크립트가 지키는 규칙 네 가지:

1. **인증은 절대 하지 않는다.** 앱을 띄우고 레일이 나타날 때까지 기다렸다가 스스로 시작한다. 토큰·자격증명을 읽지도 쓰지도 넘기지도 않는다.
2. **프롬프트를 실제로 보내고 답이 다 나올 때까지 기다린다.** 입력만 해놓으면 질문하는 그림이지 제품이 아니다. 보내고, 턴이 끝난 다음에 홀드가 시작된다. 실제 시간과 토큰을 쓰고 테이크마다 답이 달라진다. 그게 싫으면 `--dry`를 쓴다. **승인 카드는 여전히 사람 몴이다** — 카드가 뜨면 스크립트는 누르지 않고 콘솔에 그렇게 적고 3분까지 기다린다.
3. **자기가 켜준 샘플 모듈만 되돌린다.** `finally`에서 purge하므로 중간에 실패해도 정리된다. "Show sample data" 스위치도 처음 상태로 되돌린다.
4. **대화는 지우지 않는다.** 컴포저가 필요한 챕터는 대화를 만들지만, 어느 행이 "우리 것"인지 판단해서 지우는 순간 진짜 이력을 날릴 수 있다. 몇 개 만들었는지만 보고하고 삭제는 사람에게 맡긴다.

**§6 체인 A는 스크립트가 대신 찍어주지 않는다.** 파일을 볼트 `source/`로 옮기는 단계가 파일시스템 조작이고, 스크립트는 사용자의 볼트를 건드리지 않기 때문이다. 이 컷은 손으로 찍는다. `--only=research`로 보고서를 만들고, 파일을 옮기고, `--only=knowledge`로 이어 붙인다.

챕터는 서로 독립적이다. `--only=<id>`를 주면 그 챕터만 처음부터 잡히므로, §2의 B-roll을 한 클립씩 찍고 잘못된 것만 다시 찍으면 된다. 화면에 없거나 비활성인 컨트롤(미등록 Fabric·Speech·이미지 배포)은 실패로 보지 않고 **이유와 함께 로그로 남기고 건너뛴다**. 하나 없다고 나머지 22챕터를 통째로 날리는 게 제일 나쁜 선택이라서다.

`--with-knowledge`는 기본 꺼짐이다. 지식 볼트 샘플을 로드하면 볼트 디렉터리를 **재지정**해버리고, 나중에 Clear해도 원래 보던 볼트로 돌아가지 않고 아무것도 선택되지 않은 상태가 된다. 다른 모듈은 전부 더하기만 하고 되돌릴 수 있는데 이것 하나만 그렇지 않아서, 빼는 옵션이 아니라 넣는 옵션으로 됐다.

자막 바는 앱을 최대한 가리지 않게 만들었다. 높이 약 76px 고정, 반투명 + 블러라 뒤가 비칠 보이고, 제목·본문·프롬프트가 각각 한 줄로 잘려 길어져도 바가 커지지 않는다. 문구는 전부 쉬운 직설 영어다(루트 `AGENTS.md` → *Write plainly*).

### 7.2 실패 대비

| 이럴 때 | 이렇게 말하고 넘어간다 |
|---|---|
| 턴이 오래 걸림 | "실제 모델 호출입니다." — 그동안 Activity 블록을 설명한다 |
| 도구 실패 | 그대로 보여준다. 감사 로그에 `failed`로 남는 걸 보여주면 오히려 강한 컷이 된다 |
| 승인 카드가 여러 개 | "Allow for this conversation"으로 큐가 한 번에 정리되는 걸 보여준다 |
| MCP 서버가 안 뜸 | Inspect 실패 메시지가 **원인을 지목한다**는 컷으로 전환 |
| Fabric 403 | "대개 권한이 아니라 용량이 일시정지된 겁니다" — 화면 문구를 읽는다 |
| Research가 멈춘 듯 보임 | 그래프에서 상태가 갱신되는 노드를 짚는다. 앱이 죽은 거라면 재실행 시 계획이 자동 회수된다 |

### 7.3 심사위원 예상 질문

- **"그냥 Copilot 아닌가요?"** → 런타임은 Copilot SDK가 맞습니다. 더한 것은 **거버넌스 체인**입니다: 검증 → 정책 → 승인 → 감사 → 실행 → 감사. 그 체인이 우리 도구뿐 아니라 SDK 내장 도구와 MCP 서버에도 똑같이 적용됩니다.
- **"Chat은 다른 챗봇과 뭐가 다른가요?"** → "Chat here produces files and records. A deck, a report, a rule, a Fabric item. Those become the input for an IQ Cell. A chatbot ends at the answer."
- **"Team은 뭔가요?"** → "It is the LLM Council idea as a product. Several positions answer, read each other, and a verdict closes it. You choose the positions, every round is kept, and the verdict is a file."
- **"IQ Knowledge는 RAG 아닌가요?"** → "It is the LLM wiki idea. Your documents become a linked wiki. You see the source list before anything is read, every point cites a note path, and the result compiles into an IQ Cell you can reuse."
- **"이 앱을 한 줄로?"** → "Prompt, context, harness, loop, graph — in one app, under one approval and one audit trail."
- **"자율 에이전트인가요?"** → 아니요. 전역 우회 스위치가 없습니다. `external`과 `destructive`는 기억되지 않고 매번 다시 묻습니다.
- **"데이터가 어디로 갑니까?"** → 설정·로그·데이터는 전부 로컬(`IQ_HOME`)입니다. 토큰은 특권 프로세스 밖으로 나가지 않고 IPC로도 건너가지 않습니다.
- **"조직 배포는요?"** → 관리형 정책 파일이 사용자 설정보다 위에 있습니다. 정책이 깨져 있으면 조용히 낮추지 않고 하드 실패합니다.

---

## 8. 부록 — Prompts (복사용)

```
List the five most recently modified files in this project.
Summarise that list and email it to me.
Build a six-slide overview deck. Give every slide a title and a body.
Explain in three sentences what this application is for.
Now put that answer in a table.
Pull the three main claims out of the file I just attached.
Summarise the mail I received in the last three days as sender, time received, and the one thing being asked of me.
Find me three slots of thirty minutes or more that are free this week.
List next week's meetings with their attendees, grouped by meeting.
Find the people and documents related to what I have been working on recently.
Who are the five people I have collaborated with most over the last two weeks?
Open this page in the browser pane so I can watch, then read it from the pane and quote three sentences verbatim: <URL>
Open this second page in the same pane and tell me where its claims disagree with the first: <URL2>
Scroll down in the pane and read the rest of the page.
We have to decide whether a feature ships in this release or waits for the next one. Argue it from three positions — product, engineering, operations — and give me a verdict after two rounds.
Build it in house or buy the SaaS? Argue it from finance, security, and developer productivity.
Attack this decision from the strongest opposing position you can construct.
Break down the most recent quarter by category.
Show the trend over the last four quarters by month, and point out any month that is an outlier.
Show me the actual queries you ran to produce that answer.
What would you need that this data does not have?
Draft a project status report as a docx: overview, progress, risks, next steps.
Turn the risks section of that document into a table and put it back.
Put the same content in an xlsx with two sheets, summary and detail.
Build a five-slide pptx: cover, three KPI cards, a flowchart, a comparison table, and a recommendation. Add it in one batch, not one slide at a time.
Make the diagram on slide 3 larger and cut the text down.
Give the cover a gradient background and an accent bar.
A flat vector infographic for a quarterly business review. A 2x2 grid of four panels labelled Revenue, Cost, Headcount, Risk. Each panel shows one large number and one short caption under it. Deep navy background, white text, a single orange accent colour. Clean geometric shapes, no photographs, no gradients, no logos.
A flat vector infographic showing a four step process from left to right: Collect, Compile, Review, Publish. Each step is a numbered circle with a short caption under it, joined by a thin arrow. White background, dark grey text, a single teal accent colour. No photographs, no gradients, no logos.
Put images/<file>.png on the cover slide of the deck and place the title on top of it.
Research this topic along three separate lines and attach a source to every claim: <topic>
Keep only the claims backed by two or more sources, and list the contradictions separately.
Pick the parts of this report that are still weakly evidenced and turn them into follow-up questions.
Do the notes routine for https://learn.microsoft.com/en-us/azure/well-architected/security/ and save it as security-notes.txt.
Split this meeting into what was decided, what is still open, and action items with an owner.
Save those notes as a Markdown file in the project.
List the items in this project, grouped by item type.
Create a lakehouse for analytics, then list the items again so I can see what changed.
Now ask the data agent the same question again and tell me what changed in the answer.
Summarise the structure of this primer in five sentences.
Which five notes in this vault are cited most, and why?
Are there any notes that nothing links to and that link to nothing?
What does this vault say about <topic>? Cite the note path for every point.
Find any pair of notes that contradict each other.
Using only approved memories, list the rules I have to follow when I write a document. Do not use anything that is still pending.
If anything in this conversation should hold from now on, propose it as a memory.
Now draft that document following those rules. Leave out anything that breaks one.
Check whether any step in this workflow has an input that is not connected.
Which three IQ Cells are used most, and how are they connected to each other?
Which cells have not been used once in the last 45 days?
Every weekday at 08:00, summarise yesterday's mail and leave it in the project as Markdown.
Every Friday, list the documents created this week.
```
