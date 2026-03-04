# 2026 Portfolio Dashboard

Google Sheets 기반 실시간 투자 포트폴리오 대시보드 (PWA).

## 구조

```
├── index.html              ← 메인 대시보드 (HTML only)
├── stock.html              ← 종목 상세 페이지 (HTML only)
├── css/
│   └── style.css           ← 통합 스타일시트
├── js/
│   ├── config.js           ← 상수/설정 (SID, API 키, 탭 정의 등)
│   ├── utils.js            ← 공용 헬퍼 (포맷팅, 셀 접근, 색상)
│   ├── treemap.js          ← Squarified 트리맵 알고리즘
│   ├── app.js              ← 메인 앱 (JSONP, 파싱, 탭, 렌더러)
│   ├── risk-sentinel.js    ← Risk Sentinel 엔진 v2 (기술적 지표 분석)
│   └── stock-detail.js     ← stock.html 전용 로직
├── manifest.json           ← PWA 매니페스트
├── sw.js                   ← 서비스 워커 (오프라인 캐시)
├── Code.gs                 ← Google Apps Script (RSI, Bollinger Band)
└── CacheUpdater.gs         ← GAS 캐시 업데이터 (Yahoo + FMP)
```

## 데이터 흐름

1. **CacheUpdater.gs** (GAS 트리거, 10분 간격) → Yahoo Finance / FMP API에서 데이터 수집 → Google Sheets 캐시 시트에 저장
2. **index.html** → JSONP로 Google Sheets에서 데이터 로드 → 탭별 렌더링
3. **Risk Sentinel** → Finnhub / Yahoo에서 실시간 시세 → IndexedDB 캐시 → 기술적 지표 분석 (RSI, BB, SMA)

## 탭 구성

| 탭 | 내용 |
|---|---|
| 전체 개요 | 자산 배분 트리맵, 포트폴리오 수익률, 환율 |
| 지수형 | 인덱스 ETF 포트폴리오 상세 |
| 배당 | 배당 포트폴리오 상세 |
| 성장 | 성장주 포트폴리오 상세 |
| 국내 | 국내 주식 포트폴리오 |
| 미장 Risk | 미국 시장 리스크 모니터링 |
| 국장 Risk | 국내 시장 리스크 모니터링 |

## 사용법

1. Google Sheets에 포트폴리오 데이터 입력
2. GAS에서 `CacheUpdater.gs`의 `setupTrigger()` 실행
3. `index.html`을 웹 서버나 GitHub Pages로 호스팅
