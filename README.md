# 🎨 DrawMafia

그림으로 숨어있는 마피아를 찾는 실시간 멀티플레이어 게임.

모두 같은 단어를 받지만, 마피아 1명만 다른 단어를 받습니다. 한 획씩 번갈아 그리고, 누가 마피아인지 투표로 찾아냅니다.

## 기능

- 실시간 멀티플레이어 (Socket.io)
- 방 코드로 입장 (Firebase로 방 정보 영구 저장)
- 1인당 3획씩 그리면 자동 투표
- 방장 조기 투표 기능
- 실시간 채팅
- 동률 시 마피아 승리

## 로컬 실행

```bash
npm install
node server.js
```

`http://localhost:3000` 접속.

## 환경 설정

Firebase 연동을 위해 둘 중 하나가 필요합니다:

**로컬:** 프로젝트 루트에 `firebase-key.json` 파일 배치 (Firebase 콘솔 → 서비스 계정 → 새 비공개 키 생성)

**배포 (Render 등):** 환경변수 설정
- `FIREBASE_SERVICE_ACCOUNT`: 서비스 계정 키 JSON 전체 내용
- `FIREBASE_DATABASE_URL`: Realtime Database URL

> ⚠️ `firebase-key.json` 은 절대 git에 커밋하지 마세요. `.gitignore` 에 포함되어 있습니다.

## 기술 스택

- Node.js + Express
- Socket.io (실시간 통신)
- Firebase Realtime Database (방 정보 저장)
- HTML/CSS/JS (프론트엔드)
