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
// 메인 API: CCTV 메타데이터 + 비디오 URL
// =============================================================================
app.get('/api/cctv/:cctvId', async (req, res) => {
  try {
    const { cctvId } = req.params;
    
    console.log(`📡 메타데이터 요청: ${cctvId}`);
    
    const metadataUrl = `http://www.utic.go.kr/map/getCctvInfoById.do?cctvId=${cctvId}&key=${UTIC_API_KEY}`;
    
    const response = await axios.get(metadataUrl, {
      headers: UTIC_HEADERS,
      timeout: 15000,
      httpsAgent: httpsAgent
    });
    
    const cctvData = response.data;
    
    if (cctvData.msg && cctvData.code === '9999') {
      return res.status(403).json({
        success: false,
        error: '비정상적인 접근',
        cctvId: cctvId
      });
    }
    
    const streamPageUrl = buildStreamPageUrl(cctvData);
    
    console.log(`✅ 메타데이터: ${cctvData.CCTVNAME} (KIND: ${cctvData.KIND})`);
    
    let directVideoUrl = null;
    let playerType = 'webview'; // 기본값은 webview
    
    // ⭐ 확실히 작동하는 KIND만 ExoPlayer 처리
    switch (cctvData.KIND) {
      case 'MODE': // 서울 - AJAX
        directVideoUrl = await getUrlViaAjax(cctvData);
        if (directVideoUrl) {
          playerType = 'exoplayer';
        }
        break;
        
      case 'N': // 인천 - MMS
        directVideoUrl = buildUrlForIncheon(cctvData);
        if (directVideoUrl) {
          playerType = 'exoplayer';
        }
        break;
        
      case 'E': // 대전 - MMS
        directVideoUrl = buildUrlForDaejeon(cctvData);
        if (directVideoUrl) {
          playerType = 'exoplayer';
        }
        break;
        
      // ⭐ 나머지는 모두 WebView
      default:
        console.log(`→ ${cctvData.KIND}: WebView로 처리`);
        playerType = 'webview';
        break;
    }
    
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
      kind: cctvData.KIND,
      directVideoUrl: directVideoUrl,
      playerType: playerType
    });
    
  } catch (error) {
    console.error(`❌ 오류 (${req.params.cctvId}):`, error.message);
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

// 스트림 페이지 URL 생성
function buildStreamPageUrl(cctvData) {
  const baseUrl = 'https://www.utic.go.kr/jsp/map/openDataCctvStream.jsp';
  const params = new URLSearchParams();
  
  params.append('key', UTIC_API_KEY);
  params.append('cctvid', cctvData.CCTVID);
  
  if (cctvData.CCTVNAME) params.append('cctvName', cctvData.CCTVNAME);
  if (cctvData.KIND) params.append('kind', cctvData.KIND);
  if (cctvData.CCTVIP) params.append('cctvip', cctvData.CCTVIP);
  if (cctvData.ID) params.append('id', cctvData.ID);
  if (cctvData.PASSWD) params.append('cctvpasswd', cctvData.PASSWD);
  if (cctvData.CH && cctvData.CH !== 'undefined') params.append('cctvch', cctvData.CH);
  if (cctvData.PORT && cctvData.PORT !== 'undefined') params.append('cctvport', cctvData.PORT);
  
  return `${baseUrl}?${params.toString()}`;
}

// AJAX로 URL 가져오기 (MODE, GG)
async function getUrlViaAjax(cctvData) {
  try {
    const cctvIp = cctvData.ID || cctvData.CCTVIP;
    if (!cctvIp) return null;
    
    const ajaxUrl = `https://www.utic.go.kr/map/getGyeonggiCctvUrl.do?cctvIp=${cctvIp}`;
    console.log(`📡 AJAX 호출 (${cctvData.KIND}): ${ajaxUrl}`);
    
    const response = await axios.get(ajaxUrl, {
      headers: UTIC_HEADERS,
      httpsAgent: httpsAgent,
      timeout: 15000
    });
    
    let videoUrl = response.data.trim();
    
    // // 로 시작하면 https:// 붙이기
    if (videoUrl.startsWith('//')) {
      videoUrl = 'https:' + videoUrl;
    }
    
    console.log(`✅ ${cctvData.KIND} 비디오 URL: ${videoUrl}`);
    return videoUrl;
    
  } catch (error) {
    console.error(`❌ ${cctvData.KIND} AJAX 실패:`, error.message);
    return null;
  }
}

// 인천 (N): mms://stream.fitic.go.kr/CCTVXX
function buildUrlForIncheon(cctvData) {
  const cctvNum = cctvData.CCTVID.substring(cctvData.CCTVID.length - 2);
  const url = `mms://stream.fitic.go.kr/CCTV${cctvNum}`;
  console.log(`✅ N (인천) URL: ${url}`);
  return url;
}

// 군산 (V): http://IP/axis-cgi/mjpg/video.cgi
function buildUrlForGunsan(cctvData) {
  if (!cctvData.CCTVIP) return null;
  const url = `http://${cctvData.CCTVIP}/axis-cgi/mjpg/video.cgi`;
  console.log(`✅ V (군산) URL: ${url}`);
  return url;
}

// 여수 (y): http://112.164.152.X/axis-cgi/mjpg/video.cgi
function buildUrlForYeosu(cctvData) {
  if (!cctvData.CCTVIP || !cctvData.CH) return null;
  const url = `http://112.164.152.${cctvData.CCTVIP}/axis-cgi/mjpg/video.cgi?resolution=4CIF&camera=${cctvData.CH}`;
  console.log(`✅ y (여수) URL: ${url}`);
  return url;
}

// 원주 (m): rtmp://118.46.175.150/live/ID.stream
function buildUrlForWonju(cctvData) {
  if (!cctvData.ID) return null;
  const url = `rtmp://118.46.175.150/live/${cctvData.ID}.stream`;
  console.log(`✅ m (원주) URL: ${url}`);
  return url;
}

// 대전 (E): mms://210.99.67.118:7500/ID
function buildUrlForDaejeon(cctvData) {
  if (!cctvData.ID) return null;
  const server = cctvData.ID < 31 ? '118' : '119';
  const url = `mms://210.99.67.${server}:7500/${cctvData.ID}`;
  console.log(`✅ E (대전) URL: ${url}`);
  return url;
}

// 전주 (F): mms://IP:PORT
function buildUrlForJeonju(cctvData) {
  if (!cctvData.CCTVIP || !cctvData.ID || cctvData.CH !== '2') return null;
  const url = `mms://${cctvData.CCTVIP}:${cctvData.ID}`;
  console.log(`✅ F (전주) URL: ${url}`);
  return url;
}

// 대전지방국토 (Q): mms://IP/liveID
function buildUrlForDaejeonGukto(cctvData) {
  if (!cctvData.CCTVIP || !cctvData.ID || cctvData.CCTVIP.startsWith('dvr')) return null;
  const url = `mms://${cctvData.CCTVIP}/live${cctvData.ID}`;
  console.log(`✅ Q (대전국토) URL: ${url}`);
  return url;
}

// 시흥 (c): mms://27.101.133.164/IP
function buildUrlForSiheung(cctvData) {
  if (!cctvData.CCTVIP) return null;
  const url = `mms://27.101.133.164/${cctvData.CCTVIP}`;
  console.log(`✅ c (시흥) URL: ${url}`);
  return url;
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
    version: '3.0.0',
    endpoints: {
      'GET /api/cctv/:cctvId': 'CCTV 메타데이터 + directVideoUrl + playerType',
      'GET /proxy/direct?url=': 'CORS 우회 스트림 프록시'
    },
    supportedKinds: {
      exoplayer: ['MODE', 'GG', 'N', 'V', 'y', 'm', 'E', 'F', 'Q', 'c'],
      webview: ['P', 'D', 'Z', 'a', 'G', 'Y', 't', '기타']
    }
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
  console.log(`===============================\n`);
});
