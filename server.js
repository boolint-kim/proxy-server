const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const https = require('https');

const app = express();
const PORT = 3000;

// CORS 설정
app.use(cors());
app.use(express.json());

// UTIC API 설정
const UTIC_API_KEY = 'spdYlAuDpMu815Bqun6bM4xMjg7gBtVChlcFWMEUGqDvbRRDx9OSu8n2gXlrj3';
const UTIC_HEADERS = {
  'Referer': 'https://www.utic.go.kr/guide/cctvOpenData.do',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

// 캐시 설정
const CSV_CACHE_FILE = path.join(__dirname, 'cctv_cache.json');
const CSV_DOWNLOAD_URL = 'https://www.utic.go.kr/excel/download/OpenDataCCTV';
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6시간

// 캐시된 CCTV 데이터
let cachedCCTVData = {
  data: [],
  lastUpdated: 0,
  isLoading: false
};

// ========== 로깅 미들웨어 (모든 요청 추적) ==========
app.use((req, res, next) => {
  console.log(`\n🌐 === 요청 받음 ===`);
  console.log(`⏰ 시간: ${new Date().toISOString()}`);
  console.log(`📋 메소드: ${req.method}`);
  console.log(`🔗 URL: ${req.originalUrl}`);
  console.log(`❓ 쿼리: ${JSON.stringify(req.query)}`);
  console.log(`📡 User-Agent: ${req.get('User-Agent')}`);
  console.log(`🌐 IP: ${req.ip}`);
  console.log(`================\n`);
  next();
});

// ========== 유틸리티 함수들 ==========

// 엑셀 데이터 파싱 함수
function parseExcelData(buffer) {
  try {
    console.log('📊 엑셀 파일 파싱 시작...');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet);
    
    console.log(`📈 엑셀에서 ${jsonData.length}개 행 읽음`);
    
    const cctvList = jsonData.map(row => ({
      id: row.CCTVID || '',
      name: row.CCTVNAME || '',
      center: row.CENTERNAME || '',
      lng: parseFloat(row.XCOORD) || 0,
      lat: parseFloat(row.YCOORD) || 0
    })).filter(item => item.id && item.name && item.lat && item.lng);
    
    console.log(`✅ 유효한 CCTV 데이터: ${cctvList.length}개`);
    
    // 샘플 데이터 출력
    if (cctvList.length > 0) {
      console.log('📋 샘플 데이터 (첫 3개):');
      cctvList.slice(0, 3).forEach((cctv, index) => {
        console.log(`  ${index + 1}. ${cctv.name} (${cctv.lat}, ${cctv.lng}) - ${cctv.center}`);
      });
    }
    
    return cctvList;
    
  } catch (error) {
    console.error('❌ 엑셀 파일 파싱 오류:', error.message);
    return [];
  }
}

// 기본 CCTV 목록 (fallback)
function getDefaultCCTVList() {
  return [
    { id: 'L933113', name: '강원 강릉 용강동', center: 'KBS 재난포털', lat: 37.7519, lng: 128.8760 },
    { id: 'L933103', name: '강원 강릉 주문진방파제', center: 'KBS 재난포털', lat: 37.8944, lng: 128.8186 },
    { id: 'L933094', name: '강원 속초 등대전망대', center: 'KBS 재난포털', lat: 38.2070, lng: 128.5918 },
    { id: 'L933073', name: '서울 마포 성산교', center: 'KBS 재난포털', lat: 37.5665, lng: 126.9780 },
    { id: 'L933075', name: '부산 동래 세병교', center: 'KBS 재난포털', lat: 35.2048, lng: 129.0837 },
    { id: 'E911789', name: '서해안선 목감IC', center: '국가교통정보센터', lat: 37.2636, lng: 126.8226 },
    { id: 'E620034', name: '공주시 국재교', center: '금강홍수통제소', lat: 36.4606, lng: 127.1089 },
    { id: 'L260003', name: '김해 빙그레삼거리', center: '김해교통정보센터', lat: 35.2281, lng: 128.8890 }
  ];
}

// 캐시 유효성 확인
function isCacheValid() {
  const now = Date.now();
  return (now - cachedCCTVData.lastUpdated) < CACHE_DURATION;
}

// CCTV 스트림 URL 생성 함수
function buildStreamUrl(cctvData, apiKey) {
  const baseUrl = 'https://www.utic.go.kr/jsp/map/openDataCctvStream.jsp';
  const params = new URLSearchParams();
  
  params.append('key', apiKey);
  params.append('cctvid', cctvData.CCTVID);
  
  if (cctvData.CCTVNAME) {
    params.append('cctvName', encodeURIComponent(cctvData.CCTVNAME));
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
  } else {
    // 채널 정보가 없으면 파라미터 자체를 제거하거나 기본값 설정
    console.log('⚠️ CCTV 채널 정보 없음:', cctvData.CCTVID);
    // params.append('cctvch', '1'); // 필요시 기본값 설정
  }
  
  if (cctvData.PORT && cctvData.PORT !== 'undefined') {
    params.append('cctvport', cctvData.PORT);
  } else {
    console.log('⚠️ CCTV 포트 정보 없음:', cctvData.CCTVID);
    // params.append('cctvport', '80'); // 필요시 기본값 설정
  }
  
  const finalUrl = `${baseUrl}?${params.toString()}`;
  console.log('🔗 생성된 스트림 URL:', finalUrl);
  
  return finalUrl;

  //params.append('cctvch', 'undefined');
  //params.append('cctvport', 'undefined');
  
  //return `${baseUrl}?${params.toString()}`;
}

// 거리 계산 함수 (Haversine formula)
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // 지구 반지름 (km)
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ========== 캐시 관리 함수들 ==========

// CSV 다운로드 및 캐싱
async function updateCCTVCache() {
  if (cachedCCTVData.isLoading) {
    console.log('⏳ 이미 캐시 업데이트 중...');
    return cachedCCTVData.data;
  }
  
  try {
    cachedCCTVData.isLoading = true;
    console.log('🔄 CCTV 목록 업데이트 시작...');
    
    // SSL 검증 비활성화된 Agent 생성
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false
    });
    
    const response = await axios.get(CSV_DOWNLOAD_URL, {
      headers: UTIC_HEADERS,
      timeout: 30000,
      responseType: 'arraybuffer',
      httpsAgent: httpsAgent
    });
    
    console.log(`📦 엑셀 파일 다운로드 완료: ${response.data.length} bytes`);
    
    const cctvList = parseExcelData(response.data);
    
    if (cctvList.length > 0) {
      cachedCCTVData.data = cctvList;
      cachedCCTVData.lastUpdated = Date.now();
      
      // 파일로 캐시 저장
      fs.writeFileSync(CSV_CACHE_FILE, JSON.stringify(cachedCCTVData, null, 2));
      
      console.log(`✅ CCTV 목록 업데이트 완료: ${cctvList.length}개`);
    } else {
      console.log('⚠️ 파싱된 데이터가 없음. 기존 캐시 유지');
    }
    
    return cachedCCTVData.data;
    
  } catch (error) {
    console.error('❌ CSV 다운로드 실패:', error.message);
    
    // 기존 캐시 데이터 사용
    if (cachedCCTVData.data.length > 0) {
      console.log('♻️ 기존 캐시 데이터 사용');
      return cachedCCTVData.data;
    }
    
    // 기본 데이터 반환
    console.log('🔧 기본 CCTV 목록 사용');
    cachedCCTVData.data = getDefaultCCTVList();
    return cachedCCTVData.data;
    
  } finally {
    cachedCCTVData.isLoading = false;
  }
}

// 캐시 초기화
function initializeCache() {
  try {
    if (fs.existsSync(CSV_CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(CSV_CACHE_FILE, 'utf8'));
      cachedCCTVData = { ...cachedCCTVData, ...cached };
      console.log(`💾 캐시 파일 로드: ${cachedCCTVData.data.length}개`);
    }
  } catch (error) {
    console.error('❌ 캐시 파일 로드 실패:', error.message);
  }
  
  // 캐시가 없거나 만료된 경우 즉시 업데이트
  if (!isCacheValid()) {
    console.log('🔄 캐시 만료됨. 업데이트 시작...');
    updateCCTVCache();
  }
}

// 정기 업데이트 스케줄러
function startCacheScheduler() {
  setInterval(() => {
    console.log('⏰ 정기 캐시 업데이트 시작');
    updateCCTVCache();
  }, CACHE_DURATION);
}

// ========== API 라우트들 (중요: 순서가 중요합니다!) ==========

// 기본 라우트
app.get('/', (req, res) => {
  console.log('🏠 기본 라우트 호출됨');
  res.json({
    message: 'CCTV 프록시 서버 with 엑셀 캐싱',
    version: '2.1.0-debug',
    timestamp: new Date().toISOString(),
    endpoints: {
      'GET /': '서버 정보',
      'GET /health': '서버 상태 확인',
      'GET /api/cctv/list': 'CCTV 목록 조회 (캐시됨)',
      'GET /api/cctv/nearby': '위치 기반 근처 CCTV 조회',
      'POST /api/cctv/refresh': '캐시 강제 업데이트',
      'GET /api/cctv/:cctvId': 'CCTV 스트림 URL 조회',
      'GET /api/cache/status': '캐시 상태 확인',
      'GET /api/debug/routes': '등록된 라우트 목록',
      'GET /api/debug/cache': '캐시 상세 정보'
    }
  });
});

// 헬스체크
app.get('/health', (req, res) => {
  console.log('❤️ 헬스체크 호출됨');
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    cache: {
      count: cachedCCTVData.data.length,
      valid: isCacheValid(),
      lastUpdated: new Date(cachedCCTVData.lastUpdated).toISOString()
    }
  });
});

// ========== 디버그 라우트들 (specific routes first) ==========

// 등록된 라우트 목록 확인 (디버깅용)
app.get('/api/debug/routes', (req, res) => {
  console.log('🔍 라우트 목록 조회 요청');
  
  const routes = [];
  
  function extractRoutes(stack, basePath = '') {
    stack.forEach((layer) => {
      if (layer.route) {
        // 일반 라우트
        const methods = Object.keys(layer.route.methods);
        const fullPath = basePath + layer.route.path;
        routes.push({
          path: fullPath,
          methods: methods,
          type: 'route'
        });
        console.log(`  📍 ${methods.join(',').toUpperCase()} ${fullPath}`);
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        // 라우터 미들웨어
        const routerPath = layer.regexp.source
          .replace('\\/', '/')
          .replace('(?=\\/|$)', '')
          .replace('^', '');
        extractRoutes(layer.handle.stack, basePath + routerPath);
      }
    });
  }
  
  console.log('📋 등록된 라우트 목록:');
  extractRoutes(app._router.stack);
  
  res.json({
    success: true,
    routes: routes,
    count: routes.length,
    timestamp: new Date().toISOString()
  });
});

// 캐시 상세 정보 확인
app.get('/api/debug/cache', (req, res) => {
  console.log('💾 캐시 상세 정보 조회');
  
  const sampleData = cachedCCTVData.data.slice(0, 5).map(cctv => ({
    id: cctv.id,
    name: cctv.name,
    lat: cctv.lat,
    lng: cctv.lng,
    center: cctv.center
  }));
  
  console.log('📊 캐시 정보:');
  console.log(`  📈 데이터 개수: ${cachedCCTVData.data.length}`);
  console.log(`  ⏰ 마지막 업데이트: ${new Date(cachedCCTVData.lastUpdated).toISOString()}`);
  console.log(`  ✅ 유효 상태: ${isCacheValid()}`);
  console.log(`  🔄 로딩 중: ${cachedCCTVData.isLoading}`);
  
  res.json({
    success: true,
    cache: {
      count: cachedCCTVData.data.length,
      lastUpdated: new Date(cachedCCTVData.lastUpdated).toISOString(),
      isValid: isCacheValid(),
      isLoading: cachedCCTVData.isLoading,
      nextUpdate: new Date(cachedCCTVData.lastUpdated + CACHE_DURATION).toISOString(),
      sampleData: sampleData
    }
  });
});

// 캐시 상태 확인
app.get('/api/cache/status', (req, res) => {
  console.log('📊 캐시 상태 확인 요청');
  res.json({
    count: cachedCCTVData.data.length,
    lastUpdated: new Date(cachedCCTVData.lastUpdated).toISOString(),
    isValid: isCacheValid(),
    isLoading: cachedCCTVData.isLoading,
    nextUpdate: new Date(cachedCCTVData.lastUpdated + CACHE_DURATION).toISOString()
  });
});

// 위치 기반 근처 CCTV 조회 ⭐ 중요: 이 라우트를 :cctvId 라우트보다 먼저 배치
app.get('/api/cctv/nearby', async (req, res) => {
  console.log('\n🔍 === /api/cctv/nearby 라우트 호출됨 ===');
  
  try {
    const { lat, lng, radius = 10 } = req.query;
    
    console.log('📥 받은 파라미터:', { lat, lng, radius });
    
    if (!lat || !lng) {
      console.log('❌ 위도/경도 파라미터 누락');
      return res.status(400).json({
        success: false,
        error: '위도(lat)와 경도(lng) 파라미터가 필요합니다',
        required: ['lat', 'lng'],
        optional: ['radius (기본값: 10km)']
      });
    }
    
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const searchRadius = parseFloat(radius);
    
    console.log('🎯 파싱된 좌표:', { userLat, userLng, searchRadius });
    
    let cctvList = cachedCCTVData.data;
    console.log(`💾 캐시된 CCTV 개수: ${cctvList.length}`);
    
    if (cctvList.length === 0) {
      console.log('🔄 캐시가 비어있음. 업데이트 시도...');
      cctvList = await updateCCTVCache();
      console.log(`📊 업데이트 후 CCTV 개수: ${cctvList.length}`);
    }
    
    // 거리 계산하여 필터링
    console.log('📏 거리 계산 시작...');
    const nearbyCCTVs = cctvList
      .map(cctv => {
        const distance = calculateDistance(userLat, userLng, cctv.lat, cctv.lng);
        return { ...cctv, distance };
      })
      .filter(cctv => {
        const isNearby = cctv.distance <= searchRadius;
        if (isNearby) {
          console.log(`  ✅ 근처 CCTV: ${cctv.name} (${cctv.distance.toFixed(2)}km)`);
        }
        return isNearby;
      })
      .sort((a, b) => a.distance - b.distance);
    
    console.log(`🎯 필터링 결과: ${nearbyCCTVs.length}개 CCTV 발견`);
    
    const response = {
      success: true,
      count: nearbyCCTVs.length,
      data: nearbyCCTVs,
      userLocation: { lat: userLat, lng: userLng },
      radius: searchRadius,
      debug: {
        totalCctv: cctvList.length,
        cacheValid: isCacheValid(),
        cacheLastUpdated: new Date(cachedCCTVData.lastUpdated).toISOString(),
        timestamp: new Date().toISOString()
      }
    };
    
    console.log('📤 응답 전송:', {
      success: response.success,
      count: response.count,
      userLocation: response.userLocation,
      radius: response.radius
    });
    
    res.json(response);
    
  } catch (error) {
    console.error('❌ /api/cctv/nearby 오류:', error);
    res.status(500).json({
      success: false,
      error: '근처 CCTV 조회 실패',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// CCTV 목록 조회 (캐시 사용)
app.get('/api/cctv/list', async (req, res) => {
  console.log('📋 CCTV 목록 조회 요청');
  
  try {
    let cctvList = cachedCCTVData.data;
    
    // 캐시가 만료된 경우 백그라운드 업데이트
    if (!isCacheValid() && !cachedCCTVData.isLoading) {
      console.log('🔄 캐시 만료. 백그라운드 업데이트 시작...');
      updateCCTVCache();
    }
    
    // 캐시가 비어있으면 즉시 업데이트
    if (cctvList.length === 0) {
      console.log('🔄 캐시 비어있음. 즉시 업데이트...');
      cctvList = await updateCCTVCache();
    }
    
    console.log(`📊 응답할 CCTV 개수: ${cctvList.length}`);
    
    res.json({
      success: true,
      count: cctvList.length,
      data: cctvList,
      cached: true,
      lastUpdated: new Date(cachedCCTVData.lastUpdated).toISOString()
    });
    
  } catch (error) {
    console.error('❌ 목록 조회 오류:', error.message);
    res.status(500).json({
      success: false,
      error: '목록 조회 실패',
      data: getDefaultCCTVList()
    });
  }
});

// 캐시 강제 업데이트
app.post('/api/cctv/refresh', async (req, res) => {
  console.log('🔄 캐시 강제 업데이트 요청');
  
  try {
    const cctvList = await updateCCTVCache();
    res.json({
      success: true,
      message: '캐시 업데이트 완료',
      count: cctvList.length,
      lastUpdated: new Date(cachedCCTVData.lastUpdated).toISOString()
    });
  } catch (error) {
    console.error('❌ 캐시 업데이트 실패:', error);
    res.status(500).json({
      success: false,
      error: '캐시 업데이트 실패',
      details: error.message
    });
  }
});

// 개별 CCTV 스트림 URL 생성 ⭐ 중요: 이 라우트는 가장 마지막에 배치
app.get('/api/cctv/:cctvId', async (req, res) => {
  console.log(`🎥 개별 CCTV 조회: ${req.params.cctvId}`);
  
  try {
    const { cctvId } = req.params;
    
    const metadataUrl = `http://www.utic.go.kr/map/getCctvInfoById.do?cctvId=${cctvId}&key=${UTIC_API_KEY}`;
    
    console.log(`🔗 메타데이터 URL: ${metadataUrl}`);
    
    const response = await axios.get(metadataUrl, {
      headers: UTIC_HEADERS,
      timeout: 15000
    });
    
    const cctvData = response.data;
    
    if (cctvData.msg && cctvData.code === '9999') {
      console.log(`❌ 비정상적인 접근: ${cctvId}`);
      return res.status(403).json({
        success: false,
        error: '비정상적인 접근입니다',
        cctvId: cctvId
      });
    }
    
    const streamUrl = buildStreamUrl(cctvData, UTIC_API_KEY);
    
    console.log(`✅ 스트림 URL 생성 완료: ${cctvId}`);
    
    res.json({
      success: true,
      cctvId: cctvId,
      streamUrl: streamUrl,
      metadata: cctvData,
      location: {
        lat: cctvData.YCOORD,
        lng: cctvData.XCOORD
      }
    });
    
  } catch (error) {
    console.error(`❌ CCTV API 오류 (${req.params.cctvId}):`, error.message);
    res.status(500).json({
      success: false,
      error: 'API 호출 실패',
      details: error.message,
      cctvId: req.params.cctvId
    });
  }
});

// ========== 응답 로깅 미들웨어 ==========
app.use((req, res, next) => {
  const originalSend = res.send;
  res.send = function(data) {
    console.log(`\n📤 === 응답 전송 ===`);
    console.log(`🔢 상태 코드: ${res.statusCode}`);
    console.log(`📦 응답 크기: ${data ? data.length : 0} bytes`);
    console.log(`📋 응답 타입: ${res.get('Content-Type')}`);
    if (data && data.length < 500) {
      console.log(`📄 응답 내용: ${data}`);
    }
    console.log(`==================\n`);
    originalSend.call(this, data);
  };
  next();
});

// 404 핸들러 (모든 라우트 마지막에)
app.use('*', (req, res) => {
  console.log(`❌ 404 - 라우트를 찾을 수 없음: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    error: '요청한 엔드포인트를 찾을 수 없습니다',
    method: req.method,
    url: req.originalUrl,
    availableEndpoints: [
      'GET /',
      'GET /health',
      'GET /api/cctv/list',
      'GET /api/cctv/nearby',
      'POST /api/cctv/refresh',
      'GET /api/cctv/:cctvId',
      'GET /api/cache/status',
      'GET /api/debug/routes',
      'GET /api/debug/cache'
    ]
  });
});

// 서버 시작
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ==============================`);
  console.log(`🎯 CCTV 프록시 서버 시작 완료!`);
  console.log(`🌐 포트: ${PORT}`);
  console.log(`⏰ 시작 시간: ${new Date().toISOString()}`);
  console.log(`🔄 캐시 업데이트 주기: ${CACHE_DURATION / (60 * 60 * 1000)}시간`);
  console.log(`===============================\n`);
  
  // 캐시 초기화
  console.log('💾 캐시 초기화 시작...');
  initializeCache();
  
  // 정기 업데이트 시작
  console.log('⏰ 정기 업데이트 스케줄러 시작...');
  startCacheScheduler();
  
  console.log('✅ 서버 준비 완료!\n');
});
