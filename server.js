const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// UTIC API 설정
const UTIC_API_KEY = 'spdYlAuDpMu815Bqun6bM4xMjg7gBtVChlcFWMEUGqDvbRRDx9OSu8n2gXlrj3';
const UTIC_HEADERS = {
  'Referer': 'https://www.utic.go.kr/guide/cctvOpenData.do',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// =============================================================================
// cctvStream.js와 동일한 KIND 결정 로직
// =============================================================================
function getCctvKind(cctvData) {
  const cctvId = cctvData.CCTVID;
  
  // cctvStream.js 45-58번째 줄 로직 그대로 구현
  if (cctvId.substring(0, 3) === 'L01') {
    return 'Seoul';
  } else if (cctvId.substring(0, 3) === 'L02') {
    return 'N';
  } else if (cctvId.substring(0, 3) === 'L03') {
    return 'O';
  } else if (cctvId.substring(0, 3) === 'L04') {
    return 'P';
  } else if (cctvId.substring(0, 3) === 'L08') {
    return 'd';
  } else if (cctvId.startsWith('E44')) {
    // ⭐ E44 경산 CCTV 추가 (UTIC API는 GG로 반환하지만 WebView에서 정상 작동)
    return cctvData.KIND; // 'GG' 그대로 사용
  } else {
    // API에서 받은 KIND 그대로 사용
    return cctvData.KIND;
  }
}

// =============================================================================
// 메인 API: CCTV 메타데이터 + 비디오 URL
// =============================================================================
app.get('/api/cctv/:cctvId', async (req, res) => {
  try {
    const { cctvId } = req.params;
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📡 메타데이터 요청: ${cctvId}`);
    console.log(`${'='.repeat(80)}`);
    
    const metadataUrl = `http://www.utic.go.kr/map/getCctvInfoById.do?cctvId=${cctvId}&key=${UTIC_API_KEY}`;
    
    console.log(`\n📤 [UTIC API 요청]`);
    console.log(`   URL: ${metadataUrl}`);
    console.log(`   Headers:`, JSON.stringify(UTIC_HEADERS, null, 2));
    
    const response = await axios.get(metadataUrl, {
      headers: UTIC_HEADERS,
      timeout: 15000,
      httpsAgent: httpsAgent
    });
    
    console.log(`\n📥 [UTIC API 응답 - 원본]`);
    console.log(`   Status: ${response.status} ${response.statusText}`);
    console.log(`   Content-Type: ${response.headers['content-type']}`);
    console.log(`   Raw Data:`, typeof response.data === 'string' ? response.data : JSON.stringify(response.data));
    
    const cctvData = response.data;
    
    console.log(`\n📥 [UTIC API 응답 - 파싱됨]`);
    console.log(`   Data Type: ${typeof cctvData}`);
    console.log(`   Parsed Data:`, JSON.stringify(cctvData, null, 2));
    
    if (cctvData.msg && cctvData.code === '9999') {
      return res.status(403).json({
        success: false,
        error: '비정상적인 접근',
        cctvId: cctvId
      });
    }
    
    // ⭐ cctvStream.js와 동일한 KIND 결정
    const kind = getCctvKind(cctvData);
    
    console.log(`\n🔄 [KIND 결정]`);
    console.log(`   CCTVID: ${cctvData.CCTVID}`);
    console.log(`   원본 KIND: ${cctvData.KIND}`);
    console.log(`   보정 KIND: ${kind}`);
    console.log(`   적용 규칙: ${getKindRule(cctvData.CCTVID)}`);
    
    const streamPageUrl = buildStreamPageUrl(cctvData, kind);
    
    console.log(`\n🌐 [WebView URL 생성]`);
    console.log(`   URL: ${streamPageUrl}`);
    console.log(`   Parameters:`);
    console.log(`     - cctvid: ${cctvData.CCTVID}`);
    console.log(`     - cctvName: ${cctvData.CCTVNAME}`);
    console.log(`     - kind: ${kind}`);
    console.log(`     - cctvip: ${cctvData.CCTVIP || 'undefined'}`);
    console.log(`     - id: ${cctvData.ID || 'undefined'}`);
    console.log(`     - cctvch: ${cctvData.CH || 'undefined'}`);
    console.log(`     - cctvport: ${cctvData.PORT || 'undefined'}`);
    console.log(`     - cctvpasswd: ${cctvData.PASSWD || 'undefined'}`);
    
    console.log(`\n✅ 메타데이터: ${cctvData.CCTVNAME} (센터: ${cctvData.CENTERNAME})`);
    console.log(`   위치: (${cctvData.YCOORD}, ${cctvData.XCOORD})`);
    console.log(`   재생 방식: WebView (UTIC 공식)`);
    
    // ⭐ 모든 CCTV를 WebView로 처리 (UTIC 공식 방식)
    const playerType = 'webview';
    const directVideoUrl = null;
    
    console.log(`\n📤 [클라이언트 응답]`);
    console.log(`   CCTV: ${cctvData.CCTVNAME} (${cctvId})`);
    console.log(`   KIND: ${kind}`);
    console.log(`   PlayerType: ${playerType}`);
    console.log(`${'='.repeat(80)}\n`);
    
    res.json({
      success: true,
      cctvId: cctvId,
      name: cctvData.CCTVNAME,
      center: cctvData.CENTERNAME,
      location: {
        lat: cctvData.YCOORD,
        lng: cctvData.XCOORD
      },
      streamPageUrl: streamPageUrl,
      kind: kind, // ⭐ 보정된 KIND 반환
      directVideoUrl: directVideoUrl,
      playerType: playerType
    });
    
  } catch (error) {
    console.error(`\n❌ [오류 발생]`);
    console.error(`   CCTV ID: ${req.params.cctvId}`);
    console.error(`   에러: ${error.message}`);
    console.error(`   스택:`, error.stack);
    console.error(`${'='.repeat(80)}\n`);
    
    res.status(500).json({
      success: false,
      error: error.message,
      cctvId: req.params.cctvId
    });
  }
});

// =============================================================================
// HELPER 함수들
// =============================================================================

// KIND 결정 규칙 설명 (디버깅용)
function getKindRule(cctvId) {
  if (cctvId.substring(0, 3) === 'L01') {
    return 'L01XXX → Seoul';
  } else if (cctvId.substring(0, 3) === 'L02') {
    return 'L02XXX → N (인천)';
  } else if (cctvId.substring(0, 3) === 'L03') {
    return 'L03XXX → O (부천)';
  } else if (cctvId.substring(0, 3) === 'L04') {
    return 'L04XXX → P (광명)';
  } else if (cctvId.substring(0, 3) === 'L08') {
    return 'L08XXX → d (용인)';
  } else if (cctvId.startsWith('E44')) {
    return 'E44XXX → GG (경산, API KIND 유지)';
  } else {
    return 'API KIND 그대로 사용';
  }
}

// 스트림 페이지 URL 생성
function buildStreamPageUrl(cctvData, kind) {
  const baseUrl = 'https://www.utic.go.kr/jsp/map/openDataCctvStream.jsp';
  const params = new URLSearchParams();
  
  params.append('key', UTIC_API_KEY);
  params.append('cctvid', cctvData.CCTVID);
  
  if (cctvData.CCTVNAME) params.append('cctvName', cctvData.CCTVNAME);
  
  // ⭐ 보정된 KIND 사용
  params.append('kind', kind);
  
  if (cctvData.CCTVIP) params.append('cctvip', cctvData.CCTVIP);
  if (cctvData.ID) params.append('id', cctvData.ID);
  if (cctvData.PASSWD) params.append('cctvpasswd', cctvData.PASSWD);
  if (cctvData.CH && cctvData.CH !== 'undefined') params.append('cctvch', cctvData.CH);
  if (cctvData.PORT && cctvData.PORT !== 'undefined') params.append('cctvport', cctvData.PORT);
  
  return `${baseUrl}?${params.toString()}`;
}

// =============================================================================
// CORS 우회 프록시 (ERR_BLOCKED_BY_ORB 대응)
// =============================================================================
app.get('/proxy/direct', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    
    if (!videoUrl) {
      return res.status(400).json({ error: 'URL 파라미터 필요' });
    }
    
    console.log(`📺 CORS 프록시: ${videoUrl}`);
    
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': UTIC_HEADERS['User-Agent'],
        'Referer': 'https://www.utic.go.kr/'
      },
      responseType: 'stream',
      httpsAgent: httpsAgent,
      timeout: 60000
    });
    
    // CORS 헤더
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    const contentType = response.headers['content-type'] || 'application/vnd.apple.mpegurl';
    res.setHeader('Content-Type', contentType);
    
    // 스트림 파이프
    response.data.pipe(res);
    
  } catch (error) {
    console.error(`❌ 프록시 오류:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.options('/proxy/direct', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// =============================================================================
// 서버 정보
// =============================================================================
app.get('/', (req, res) => {
  res.json({
    message: 'UTIC CCTV 프록시 서버',
    version: '4.0.0',
    strategy: 'WebView Only (UTIC 공식 방식)',
    changes: [
      'ExoPlayer 로직 제거 - WebView 전용으로 단순화',
      'cctvStream.js의 KIND 결정 로직 반영',
      'L01 → Seoul, L02 → N, L03 → O, L04 → P, L08 → d 자동 변환',
      'E44 (경산) CCTV도 WebView로 정상 재생',
      'UTIC의 복잡한 매핑 로직을 그대로 사용하여 정확도 향상'
    ],
    endpoints: {
      'GET /api/cctv/:cctvId': 'CCTV 메타데이터 + WebView URL',
      'GET /proxy/direct?url=': 'CORS 우회 스트림 프록시 (선택사항)'
    },
    kindMapping: {
      'L01XXX': 'Seoul (서울)',
      'L02XXX': 'N (인천)',
      'L03XXX': 'O (부천)',
      'L04XXX': 'P (광명)',
      'L08XXX': 'd (용인)',
      'E44XXX': 'GG (경산)',
      'other': 'API 응답 KIND 그대로 사용'
    },
    playerType: 'webview (모든 CCTV)'
  });
});

// =============================================================================
// 서버 시작
// =============================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ==============================`);
  console.log(`🎯 UTIC CCTV 프록시 서버 시작!`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`📦 Node.js: ${process.version}`);
  console.log(`✅ WebView 전용 (UTIC 공식 방식)`);
  console.log(`✅ cctvStream.js KIND 로직 적용`);
  console.log(`===============================\n`);
});
