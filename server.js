const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const UTIC_API_KEY = 'spdYlAuDpMu815Bqun6bM4xMjg7gBtVChlcFWMEUGqDvbRRDx9OSu8n2gXlrj3';
const UTIC_HEADERS = {
  'Referer': 'https://www.utic.go.kr/guide/cctvOpenData.do',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// server.js - /api/cctv/:cctvId 수정
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
    
    console.log(`✅ 메타데이터 획득: ${cctvData.CCTVNAME}`);
    console.log(`🏷️ KIND: ${cctvData.KIND}`);
    
    // ⭐ KIND이 MODE인 경우 AJAX로 실제 URL 가져오기
    let directVideoUrl = null;
    if (cctvData.KIND === 'MODE' && cctvData.ID) {
      try {
        const ajaxUrl = `https://www.utic.go.kr/map/getGyeonggiCctvUrl.do?cctvIp=${cctvData.ID}`;
        console.log(`📡 AJAX URL 호출: ${ajaxUrl}`);
        
        const ajaxResponse = await axios.get(ajaxUrl, {
          headers: UTIC_HEADERS,
          httpsAgent: httpsAgent,
          timeout: 15000
        });
        
        let videoUrl = ajaxResponse.data.trim();
        
        // ⭐ // 로 시작하면 https:// 붙이기
        if (videoUrl.startsWith('//')) {
          videoUrl = 'https:' + videoUrl;
        }
        
        directVideoUrl = videoUrl;
        console.log(`✅ 실제 비디오 URL: ${directVideoUrl}`);
        
      } catch (ajaxError) {
        console.error(`❌ AJAX 호출 실패: ${ajaxError.message}`);
      }
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
      directVideoUrl: directVideoUrl  // ⭐ 추가
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

function buildStreamPageUrl(cctvData) {
  const baseUrl = 'https://www.utic.go.kr/jsp/map/openDataCctvStream.jsp';
  const params = new URLSearchParams();
  
  params.append('key', UTIC_API_KEY);
  params.append('cctvid', cctvData.CCTVID);
  
  if (cctvData.CCTVNAME) {
    params.append('cctvName', cctvData.CCTVNAME);
  }
  if (cctvData.KIND) {
    params.append('kind', cctvData.KIND);
  }
  if (cctvData.CCTVIP) {
    params.append('cctvip', cctvData.CCTVIP);
  }
  if (cctvData.ID) {
    params.append('id', cctvData.ID);
  }
  if (cctvData.PASSWD) {
    params.append('cctvpasswd', cctvData.PASSWD);
  }
  if (cctvData.CH && cctvData.CH !== 'undefined') {
    params.append('cctvch', cctvData.CH);
  }
  if (cctvData.PORT && cctvData.PORT !== 'undefined') {
    params.append('cctvport', cctvData.PORT);
  }
  
  return `${baseUrl}?${params.toString()}`;
}

// server.js - 더 정교한 URL 추출
app.get('/proxy/stream', async (req, res) => {
  try {
    const streamPageUrl = req.query.url;
    
    if (!streamPageUrl) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL 파라미터 필요' 
      });
    }
    
    console.log(`🔍 스트림 페이지 프록시 요청: ${streamPageUrl}`);
    
    const response = await axios.get(streamPageUrl, {
      headers: UTIC_HEADERS,
      httpsAgent: httpsAgent,
      timeout: 30000
    });
    
    const html = response.data;
    let videoUrl = null;
    let videoUrlSource = null;
    
    // 1) <video src="..."> - 우선순위 최상
    let match = html.match(/<video[^>]+src=["']([^"']+)["']/i);
    if (match) {
      videoUrl = match[1];
      videoUrlSource = 'video src attribute';
    }
    
    // 2) <source src="...">
    if (!videoUrl) {
      match = html.match(/<source[^>]+src=["']([^"']+)["']/i);
      if (match) {
        videoUrl = match[1];
        videoUrlSource = 'source src attribute';
      }
    }
    
    // 3) JavaScript에서 video.src 설정 찾기
    // 예: video.src = 'http://...'
    if (!videoUrl) {
      match = html.match(/video\.src\s*=\s*["']([^"']+)["']/i);
      if (match) {
        videoUrl = match[1];
        videoUrlSource = 'video.src assignment';
      }
    }
    
    // 4) hls.loadSource() 찾기
    if (!videoUrl) {
      match = html.match(/hls\.loadSource\s*\(\s*["']([^"']+)["']\s*\)/i);
      if (match) {
        videoUrl = match[1];
        videoUrlSource = 'hls.loadSource';
      }
    }
    
    // 5) AJAX 호출에서 URL 가져오기
    // 예: $.ajax({ url: 'getGyeonggiCctvUrl.do', ... })
    if (!videoUrl) {
      // getCctvUrl 패턴 찾기
      match = html.match(/getCctvUrl\s*=\s*["']([^"']+)["']/);
      if (match) {
        const ajaxUrl = match[1];
        console.log(`📡 AJAX URL 발견: ${ajaxUrl}`);
        
        // AJAX URL이 상대 경로면 절대 경로로 변환
        let fullAjaxUrl = ajaxUrl;
        if (ajaxUrl.startsWith('/')) {
          fullAjaxUrl = 'https://www.utic.go.kr' + ajaxUrl;
        }
        
        try {
          // AJAX 엔드포인트 호출
          const ajaxResponse = await axios.get(fullAjaxUrl, {
            headers: UTIC_HEADERS,
            httpsAgent: httpsAgent,
            timeout: 15000
          });
          
          videoUrl = ajaxResponse.data.trim();
          videoUrlSource = 'ajax response';
          console.log(`✅ AJAX로 받은 URL: ${videoUrl}`);
        } catch (ajaxError) {
          console.error(`❌ AJAX 호출 실패: ${ajaxError.message}`);
        }
      }
    }
    
    // 6) m3u8 URL - 주석이 아닌 곳에서만
    if (!videoUrl) {
      // <!-- 주석 제거
      const htmlWithoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
      
      match = htmlWithoutComments.match(/(https?:\/\/[\d.:]+\/[^\s"'<>]+\.m3u8)/i);
      if (match) {
        videoUrl = match[1];
        videoUrlSource = 'm3u8 in text';
      }
    }
    
    if (videoUrl) {
      // URL 정리
      videoUrl = videoUrl.replace(/--+$/, '');  // 끝의 -- 제거
      videoUrl = videoUrl.trim();
      
      console.log(`✅ 비디오 URL 추출: ${videoUrl} (출처: ${videoUrlSource})`);
      
      // ⭐ URL이 실제로 접근 가능한지 확인
      try {
        const testResponse = await axios.head(videoUrl, {
          headers: {
            'User-Agent': UTIC_HEADERS['User-Agent'],
            'Referer': streamPageUrl
          },
          httpsAgent: httpsAgent,
          timeout: 5000,
          validateStatus: (status) => status < 500
        });
        
        console.log(`✅ URL 접근 가능: ${testResponse.status}`);
        
        return res.json({
          success: true,
          videoUrl: videoUrl,
          source: videoUrlSource,
          status: testResponse.status,
          accessible: testResponse.status === 200
        });
        
      } catch (testError) {
        console.warn(`⚠️ URL 접근 테스트 실패: ${testError.message}`);
        
        // 접근 불가능하지만 URL은 반환
        return res.json({
          success: true,
          videoUrl: videoUrl,
          source: videoUrlSource,
          accessible: false,
          error: testError.message
        });
      }
    }
    
    console.log(`❌ 비디오 URL 찾을 수 없음`);
    res.status(404).json({ 
      success: false, 
      error: 'Video URL not found in page'
    });
    
  } catch (error) {
    console.error(`❌ 프록시 오류:`, error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ⭐ KIND=MODE 전용: 실제 비디오 URL 가져오기
app.get('/api/cctv/:cctvId/direct-url', async (req, res) => {
  try {
    const { cctvId } = req.params;
    
    console.log(`📡 직접 URL 요청: ${cctvId}`);
    
    // 1. 메타데이터 가져오기
    const metadataUrl = `http://www.utic.go.kr/map/getCctvInfoById.do?cctvId=${cctvId}&key=${UTIC_API_KEY}`;
    
    const metaResponse = await axios.get(metadataUrl, {
      headers: UTIC_HEADERS,
      timeout: 15000,
      httpsAgent: httpsAgent
    });
    
    const cctvData = metaResponse.data;
    
    console.log('📦 메타데이터:', JSON.stringify(cctvData, null, 2));
    
    // ID 필드 사용
    const cctvIdOrIp = cctvData.ID || cctvData.CCTVIP || cctvData.IP;
    
    if (!cctvIdOrIp) {
      return res.status(404).json({
        success: false,
        error: 'ID를 찾을 수 없음',
        metadata: cctvData
      });
    }
    
    console.log(`📍 ID: ${cctvIdOrIp}`);
    
    // 2. AJAX로 실제 비디오 URL 가져오기
    const ajaxUrl = `https://www.utic.go.kr/map/getGyeonggiCctvUrl.do?cctvIp=${cctvIdOrIp}`;
    console.log(`📡 AJAX 호출: ${ajaxUrl}`);
    
    const ajaxResponse = await axios.get(ajaxUrl, {
      headers: UTIC_HEADERS,
      httpsAgent: httpsAgent,
      timeout: 15000
    });
    
    const videoUrl = ajaxResponse.data.trim();
    
    console.log(`✅ 실제 비디오 URL: ${videoUrl}`);
    
    res.json({
      success: true,
      cctvId: cctvId,
      cctvIdOrIp: cctvIdOrIp,
      kind: cctvData.KIND,
      videoUrl: videoUrl
    });
    
  } catch (error) {
    console.error(`❌ 오류:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ⭐ /test/stream-page도 동일하게 수정
app.get('/test/stream-page', async (req, res) => {
  try {
    const streamPageUrl = req.query.url;
    
    if (!streamPageUrl) {
      return res.status(400).send('URL 파라미터가 필요합니다.');
    }
    
    console.log(`🔍 테스트 요청: ${streamPageUrl}`);
    
    const response = await axios.get(streamPageUrl, {
      headers: UTIC_HEADERS,
      httpsAgent: httpsAgent,
      timeout: 30000
    });
    
    const html = response.data;
    
    const analysis = {
      url: streamPageUrl,
      htmlLength: html.length,
      hasVideo: html.includes('<video'),
      hasSource: html.includes('<source'),
      hasScript: html.includes('<script'),
      errorMessage: null,
      videoUrl: null,
      videoUrlRaw: null // 원본 URL도 저장
    };
    
    if (html.includes('지원되지 않는 프로토콜')) {
      analysis.errorMessage = '지원되지 않는 프로토콜입니다';
    }
    
    if (html.includes('비정상적인 접근')) {
      analysis.errorMessage = '비정상적인 접근';
    }
    
    // video src 추출
    let match = html.match(/<video[^>]+src=["']([^"']+)["']/i);
    if (match) {
      analysis.videoUrlRaw = match[1];
      analysis.videoUrl = match[1];
      analysis.videoType = 'video tag src';
    }
    
    // source 태그
    if (!analysis.videoUrl) {
      match = html.match(/<source[^>]+src=["']([^"']+)["']/i);
      if (match) {
        analysis.videoUrlRaw = match[1];
        analysis.videoUrl = match[1];
        analysis.videoType = 'source tag src';
      }
    }
    
    // m3u8 URL (개선된 정규식)
    if (!analysis.videoUrl) {
      match = html.match(/(https?:\/\/[\d.:]+\/[^\s"'<>]*\.m3u8)/i);
      if (match) {
        analysis.videoUrlRaw = match[1];
        // ⭐ -- 제거
        analysis.videoUrl = match[1].replace(/--+$/, '');
        analysis.videoType = 'm3u8 in text';
      }
    }
    
    // mp4 URL
    if (!analysis.videoUrl) {
      match = html.match(/(https?:\/\/[\d.:]+\/[^\s"'<>]*\.mp4)/i);
      if (match) {
        analysis.videoUrlRaw = match[1];
        analysis.videoUrl = match[1].replace(/--+$/, '');
        analysis.videoType = 'mp4 in text';
      }
    }
    
    console.log('📊 분석 결과:', analysis);
    
    const htmlPreview = html.substring(0, 1000);
    
    res.json({
      success: true,
      analysis: analysis,
      htmlPreview: htmlPreview
    });
    
  } catch (error) {
    console.error(`❌ 테스트 오류:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ⭐ 신규: CORS 우회 프록시 스트림 (ERR_BLOCKED_BY_ORB 대응)
app.get('/proxy/direct', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    
    if (!videoUrl) {
      return res.status(400).json({ error: 'URL 파라미터 필요' });
    }
    
    console.log(`📺 직접 스트림 프록시: ${videoUrl}`);
    
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': UTIC_HEADERS['User-Agent'],
        'Referer': 'https://www.utic.go.kr/'
      },
      responseType: 'stream',
      httpsAgent: httpsAgent,
      timeout: 60000
    });
    
    // ⭐ CORS 헤더 추가
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Content-Type 전달
    const contentType = response.headers['content-type'] || 'application/vnd.apple.mpegurl';
    res.setHeader('Content-Type', contentType);
    
    // 스트림 파이프
    response.data.pipe(res);
    
  } catch (error) {
    console.error(`❌ 직접 프록시 오류:`, error.message);
    res.status(500).json({ error: error.message });
  }
});



// OPTIONS 요청 처리 (CORS preflight)
app.options('/proxy/direct', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.get('/', (req, res) => {
  res.json({
    message: 'CCTV 메타데이터 서버 (WebView 방식)',
    version: '2.1.0',
    nodeVersion: process.version,
    endpoints: {
      'GET /': '서버 정보',
      'GET /api/cctv/:cctvId': 'CCTV 메타데이터 및 스트림 페이지 URL',
      'GET /proxy/stream?url=': '스트림 페이지에서 비디오 URL 추출',
      'GET /proxy/direct?url=': 'CORS 우회 직접 스트림 프록시 (NEW)'
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ==============================`);
  console.log(`🎯 CCTV 메타데이터 서버 시작!`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`📦 Node.js: ${process.version}`);
  console.log(`===============================\n`);
});
