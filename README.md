# Math Sidecar PWA v0.1.0

Android Chrome에서 사용할 수 있도록 만든 Math Sidecar의 PWA 버전입니다. OpenAI/Anthropic API를 사용하지 않습니다.

## 핵심 동작

- ChatGPT/Claude에서 Math Sidecar 블록을 선택한 뒤 Android의 **공유 → Math Sidecar**로 보내면 새 카드로 추가됩니다.
- 새 답변이 추가되면 기존 카드는 모두 접히고 새 카드만 열립니다.
- 카드 헤더는 읽는 동안 위에 sticky로 남고, 누르면 접기/펼치기가 됩니다.
- 접힌 카드는 MathJax SVG를 DOM에서 제거하고, 다시 펼칠 때 재렌더링합니다.
- 인라인 수식 `\(...\)` / `$...$`, 독립식 `\[...\]` / `$$...$$`, 일부 bare TeX 환경을 지원합니다.
- `TeX 복사`, 선택한 부분의 `질문 복사`, `최신`, `모두 접기`, 클립보드 `붙여넣기`, 수동 `가져오기`를 지원합니다.
- `시작` 버튼은 Math Sidecar용 시작 프롬프트를 클립보드에 복사합니다. PWA는 Chrome의 다른 탭 DOM에 직접 입력할 권한이 없기 때문에 PC 확장처럼 자동 주입하지는 않습니다.
- 공유 때 원본 URL이 함께 넘어오면 카드의 `대화` 버튼으로 원본 주소를 열 수 있습니다.
- 카드와 접힘 상태는 IndexedDB에 저장되어 앱을 닫았다 열어도 유지됩니다.
- 앱 셸과 MathJax는 서비스 워커로 캐시되어 설치 후 오프라인에서도 Sidecar 자체는 열 수 있습니다.

## Android Chrome에서 설치하려면

PWA와 Web Share Target은 **HTTPS 주소**에서 제공되어야 합니다. ZIP을 휴대폰에 풀어 `file://`로 여는 것만으로는 설치/공유 대상 등록이 되지 않습니다.

가장 간단한 배포 방법 중 하나는 GitHub Pages입니다.

1. 이 폴더의 내용 전체를 GitHub 저장소에 올립니다.
2. GitHub 저장소의 **Settings → Pages**에서 해당 브랜치의 루트(`/`)를 배포합니다.
3. 생성된 `https://...github.io/.../` 주소를 Android Chrome에서 엽니다.
4. Chrome 메뉴에서 **앱 설치** 또는 **홈 화면에 추가**를 선택합니다.
5. 설치 후 ChatGPT/Claude에서 Math Sidecar 코드 블록을 선택하고 Android 공유 메뉴를 엽니다.
6. 공유 대상에서 **Math Sidecar**를 선택합니다.

## 직접 테스트

PC에서는 폴더에서 다음 명령으로 로컬 테스트가 가능합니다.

```bash
python -m http.server 8000
```

그 뒤 `http://localhost:8000/`을 엽니다. localhost는 서비스 워커 테스트가 허용됩니다.

## PC 확장과 다른 점

PC 확장(v0.4.1)은 ChatGPT/Claude 페이지의 DOM을 직접 읽을 수 있으므로 완전 자동 연동이 가능합니다. Android Chrome은 일반 확장 프로그램을 지원하지 않으므로 PWA는 다음 동작을 수동으로 합니다.

- 새 답변 전달: Android `공유 → Math Sidecar`
- 시작 프롬프트: `시작` → 복사 → 채팅 탭에 붙여넣기
- 선택 질문: `질문 복사` → 채팅 탭에 붙여넣기

Sidecar 내부의 렌더링, 카드, 접기, sticky 헤더, MathJax 언로드/재렌더링 방식은 PC 버전과 최대한 같게 유지했습니다.
