
if(typeof L === 'undefined'){
  document.body.innerHTML = '<div class="load-error">地図ライブラリ(Leaflet)の読み込みに失敗しました。通信環境をご確認のうえ、再読み込みしてください。</div>';
  throw new Error('Leaflet failed to load from CDN');
}

/* ---------------- grade filter (学年別表示) ---------------- */
const GRADE_OPTIONS = ['U-6','U-7','U-8','U-9','U-10','U-11','U-12'];
const GRADE_LABELS = {
  'U-6':'園児(年少〜年長)', 'U-7':'1年生', 'U-8':'2年生', 'U-9':'3年生',
  'U-10':'4年生', 'U-11':'5年生', 'U-12':'6年生',
};
const GRADE_STORAGE_KEY = 'fcsirius_grade';
const YEAR_STORAGE_KEY = 'fcsirius_season_year';

// 年度は4月1日始まり。日付が取れない試合は、選択年度の集計対象に含めない。
function currentSeasonYear(date = new Date()){
  return date.getFullYear() - (date.getMonth() < 3 ? 1 : 0);
}
function loadSavedSeasonYear(){
  try{
    const saved = Number(localStorage.getItem(YEAR_STORAGE_KEY));
    return Number.isInteger(saved) && saved >= 2000 && saved <= 2100 ? saved : currentSeasonYear();
  }catch(e){ return currentSeasonYear(); }
}
function saveSeasonYear(year){
  try{ localStorage.setItem(YEAR_STORAGE_KEY, String(year)); }catch(e){ /* ignore */ }
}
function matchSeasonYear(match){
  const value = String(match && match.date || '').trim();
  if(!value) return null;
  const m = value.match(/^([0-9]{4})[^0-9]?([0-9]{1,2})[^0-9]?([0-9]{1,2})/);
  if(!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const date = new Date(year, month - 1, day);
  if(date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return year - (month < 4 ? 1 : 0);
}
let currentSeason = loadSavedSeasonYear();
function matchesInSelectedSeason(match){
  return matchSeasonYear(match) === currentSeason;
}

function loadSavedGrade(){
  try{
    const g = localStorage.getItem(GRADE_STORAGE_KEY);
    return GRADE_OPTIONS.includes(g) ? g : 'U-7';
  }catch(e){ return 'U-7'; }
}
function saveGrade(g){
  try{ localStorage.setItem(GRADE_STORAGE_KEY, g); }catch(e){ /* ignore */ }
}
let currentGrade = loadSavedGrade();
let showOtherGrades = false;

function matchesForGrade(matches){
  return (matches||[]).filter(m => matchesInSelectedSeason(m) && m.matchType !== 'internal' && (m.category||'').trim() === currentGrade);
}
function matchesForOtherGrades(matches){
  return (matches||[]).filter(m => {
    const c = (m.category||'').trim();
    return matchesInSelectedSeason(m) && m.matchType !== 'internal' && c && c !== currentGrade && GRADE_OPTIONS.includes(c);
  });
}
function hasAnyMatch(matches){
  return (matches||[]).some(m => matchesInSelectedSeason(m) && m.matchType !== 'internal' && GRADE_OPTIONS.includes((m.category||'').trim()));
}
function gradeSummary(matches, grade){
  const filtered=(matches||[]).filter(m=>matchesInSelectedSeason(m) && m.matchType !== 'internal' && (m.category||'').trim()===grade);
  const s={win:0,draw:0,lose:0,total:filtered.length};
  filtered.forEach(m=>{if(m.result==='勝')s.win++;else if(m.result==='分')s.draw++;else if(m.result==='敗')s.lose++;});
  return s;
}

/* ---------------- state ---------------- */
let points = [];        // {id, name, lat, lng}
let internalMatches = []; // SIRIUS内のA/B/C等の対戦。対外戦績・地図マーカー集計からは分離
let markers = {};        // id -> leaflet marker
let nextId = 1;
let clickModeOn = false;
let selectedId = null;
let expandedEdit = new Set();
const STORAGE_KEY = 'gsi_plotter_points';

/* ---------------- map setup ---------------- */
const map = L.map('map', { zoomControl: true }).setView([35.15, 137.03], 10); // Aichi default

const tileDefs = {
  std:   { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', maxZoom: 18, attribution: null },
  pale:  { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', maxZoom: 18, attribution: null },
  photo: { url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', maxZoom: 18, attribution: null },
  blank: { url: 'https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png', maxZoom: 18, attribution: null },
};
const gsiAttribution = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>（国土地理院）';

function makeTileLayer(key){
  const def = tileDefs[key];
  return L.tileLayer(def.url, { maxZoom: def.maxZoom, attribution: def.attribution || gsiAttribution });
}

let currentTile = makeTileLayer('pale').addTo(map);

/* ---------------- grounds (試合会場) ---------------- */
// Google Sheets の「grounds」タブをグラウンドマスタとして利用。
// GROUND_COORDS は廃止し、地図上のグラウンド情報はこのシートを唯一の参照元とする。
const GROUNDS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTEA-Qh6qyA6ODIbsqqYmWh7AfABhhpJbpXLi571XVoj86uHFJaWgDYt3vbVKOm9gO3Y9i5Vxjqesub/pub?gid=1698737875&single=true&output=csv';

// 公式・自治体等で確認できたグラウンド情報の補完。
// Google Sheetsのgroundsマスタを置き換えず、確認済みの項目だけを上書き補完する。
const GROUND_VERIFIED_INFO = {
  '木曽川運動場G': {
    address:'愛知県一宮市木曽川町黒田字北宿三の切1番地1', lat:35.34715938, lng:136.77356092, accuracy:'A',
    parking:'90台（テニスコート利用者と共用）',
    toilet:'情報未確認', access:'黒田駅 徒歩約10分／木曽川駅 徒歩約12分',
    facilities:'サッカー利用可・夜間照明あり',
    spectator:'観戦場所の詳細は現地確認',
    caution:'駐車場はグラウンド利用者・テニスコート利用者共用',
    sourceUrl:'https://www.city.ichinomiya.aichi.jp/shisetsu/1008918/1044560/1009377.html', verifiedAt:'2026-10-07'
  },
  'ひかりグランド': {
    address:'〒480-0305 愛知県春日井市坂下町6丁目782-10', lat:35.2979, lng:137.0190, accuracy:'A',
    parking:'あり（専用グラウンド）', toilet:'情報未確認',
    access:'国道19号「坂下町6丁目南」交差点から約800m先を左折後、約400m',
    facilities:'フットボール専用人工芝',
    spectator:'人工芝専用グラウンド。観戦エリアは現地案内に従う',
    caution:'入口は南側、出口は北側。サッカー関係者以外も通行するため徐行・譲り合い',
    sourceUrl:'https://ascshineburg.info/cms/%E3%81%B2%E3%81%8B%E3%82%8Afc%E3%82%B0%E3%83%A9%E3%82%A6%E3%83%B3%E3%83%89%E5%87%BA%E5%85%A5%E5%8F%A3%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6/', verifiedAt:'2026-10-07'
  },
  '碧南2号地運動広場G': {
    address:'〒447-0824 愛知県碧南市港南町1丁目1番地1', lat:34.849942, lng:136.966471, accuracy:'A',
    parking:'あり（トイレのある南側駐車場を推奨）', toilet:'あり',
    access:'港南町1丁目交差点西側',
    facilities:'サッカー利用実績あり',
    spectator:'南側駐車場側のトイレ位置を確認してから観戦場所へ',
    caution:'満車時はグラウンド東側隣接道路を北進した舗装駐車場を利用。路上駐車不可',
    sourceUrl:'https://hekinanfc.net/access/', verifiedAt:'2026-10-07'
  },
  '若園運動広場G': {
    address:'〒473-0916 愛知県豊田市吉原町穴田1', lat:35.015472, lng:137.091038, accuracy:'A',
    parking:'111台', toilet:'多目的トイレあり',
    access:'名鉄三河線 若林駅から徒歩約22分',
    facilities:'スポーツ施設・予約対象',
    spectator:'身体障がい者用駐車場あり',
    caution:'月曜休場（祝日除く）',
    sourceUrl:'https://www.city.toyota.aichi.jp/shisei/shisetsu/sports/sonohoka/1006796/index.html', verifiedAt:'2026-10-07'
  },
  '池浦西公園G': {
    address:'〒446-0066 愛知県安城市池浦町狐穴15番1', lat:34.966200, lng:137.073481, accuracy:'B',
    parking:'あり', toilet:'あり（多目的トイレあり）',
    access:'安城市池浦町',
    facilities:'水道あり・複合遊具あり',
    spectator:'芝生エリアの観戦エリア利用など、主催者案内を優先',
    caution:'自動販売機なし／日影が少ないという大会案内あり。必要に応じて日除けを準備',
    sourceUrl:'https://www.city.anjo.aichi.jp/shisei/shisetsu/shisetsu1081.html', verifiedAt:'2026-10-07'
  },
  'はままつフルーツパーク時之栖G': {
    address:'〒431-2102 静岡県浜松市浜名区都田町4263-1', lat:34.841850, lng:137.730888, accuracy:'B',
    parking:'800台・無料', toilet:'あり（園内施設）',
    access:'新東名浜松SAスマートICから約5分／フルーツパーク駅 徒歩約8分',
    facilities:'サッカー場あり・事前予約制',
    spectator:'施設内の観覧場所・利用ルールに従う',
    caution:'開園時間は原則9:00～17:00。営業・施設利用時間は事前確認',
    sourceUrl:'https://hamamatsu-fp.co.jp/guide/', verifiedAt:'2026-10-07'
  },
  '中部大学スポーツパーク日進G': {
    address:'〒470-0111 愛知県日進市米野木町南山711-1', lat:35.1280, lng:137.0380, accuracy:'A',
    parking:'あり（約30台との案内あり）', toilet:'情報未確認',
    access:'日進市米野木町南山',
    facilities:'人工芝・LED照明完備',
    spectator:'観戦エリアは大会・主催者案内を優先',
    caution:'自家用車利用時は駐車台数に注意',
    sourceUrl:'https://aichi.barcaacademy.com/access.html', verifiedAt:'2026-10-07'
  },
  'まるはスポーツパークG': {
    address:'〒470-2305 愛知県知多郡武豊町下山ノ田64-46', lat:34.860573, lng:136.898262, accuracy:'A',
    parking:'無料駐車場あり（最新案内では普通車46台）', toilet:'あり（クラブハウス）',
    access:'南知多道路 半田ICから約10分／上ゲ駅から約2km',
    facilities:'人工芝サッカーフルコート・フットサル3面・屋根付き観覧席（100名収容）',
    spectator:'屋根付き観覧席あり',
    caution:'2026年内は月曜定休。予約状況・営業時間を事前確認',
    sourceUrl:'https://pfc.or.jp/main/newdetail/22', verifiedAt:'2026-10-07'
  },
  '愛知県森林公園運動広場G': {
    address:'〒488-8555 愛知県尾張旭市大字新居5182-1', lat:35.231903, lng:137.054734, accuracy:'B',
    parking:'あり', toilet:'情報未確認',
    access:'東名守山PA/スマートICから約10分',
    facilities:'愛知県森林公園内の運動施設',
    spectator:'公園内施設の利用ルールに従う',
    caution:'運動広場の利用時間・予約条件は事前確認',
    sourceUrl:'https://www.aichinow.pref.aichi.jp/spots/detail/1474/', verifiedAt:'2026-10-07'
  },
  '守山多目的グランド': {
    address:'〒463-0807 愛知県名古屋市守山区青山台718', lat:35.228050, lng:137.019066, accuracy:'B',
    parking:'情報未確認', toilet:'情報未確認',
    access:'名古屋市守山区青山台',
    facilities:'サッカー活動場所として確認',
    spectator:'観戦場所・駐車方法は主催者案内を優先',
    caution:'周辺道路・近隣施設への迷惑駐車に注意',
    sourceUrl:'https://el-miwa.wixsite.com/el-miwa/blank-6', verifiedAt:'2026-10-07'
  },
  '日進総合公園スポーツ広場G': {
    address:'〒470-0104 愛知県日進市岩藤町大清水919-1', lat:35.147438, lng:137.070553, accuracy:'A',
    parking:'あり', toilet:'あり',
    access:'くるりんばす「総合運動公園西」徒歩約8分',
    facilities:'スポーツ広場・野球場・テニスコート・プール等',
    spectator:'観覧席ありとの施設情報あり',
    caution:'月曜休園（祝日の場合開園）・年末年始休園',
    sourceUrl:'https://www.city.nisshin.lg.jp/kurashi/kyouiku/bunka/sports_shinko/kanren/7214.html', verifiedAt:'2026-10-07'
  }
  , '豊明市大原公園G': {
    address:'愛知県豊明市栄町大原1番地1', lat:35.045812, lng:136.985078, accuracy:'B',
    parking:'一般11台＋身障者用1台（市公式情報）', toilet:'あり',
    access:'名鉄名古屋本線 前後駅から徒歩約18分',
    facilities:'広い芝生広場・公園内の広場。地域の運動会等で利用',
    spectator:'芝生広場での観戦を想定。主催者案内を優先',
    caution:'駐車台数が少ないため、試合時は乗り合わせ等を推奨',
    sourceUrl:'https://www.city.toyoake.lg.jp/4058.htm', verifiedAt:'2026-10-07'
  }
  , 'WACTIVA ANJOグランド(人工芝)': {
    address:'〒446-0061 愛知県安城市新田町稲恵2', lat:34.971714, lng:137.092995, accuracy:'A',
    parking:'70台', toilet:'あり（施設内）',
    access:'名鉄北安城駅から徒歩10分',
    facilities:'屋外人工芝フットサル2面・ソサイチ1面、室内観覧席、屋根付きウッドデッキ、更衣室・シャワー室',
    spectator:'室内観覧席・屋根付きウッドデッキあり',
    caution:'試合形式・コート区分は大会主催者の案内を優先',
    sourceUrl:'https://oasisfc.jp/anjo/', verifiedAt:'2026-10-07'
  }
  , '豊田市五ケ丘運動公園G': {
    address:'〒471-0814 愛知県豊田市五ケ丘6丁目1番地', lat:35.061563, lng:137.19775, accuracy:'A',
    parking:'80台', toilet:'多目的トイレ・乳幼児設備あり',
    access:'おいでんバス「五ケ丘6丁目西」下車徒歩1分',
    facilities:'球技場・多目的広場・マレットゴルフ場。球技場・多目的広場は照明あり',
    spectator:'観戦時は施設の利用ルールと主催者案内を優先',
    caution:'豊田市議会資料では運動広場を2027年4月1日付で廃止予定。大会会場として使用する場合は開催時点の施設状況を確認',
    sourceUrl:'https://www.city.toyota.aichi.jp/shisei/shisetsu/sports/sonohoka/1027986/index.html', verifiedAt:'2026-10-07'
  }
  , '尾張旭市旭ケ丘G': {
    address:'〒488-0085 愛知県尾張旭市旭ケ丘町濁池地内', lat:35.229435, lng:137.039926, accuracy:'B',
    parking:'90台（無料）', toilet:'あり',
    access:'名鉄瀬戸線 尾張旭駅から車で約10分',
    facilities:'運動広場約10,000㎡・サッカー1面・ソフトボール2面・少年野球2面・更衣室',
    spectator:'観戦席の詳細は主催者案内を優先',
    caution:'夜間照明なし。利用時間は3〜9月7:00〜18:00、10〜2月7:00〜17:00',
    sourceUrl:'https://www.hamada-sports.com/owariasahi/shisetsu_asahigaoka', verifiedAt:'2026-10-07'
  }
  , '半田ぴよログスポーツパークG': {
    address:'〒475-0945 愛知県半田市池田町3-1-1', lat:34.899479, lng:136.884034, accuracy:'B',
    parking:'無料167台（多目的グラウンド案内）', toilet:'あり（多目的グラウンド）',
    access:'知多半島道路 半田中央ICから車で約5分',
    facilities:'多目的グラウンド127m×144m、サッカー2面、陸上競技場等',
    spectator:'陸上競技場・公園内施設の観覧ルールを主催者案内に合わせる',
    caution:'大会・イベント時は駐車場混雑が想定されるため、主催者の駐車案内を確認',
    sourceUrl:'https://www.city.handa.lg.jp/bunka/sports/1002825/1002831/1002836.html', verifiedAt:'2026-10-07'
  }
  , '一宮市立小信中島小学校': {
    address:'愛知県一宮市小信中島字南平口59', lat:35.315699, lng:136.747245, accuracy:'A',
    parking:'学校施設のため、試合主催者の案内を確認', toilet:'学校施設のため現地確認',
    access:'名鉄尾西線 奥町駅・玉ノ井駅周辺',
    facilities:'小学校グラウンド',
    spectator:'学校施設利用時の入場・観戦ルールを主催者案内に従う',
    caution:'学校施設のため、校内への立入・駐車は主催者の指示を優先',
    sourceUrl:'https://www.city.ichinomiya.aichi.jp/shisetsu/hoikugakko/1008931/1009257.html', verifiedAt:'2026-10-07'
  }

};

let grounds = {};        // name -> {name, address, lat, lng, accuracy, mapUrl, sourceUrl, updatedAt, matches:[]}
let groundMarkers = {};  // name -> leaflet marker
let unregisteredGroundCandidates = {}; // 試合データにはあるが、会場マスタにない会場名
let provisionalGroundMarkers = {};    // 位置候補を地図上で確認するための仮ピン
let groundsVisible = true;
const GROUND_COLOR = '#1B4B66'; // 淡色地図の背景でも視認しやすい濃紺

function groundIcon(){
  return L.divIcon({
    className: '',
    html: `<div style="width:28px;height:28px;border-radius:7px;background:${GROUND_COLOR};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:14px;">⚽</div>`,
    iconSize: [28,28],
    iconAnchor: [14,14],
  });
}

async function loadGroundsFromSheet(){
  if(!GROUNDS_CSV_URL) return false;
  try{
    const res = await fetch(GROUNDS_CSV_URL, {cache:'no-store'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    const text = await res.text();
    const rows = parseCSV(text);
    const headerIdx = rows.findIndex(r => r.map(c=>String(c).trim()).includes('ground'));
    if(headerIdx === -1) throw new Error('groundsヘッダが見つかりません');
    const header = rows[headerIdx].map(c=>String(c).trim());
    const idx = name => header.indexOf(name);
    const iGround=idx('ground'), iAddress=idx('address'), iLat=idx('lat'), iLng=idx('lng');
    const iAccuracy=idx('accuracy'), iMap=idx('map_url'), iSource=idx('source_url'), iUpdated=idx('updated_at');
    if(iGround < 0 || iLat < 0 || iLng < 0) throw new Error('ground / lat / lng が不足しています');

    grounds = {};
    const skippedGroundRows = [];
    const duplicateGroundNames = [];
    for(let i=headerIdx+1;i<rows.length;i++){
      const r=rows[i]||[];
      const name=String(r[iGround]||'').trim();
      if(!name) continue;
      const rawLat=String(r[iLat]??'').trim();
      const rawLng=String(r[iLng]??'').trim();
      const lat=parseFloat(rawLat);
      const lng=parseFloat(rawLng);
      if(!Number.isFinite(lat) || !Number.isFinite(lng)){
        skippedGroundRows.push({name,lat:rawLat,lng:rawLng,row:i+1});
        continue;
      }
      if(grounds[name]) duplicateGroundNames.push({name,row:i+1});
      const verified = GROUND_VERIFIED_INFO[name] || {};
      grounds[name] = {
        name,
        address: verified.address || (iAddress>=0 ? String(r[iAddress]||'').trim() : ''),
        lat: Number.isFinite(verified.lat) ? verified.lat : lat,
        lng: Number.isFinite(verified.lng) ? verified.lng : lng,
        accuracy: verified.accuracy || (iAccuracy>=0 ? String(r[iAccuracy]||'').trim() : ''),
        mapUrl: iMap>=0 ? String(r[iMap]||'').trim() : '',
        sourceUrl: verified.sourceUrl || (iSource>=0 ? String(r[iSource]||'').trim() : ''),
        updatedAt: verified.verifiedAt || (iUpdated>=0 ? String(r[iUpdated]||'').trim() : ''),
        parking: verified.parking || '', toilet: verified.toilet || '', access: verified.access || '',
        facilities: verified.facilities || '', spectator: verified.spectator || '', caution: verified.caution || '',
        matches: []
      };
    }
    console.log(`grounds loaded: ${Object.keys(grounds).length}`);
    if(skippedGroundRows.length) console.warn('グラウンド地図未プロット（緯度・経度未設定/不正）:', skippedGroundRows);
    if(duplicateGroundNames.length) console.warn('グラウンドマスタの重複名:', duplicateGroundNames);
    return true;  }catch(err){
    console.error('grounds sheet fetch failed', err);
    toast('グラウンド情報の取得に失敗しました');
    return false;
  }
}

// Apps Scriptウェブアプリのデプロイ後URL(書き込み用)。設定するまではローカル保存のみで動作します。
const GROUND_MEMO_WRITE_URL = 'https://script.google.com/macros/s/AKfycbwo1C-XsWwk8l1JRMe0yyWR9jQzVyCoURTiEjzKKCuLM9O775H9vWouCRKoZQNINnfWhA/exec';
// grounds_memo タブを「ウェブに公開」したCSV URL(読み込み用)。設定するまでは自分のブラウザのメモのみ表示されます。
const GROUND_MEMO_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTEA-Qh6qyA6ODIbsqqYmWh7AfABhhpJbpXLi571XVoj86uHFJaWgDYt3vbVKOm9gO3Y9i5Vxjqesub/pub?gid=1404825293&single=true&output=csv';

let groundMemoCache={};const GROUND_MEMO_LOCAL_KEY='ground_memo_posts_v2';function loadGroundMemoPosts(){try{const x=JSON.parse(localStorage.getItem(GROUND_MEMO_LOCAL_KEY)||'{}');Object.keys(x).forEach(k=>groundMemoCache[k]=Array.isArray(x[k])?x[k]:[x[k]]);Object.keys(localStorage).filter(k=>k.indexOf('ground_memo_')===0).forEach(k=>{const n=k.slice(12),v=localStorage.getItem(k)||'';if(v&&!groundMemoCache[n])groundMemoCache[n]=[{date:'',poster:'',memo:v}]})}catch(e){}}function saveGroundMemoPosts(){try{localStorage.setItem(GROUND_MEMO_LOCAL_KEY,JSON.stringify(groundMemoCache))}catch(e){}}async function loadGroundMemosFromSheet(){if(!GROUND_MEMO_CSV_URL){groundMemoCache={};return}try{const r=await fetch(GROUND_MEMO_CSV_URL,{cache:'no-store'});if(!r.ok)throw Error(r.status);const rows=parseCSV(await r.text()),hi=rows.findIndex(r=>r.map(c=>String(c).trim()).includes('ground'));if(hi<0)throw Error('grounds_memo CSVにground列がありません');const h=rows[hi].map(c=>String(c).trim()),ig=h.indexOf('ground'),im=h.indexOf('memo'),id=h.indexOf('date')>=0?h.indexOf('date'):h.indexOf('updated_at'),ip=h.indexOf('poster')>=0?h.indexOf('poster'):h.indexOf('author');if(ig<0||im<0)throw Error('grounds_memo CSVに必須列がありません');const sheetCache={};for(let i=hi+1;i<rows.length;i++){const row=rows[i],n=String(row[ig]||'').trim(),m=String(row[im]||'').trim();if(!n||!m)continue;const p={date:id>=0?String(row[id]||''):'',poster:ip>=0?String(row[ip]||''):'',memo:m},z=sheetCache[n]||(sheetCache[n]=[]);if(!z.some(x=>x.memo===p.memo&&x.date===p.date&&x.poster===p.poster))z.push(p)}groundMemoCache=sheetCache;try{localStorage.removeItem(GROUND_MEMO_LOCAL_KEY);Object.keys(localStorage).filter(k=>k.indexOf('ground_memo_')===0).forEach(k=>localStorage.removeItem(k))}catch(storageError){}saveGroundMemoPosts()}catch(e){groundMemoCache={};console.error('ground memo sheet fetch failed; local memo data ignored',e)}}function getGroundMemoPosts(n){return groundMemoCache[n]||[]}async function addGroundMemoPost(n,m,poster){m=String(m||'').trim();if(!m)return false;const p={date:new Date().toISOString(),poster:String(poster||'').trim(),memo:m};(groundMemoCache[n]||(groundMemoCache[n]=[])).unshift(p);saveGroundMemoPosts();if(!GROUND_MEMO_WRITE_URL)return true;try{await fetch(GROUND_MEMO_WRITE_URL,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'append',ground:n,memo:m,poster:p.poster,date:p.date})});return true}catch(e){return false}}
function groundAccuracyLabel(a){
  const x=(a||'').toString().trim().toUpperCase();
  return ({A:'正確な場所',B:'公式活動場所・主会場',C:'市町村・地域の代表地点',D:'位置未確認'})[x] || '未設定';
}
function groundAccuracyBadge(a){
  const x=(a||'').toString().trim().toUpperCase();
  const cls=['A','B','C','D'].includes(x) ? x : 'D';
  return `<span class="accuracy-badge accuracy-${cls}">${escapeHtml(x || '?')}</span>`;
}
function groundMarkerOpacity(g){
  const a=(g.accuracy||'').trim().toUpperCase();
  return a==='A' ? 1 : a==='B' ? 0.9 : a==='C' ? 0.68 : a==='D' ? 0.45 : 0.8;
}

function groundPopupHtml(g){
  const matches = matchesForGrade(g.matches).slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const wins=matches.filter(m=>m.result==='勝').length, draws=matches.filter(m=>m.result==='分').length, loses=matches.filter(m=>m.result==='敗').length;
  const rows=matches.map(m=>{
    const opponent=m.opponent||'';
    const op=opponent ? `<a href="#" data-team-link="${escapeHtml(opponent)}" style="color:#2563EB;text-decoration:none;font-weight:600;">${escapeHtml(opponent)}</a>` : '-';
    return `<div class="precord-row"><span>${escapeHtml(m.date||'')}${m.category?' '+escapeHtml(m.category):''}</span><span class="pmono">vs ${op}</span><span>${escapeHtml(m.score||'')} ${escapeHtml(m.result||'')}</span></div>`;
  }).join('');
  let otherGradeGroundBlock='';
  if(showOtherGrades){
    const rs=GRADE_OPTIONS.filter(gr=>gr!==currentGrade).map(gr=>{
      const ms=(g.matches||[]).filter(m=>(m.category||'').trim()===gr);
      return ms.length ? `<div class="precord-row"><span>${escapeHtml(gr)}（${escapeHtml(GRADE_LABELS[gr])}）</span><span>全${ms.length}試合</span><span></span></div>`:'';
    }).filter(Boolean).join('');
    if(rs) otherGradeGroundBlock=`<div class="precord"><div class="precord-title">他学年の会場実績</div>${rs}</div>`;
  }
  const memoPosts=getGroundMemoPosts(g.name).slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const memoRows=memoPosts.map(x=>'<div class="ground-memo-post"><div class="ground-memo-meta">'+escapeHtml(x.date?new Date(x.date).toLocaleDateString('ja-JP'):'')+(x.poster?' ・ '+escapeHtml(x.poster):'')+'</div><div>'+escapeHtml(x.memo)+'</div></div>').join('');
  const groundMapLink=g.mapUrl
    ? `<div class="popup-actions"><a href="${escapeHtml(g.mapUrl)}" target="_blank" rel="noopener" class="popup-action primary">📍 Google Mapsで開く</a></div>`
    : `<div class="popup-actions"><a href="https://www.google.com/maps/search/?api=1&query=${g.lat},${g.lng}" target="_blank" rel="noopener" class="popup-action primary">📍 Google Mapsで開く</a></div>`;
  const address=g.address?escapeHtml(g.address):'住所情報なし', accuracy=(g.accuracy||'').trim().toUpperCase();
  const sourceLink=g.sourceUrl?`<a href="${escapeHtml(g.sourceUrl)}" target="_blank" rel="noopener">情報元を確認</a>`:'';
  const infoRows=[['駐車場',g.parking],['トイレ',g.toilet],['アクセス',g.access],['施設',g.facilities],['観戦',g.spectator],['注意',g.caution]].filter(x=>x[1]).map(x=>`<div class="ground-info-row"><span class="ground-info-label">${x[0]}</span><span>${escapeHtml(x[1])}</span></div>`).join('');
  const verifiedCount=[g.address,g.parking,g.toilet,g.access,g.facilities,g.spectator,g.caution].filter(Boolean).length;
  const summary=matches.length?`<div class="match-summary"><div class="match-stat"><b>${wins}</b><span>勝</span></div><div class="match-stat"><b>${draws}</b><span>分</span></div><div class="match-stat"><b>${loses}</b><span>敗</span></div><div class="match-stat"><b>${matches.length}</b><span>試合</span></div></div>`:'';
  const quick=`<div class="ground-quick">${g.parking?`<span class="ground-chip">🚗 <b>${escapeHtml(g.parking)}</b></span>`:''}${g.toilet?`<span class="ground-chip">🚻 <b>${escapeHtml(g.toilet)}</b></span>`:''}${g.access?`<span class="ground-chip">🚉 <b>${escapeHtml(g.access)}</b></span>`:''}</div>`;
  const hint=matches.length?'<div style="font-size:10.5px;color:#64748B;margin:4px 0 6px;">対戦相手・会場名をタップすると相互に移動できます。</div>':'';
  return `<b>⚽ ${escapeHtml(g.name)}</b>
    <div class="ground-info">
      <div class="ground-info-row"><span class="ground-info-label">位置精度</span><span>${groundAccuracyBadge(accuracy)}<span class="accuracy-desc">${escapeHtml(groundAccuracyLabel(accuracy))}</span></span></div>
      <div class="ground-info-row"><span class="ground-info-label">住所</span><span>${address}</span></div>
      ${quick}
      ${infoRows}
      <div class="ground-info-row"><span class="ground-info-label">情報充実度</span><span>${verifiedCount}/7項目</span></div>
      ${g.updatedAt?`<div class="ground-info-row"><span class="ground-info-label">最終確認</span><span>${escapeHtml(g.updatedAt)}</span></div>`:''}
      ${sourceLink?`<div class="ground-source">${sourceLink}</div>`:''}
    </div>
    <div class="precord">
      <div class="precord-title">この会場の観戦履歴（${escapeHtml(GRADE_LABELS[currentGrade]||currentGrade)}）</div>
      ${summary}${hint}
      ${rows||'<div style="font-size:11px;color:#5A6472;">この学年の試合記録はありません</div>'}
    </div>
    ${otherGradeGroundBlock}
    <div class="ground-memo-section"><div class="precord-title">みんなの観戦メモ ${memoPosts.length?'('+memoPosts.length+'件)':''}</div>${memoRows||'<div style="font-size:11px;color:#5A6472;">まだ投稿はありません</div>'}<textarea class="ground-memo-input" placeholder="駐車場・アクセス・観戦場所などを投稿" style="width:100%;min-height:50px;font-size:11px;padding:5px;border:1px solid #DDD8CB;border-radius:4px;box-sizing:border-box;margin-top:5px;"></textarea><input class="ground-memo-poster" placeholder="投稿者（任意）" style="width:100%;font-size:11px;padding:5px;border:1px solid #DDD8CB;border-radius:4px;box-sizing:border-box;margin-top:4px;"><button class="btn btn-sm btn-primary" data-act="add-ground-memo" style="margin-top:4px;width:100%;">メモを投稿</button></div>
    ${groundMapLink}`;
}

function groundHasCurrentGradeMatches(g){
  return matchesForGrade(g.matches).length > 0;
}
function groundHasOtherGradeMatches(g){
  return matchesForOtherGrades(g.matches).length > 0;
}

function applyGroundGradeFilter(){
  const groundList = Object.values(grounds);
  // 選択年度・学年に一致する会場が1件もない場合でも、会場マスタのピンを消さない。
  // 戦績データ未取得や場所名の不一致があっても、グラウンド検索・確認を継続できるようにする。
  const hasFilteredGrounds = groundList.some(g =>
    groundHasCurrentGradeMatches(g) || (showOtherGrades && groundHasOtherGradeMatches(g))
  );
  if(groundsVisible && !hasFilteredGrounds && groundList.length){
    console.warn('選択年度・学年に一致する試合会場がありません。登録済みグラウンドを全件表示します。');
  }
  groundList.forEach(g=>{
    const marker = groundMarkers[g.name];
    if(!marker) return;
    const hasMatch = groundHasCurrentGradeMatches(g) || (showOtherGrades && groundHasOtherGradeMatches(g));
    const shouldShow = groundsVisible && (!hasFilteredGrounds || hasMatch);
    const onMap = map.hasLayer(marker);
    if(shouldShow && !onMap) marker.addTo(map);
    if(!shouldShow && onMap) map.removeLayer(marker);
  });
}

function clearGroundFocus(){
  Object.values(groundMarkers).forEach(m=>{
    const tt=m.getTooltip && m.getTooltip();
    const el=tt && tt.getElement && tt.getElement();
    if(el) el.classList.remove('ground-label-selected');
  });
  document.body.classList.remove('ground-focus');
}
function focusGroundLabel(name){
  clearGroundFocus();
  const marker=groundMarkers[name];
  if(!marker) return;
  const tt=marker.getTooltip && marker.getTooltip();
  const el=tt && tt.getElement && tt.getElement();
  if(el){
    document.body.classList.add('ground-focus');
    el.classList.add('ground-label-selected');
  }
}
function renderGroundMarker(g){
  const marker = L.marker([g.lat, g.lng], { icon: groundIcon(), riseOnHover:true, autoPanOnFocus:true });
  marker.setOpacity(groundMarkerOpacity(g));
  marker.bindPopup(groundPopupHtml(g), { maxWidth: 340, minWidth: 250, className:'ground-popup', autoPan:true, autoPanPaddingTopLeft:[12,72], autoPanPaddingBottomRight:[12,24] });
  const acc=(g.accuracy||'').trim().toUpperCase();
  marker.bindTooltip(`${g.name}${acc ? ' ['+acc+']' : ''}`, { permanent:true, direction:'top', offset:[0,-12], className:'name-label ground-label' });
  marker.on('click', ()=>{ focusGroundLabel(g.name); });
  marker.on('popupopen', (e)=>{
    const container = e.popup.getElement();
    const btn = container.querySelector('[data-act="add-ground-memo"]');container.querySelectorAll('[data-team-link]').forEach(el=>el.onclick=ev=>{ev.preventDefault();openTeamByName(el.dataset.teamLink)});
    const ta=container.querySelector('.ground-memo-input'),po=container.querySelector('.ground-memo-poster');if(btn&&ta)btn.addEventListener('click',async()=>{btn.disabled=true;const ok=await addGroundMemoPost(g.name,ta.value,po?po.value:'');btn.disabled=false;if(ok){marker.setPopupContent(groundPopupHtml(g));marker.openPopup();toast('メモを投稿しました')}else toast('メモの投稿に失敗しました')})
  });
  // 表示対象の判定は一括フィルタ側に集約し、学年切替時の表示漏れを防ぐ。
  if(groundsVisible) marker.addTo(map);
  groundMarkers[g.name] = marker;
}

function upsertGroundMatch(placeName, info){
  const g = grounds[placeName];
  if(!g){
    const name=String(placeName||'').trim();
    if(name){
      const item=unregisteredGroundCandidates[name]||(unregisteredGroundCandidates[name]={name,matches:[]});
      if(info && !item.matches.some(m=>m.date===info.date&&m.opponent===info.opponent&&m.score===info.score)) item.matches.push(info);
    }
    return false;
  }
  const key = [info.date, info.opponent, info.score, info.result].join('|');
  if(g.matches.some(m => [m.date,m.opponent,m.score,m.result].join('|') === key)) return true;
  g.matches.push(info);
  return true;
}


/* ---------------- 未登録会場の検出と仮プロット ---------------- */
// 座標はOSM/Nominatimの検索候補。マスタには書き込まず、確認用の仮ピンとしてのみ表示する。
function rebuildGroundMatchLinksAndFindUnknowns(){
  unregisteredGroundCandidates = {};
  Object.values(grounds).forEach(g=>{ g.matches=[]; });
  (Array.isArray(points)?points:[]).forEach(p=>{
    (Array.isArray(p.matches)?p.matches:[]).forEach(m=>{
      const place=String(m.place||m.venue||m.ground||'').trim();
      if(!place) return;
      const info={date:m.date||'',category:m.category||'',opponent:p.name||'',score:m.score||'',result:m.result||''};
      if(grounds[place]) upsertGroundMatch(place,info);
      else upsertGroundMatch(place,info);
    });
  });
}
function addUpcomingGroundCandidates(matches){
  const normalize=value=>String(value||'').normalize('NFKC').replace(/[\\s\\u3000]+/g,'').toLowerCase();
  const knownNames=Object.keys(grounds).map(normalize);
  let scanned=0;
  (Array.isArray(matches)?matches:[]).forEach(match=>{
    const venue=[match.venue,match.groundName,match.ground,match.location,match.place,match.field,match.stadium,match.会場,match.グラウンド]
      .find(value=>typeof value==='string'&&value.trim());
    const name=String(venue||'').trim();
    if(!name) return;
    scanned++;
    if(knownNames.some(known=>known===normalize(name)||known.includes(normalize(name))||normalize(name).includes(known))) return;
    const item=unregisteredGroundCandidates[name]||(unregisteredGroundCandidates[name]={name,matches:[]});
    const info={date:match.date||'',category:match.category||'',opponent:match.title||match.name||'',score:'',result:''};
    if(!item.matches.some(m=>m.date===info.date&&m.category===info.category&&m.opponent===info.opponent)) item.matches.push(info);
  });
  console.info('公式試合予定からの未登録会場検出:',{scheduleRows:(Array.isArray(matches)?matches.length:0),venueRows:scanned,unknown:Object.keys(unregisteredGroundCandidates).length});
  return scanned;
}

async function discoverUnregisteredGroundsFromPublishedCsv(){
  if(typeof ALL_GRADES_CSV_URL==='undefined' || typeof parseCSV!=='function') return {ok:false,reason:'試合CSV設定がありません'};
  try{
    const response=await fetch(ALL_GRADES_CSV_URL,{cache:'no-store'});
    if(!response.ok) throw new Error('CSV HTTP '+response.status);
    const rows=parseCSV(await response.text());
    const headerIndex=rows.findIndex(row=>
      (row.includes('日付')&&row.includes('FC名')) ||
      ((row.includes('team')||row.includes('チーム名'))&&(row.includes('date')||row.includes('日付')))
    );
    if(headerIndex<0) throw new Error('会場検出用のヘッダー行が見つかりません');
    const header=rows[headerIndex].map(v=>String(v||'').trim());
    const index=(names)=>names.map(name=>header.indexOf(name)).find(i=>i>=0)??-1;
    const venueIndex=header.includes('日付')&&header.includes('FC名')
      ? header.indexOf('場所')
      : index(['place','venue','ground','場所','会場','グラウンド']);
    const teamIndex=header.includes('日付')&&header.includes('FC名')
      ? header.indexOf('FC名')
      : index(['team','チーム名']);
    const dateIndex=header.includes('日付')&&header.includes('FC名')?header.indexOf('日付'):index(['date','日付']);
    const categoryIndex=header.includes('日付')&&header.includes('FC名')?header.indexOf('カテゴリ'):index(['category','カテゴリ']);
    if(venueIndex<0){
      console.warn('未登録会場の自動検出: 試合CSVに会場列がありません。ヘッダー:',header);
      return {ok:true,venueColumn:false,rows:Math.max(0,rows.length-headerIndex-1),uniqueVenues:0,unknown:0};
    }
    const norm=value=>String(value||'').normalize('NFKC').replace(/[\\s\\u3000]+/g,'').toLowerCase();
    const masterNames=new Set(Object.keys(grounds).map(norm));
    let scanned=0;
    for(let i=headerIndex+1;i<rows.length;i++){
      const row=rows[i]||[];
      const name=String(row[venueIndex]||'').trim();
      if(!name) continue;
      scanned++;
      if(masterNames.has(norm(name))) continue;
      const candidate=unregisteredGroundCandidates[name]||(unregisteredGroundCandidates[name]={name,matches:[]});
      const sample={date:dateIndex>=0?String(row[dateIndex]||''):'',category:categoryIndex>=0?String(row[categoryIndex]||''):'',opponent:teamIndex>=0?String(row[teamIndex]||''):'',score:'',result:''};
      if(!candidate.matches.some(m=>m.date===sample.date&&m.category===sample.category&&m.opponent===sample.opponent)) candidate.matches.push(sample);
    }
    const result={ok:true,venueColumn:true,venueRows:scanned,uniqueVenues:new Set(rows.slice(headerIndex+1).map(row=>String((row||[])[venueIndex]||'').trim()).filter(Boolean)).size,unknown:Object.keys(unregisteredGroundCandidates).length};
    console.info('公開試合CSVからの未登録会場検出:',result);
    return result;
  }catch(error){
    console.warn('公開試合CSVからの未登録会場検出に失敗:',error);
    return {ok:false,reason:String(error)};
  }
}

function provisionalGroundIcon(){
  return L.divIcon({className:'',html:'<div style="width:27px;height:27px;border-radius:50%;background:#D97706;border:2px dashed #fff;box-shadow:0 1px 4px rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-size:14px;">?</div>',iconSize:[27,27],iconAnchor:[13,13]});
}
async function plotUnregisteredGroundCandidates(maxSearches=15){
  Object.values(provisionalGroundMarkers).forEach(marker=>map.removeLayer(marker));
  provisionalGroundMarkers={};
  const candidates=Object.values(unregisteredGroundCandidates).filter(x=>!grounds[x.name]).sort((a,b)=>(b.matches||[]).length-(a.matches||[]).length).slice(0,maxSearches);
  if(!candidates.length){
    console.info('未登録会場: 0件（会場列のある試合データを走査した結果、未登録会場がありません）');
    return;
  }
  console.info('未登録会場候補:',candidates.map(x=>({name:x.name,matches:x.matches.length})));
  let plotted=0, unresolved=[];
  for(const item of candidates){
    try{
      const url='https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=jp&q='+encodeURIComponent(item.name);
      const response=await fetch(url,{headers:{Accept:'application/json'},cache:'no-store'});
      if(!response.ok) throw new Error('HTTP '+response.status);
      const results=await response.json();
      const result=(Array.isArray(results)?results:[]).find(x=>{
        const cls=String(x.class||'').toLowerCase(), type=String(x.type||'').toLowerCase();
        return cls==='leisure' || cls==='sport' || cls==='amenity' && /school|university|college|park|sports_centre|stadium/.test(type) || /pitch|sports_centre|stadium|school|park|ground/.test(type);
      });
      if(!result){unresolved.push(item.name);continue;}
      const lat=Number(result.lat),lng=Number(result.lon);
      if(!Number.isFinite(lat)||!Number.isFinite(lng)){unresolved.push(item.name);continue;}
      const marker=L.marker([lat,lng],{icon:provisionalGroundIcon(),riseOnHover:true});
      const mapSearch='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(item.name);
      marker.bindPopup('<b>？ 未登録会場（位置候補）</b><div style="margin-top:5px;font-weight:600;">'+escapeHtml(item.name)+'</div><div style="font-size:11px;margin-top:5px;">試合データでの登場 '+item.matches.length+'件</div><div style="font-size:11px;color:#92400E;margin-top:5px;">地図検索の候補です。正しい会場か確認してから、会場マスタへ登録してください。</div><div style="font-size:11px;margin-top:6px;">候補: '+escapeHtml(result.display_name||'')+'</div><a href="'+mapSearch+'" target="_blank" rel="noopener">Googleマップで確認</a>',{maxWidth:320});
      marker.bindTooltip(item.name+'［未登録・位置候補］',{permanent:true,direction:'top',offset:[0,-10],className:'name-label'});
      if(groundsVisible) marker.addTo(map);
      provisionalGroundMarkers[item.name]=marker;
      plotted++;
    }catch(error){
      unresolved.push(item.name);
      console.warn('未登録会場の位置候補取得に失敗:',item.name,error);
    }
    // Nominatimの公開サービスに負荷をかけないよう、検索間隔を空ける。
    await new Promise(resolve=>setTimeout(resolve,1100));
  }
  console.info('未登録会場の仮プロット結果:',{detected:candidates.length,plotted,unresolved,limit:maxSearches});
  if(plotted && typeof scheduleGroundCenter==='function') scheduleGroundCenter();
  if(Object.keys(unregisteredGroundCandidates).length>maxSearches){
    console.warn('未検索の未登録会場があります。検出件数:',Object.keys(unregisteredGroundCandidates).length,'今回検索上限:',maxSearches);
  }
}

function refreshGroundMarkers(){
  Object.values(groundMarkers).forEach(m=> map.removeLayer(m));
  groundMarkers = {};
  Object.values(grounds).forEach(g=> renderGroundMarker(g));
  applyGroundGradeFilter();
}
const groundModeHint=document.getElementById('groundModeHint');
if(groundModeHint) groundModeHint.addEventListener('click',()=>{
  const focused=document.body.classList.toggle('ground-focus');
  if(!focused){ clearGroundFocus(); return; }
  const first=Object.values(grounds).find(g=>map.hasLayer(groundMarkers[g.name]));
  if(first) focusGroundLabel(first.name);
});


