/* ---------------- Google Sheets (published CSV) live source ---------------- */
// data タブ（元シート形式：日付・カテゴリ・自チームスコア・相手チームスコア・勝敗・FC名 等）
const MATCHES_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTEA-Qh6qyA6ODIbsqqYmWh7AfABhhpJbpXLi571XVoj86uHFJaWgDYt3vbVKOm9gO3Y9i5Vxjqesub/pub?gid=0&single=true&output=csv';
// 全学年データ タブ（シンプル形式：team,date,category,score,result）
const ALL_GRADES_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTEA-Qh6qyA6ODIbsqqYmWh7AfABhhpJbpXLi571XVoj86uHFJaWgDYt3vbVKOm9gO3Y9i5Vxjqesub/pub?gid=1256248240&single=true&output=csv';

function parseCSV(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if(c === '"') inQuotes = true;
      else if(c === ','){ row.push(field); field = ''; }
      else if(c === '\n' || c === '\r'){
        if(c === '\r' && text[i+1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += c;
    }
  }
  if(field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length===1 && r[0]===''));
}

async function fetchAndImportCsv(url){
  const res = await fetch(url, {cache:'no-store'});
  if(!res.ok) throw new Error('HTTP '+res.status);
  const text = await res.text();
  const rows = parseCSV(text);
  importRows(rows);
}

async function loadMatchesFromSheet({silent=false} = {}){
  let ok = true;
  if(MATCHES_CSV_URL){
    try{ await fetchAndImportCsv(MATCHES_CSV_URL); }
    catch(err){ console.error('data タブの取得に失敗', err); ok = false; }
  }
  if(ALL_GRADES_CSV_URL){
    try{ await fetchAndImportCsv(ALL_GRADES_CSV_URL); }
    catch(err){ console.error('全学年データ タブの取得に失敗', err); ok = false; }
  }
  if(!ok && !silent) toast('Google Sheetsからの読み込みに失敗しました');
  return ok;
}



/* ---------------- FC SIRIUS upcoming fixtures (Google Apps Script JSONP) ---------------- */
// Code.gsをウェブアプリとしてデプロイし、ここに /exec URLを設定してください。
const SIRIUS_UPCOMING_API_URL = 'https://script.google.com/macros/s/AKfycbwo1C-XsWwk8l1JRMe0yyWR9jQzVyCoURTiEjzKKCuLM9O775H9vWouCRKoZQNINnfWhA/exec';
let siriusUpcomingMatches = [];

function loadSiriusUpcomingMatches(){
  if(!SIRIUS_UPCOMING_API_URL || SIRIUS_UPCOMING_API_URL.indexOf('/exec') < 0 || SIRIUS_UPCOMING_API_URL.startsWith('PASTE_')){
    console.warn('SIRIUS予定取得: SIRIUS_UPCOMING_API_URL が未設定です');
    renderSiriusUpcomingPanel({ok:false,error:'予定取得APIが未設定です'});
    return Promise.resolve(false);
  }
  return new Promise(resolve=>{
    const callbackName = '__siriusUpcomingCallback_' + Date.now() + '_' + Math.floor(Math.random()*100000);
    const script = document.createElement('script');
    let finished = false;
    const cleanup = ()=>{
      if(script.parentNode) script.parentNode.removeChild(script);
      try{ delete window[callbackName]; }catch(_){ window[callbackName] = undefined; }
    };
    const timer = setTimeout(()=>{
      if(finished) return;
      finished = true; cleanup();
      renderSiriusUpcomingPanel({ok:false,error:'公式サイトの予定取得がタイムアウトしました'});
      resolve(false);
    },15000);
    window[callbackName] = payload=>{
      if(finished) return;
      finished = true; clearTimeout(timer); cleanup();
      if(payload && payload.ok && Array.isArray(payload.matches)){
        siriusUpcomingMatches = payload.matches;
        renderSiriusUpcomingPanel(payload);
        resolve(true);
      }else{
        renderSiriusUpcomingPanel({ok:false,error:(payload&&payload.error)||'予定を取得できませんでした'});
        resolve(false);
      }
    };
    script.onerror = ()=>{
      if(finished) return;
      finished = true; clearTimeout(timer); cleanup();
      renderSiriusUpcomingPanel({ok:false,error:'予定取得APIに接続できませんでした'});
      resolve(false);
    };
    script.src = SIRIUS_UPCOMING_API_URL + (SIRIUS_UPCOMING_API_URL.includes('?')?'&':'?') +
      'callback=' + encodeURIComponent(callbackName) + '&_=' + Date.now();
    document.head.appendChild(script);
  });
}

let siriusUpcomingPayload = null;

function normalizeUpcomingGrade(value){
  const text = String(value || '').toUpperCase()
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000]/g,'')
    .replace(/[‐‑‒–—−]/g,'-');
  const match = text.match(/U-?(\d{1,2})/);
  if(match) return 'U-' + Number(match[1]);

  // 日本語の学年表記もU学年へ統一（1年生＝U-7、6年生＝U-12）。
  const yearMatch = text.match(/([1-6一二三四五六])年生?/);
  if(yearMatch){
    const yearMap = {'1':7,'2':8,'3':9,'4':10,'5':11,'6':12,'一':7,'二':8,'三':9,'四':10,'五':11,'六':12};
    return 'U-' + yearMap[yearMatch[1]];
  }
  if(/園児|年少|年中|年長|幼児/.test(text)) return 'U-6';
  return text;
}

// 複数学年表記・全角数字・日本語学年表記をまとめて抽出する。
function normalizeUpcomingGrades(value){
  const text = String(value || '').toUpperCase()
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000]/g,'')
    .replace(/[‐‑‒–—−]/g,'-');
  const grades = (text.match(/U-?\d{1,2}/g) || []).map(match => normalizeUpcomingGrade(match));

  // U-6.7 / U6・7 / U-6/U-7 などの複数学年表記を吸収する。
  const shorthandPattern = /U-?(\d{1,2})[.・\/、,＋+&](\d{1,2})(?!\d)/g;
  let shorthand;
  while((shorthand = shorthandPattern.exec(text)) !== null){
    grades.push('U-' + Number(shorthand[1]), 'U-' + Number(shorthand[2]));
  }

  // 1年生、１年生、一年生などの表記をU学年へ変換する。
  const yearPattern = /([1-6一二三四五六])年生?/g;
  let year;
  const yearMap = {'1':7,'2':8,'3':9,'4':10,'5':11,'6':12,'一':7,'二':8,'三':9,'四':10,'五':11,'六':12};
  while((year = yearPattern.exec(text)) !== null){
    grades.push('U-' + yearMap[year[1]]);
  }
  if(/園児|年少|年中|年長|幼児/.test(text)) grades.push('U-6');

  return grades.length ? [...new Set(grades)] : [normalizeUpcomingGrade(value)];
}
function parseUpcomingDate(value){
  const text = String(value || '').trim();
  let match = text.match(/(\d{4})[\/年.-]\s*(\d{1,2})[\/月.-]\s*(\d{1,2})/);
  if(!match) return null;
  const date = new Date(Number(match[1]), Number(match[2])-1, Number(match[3]));
  if(date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2])-1 || date.getDate() !== Number(match[3])) return null;
  date.setHours(0,0,0,0);
  return date;
}

function upcomingDateLabel(value){
  const date = parseUpcomingDate(value);
  if(!date) return {key:'unknown',main:value || '日付未定',sub:''};
  const now = new Date();
  now.setHours(0,0,0,0);
  const days = Math.round((date.getTime()-now.getTime())/86400000);
  const weekday = ['日','月','火','水','木','金','土'][date.getDay()];
  let relative = '';
  if(days === 0) relative = '今日';
  else if(days === 1) relative = '明日';
  else if(days > 1) relative = 'あと' + days + '日';
  else relative = Math.abs(days) + '日前';
  return {
    key: date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0'),
    main: (date.getMonth()+1) + '/' + date.getDate() + '（' + weekday + '）',
    sub: relative,
    days: days
  };
}

function focusUpcomingVenue(venue){
  const normalize = value => String(value || '').replace(/[\s\u3000]/g,'').replace(/[（）]/g, c => c === '（' ? '(' : ')').toLowerCase();
  const target = normalize(venue);
  const ground = typeof grounds !== 'undefined' ? Object.values(grounds).find(g => {
    const name = normalize(g.name);
    return name && (name === target || name.includes(target) || target.includes(name));
  }) : null;
  const marker = ground && typeof groundMarkers !== 'undefined' ? groundMarkers[ground.name] : null;
  if(ground && marker && typeof map !== 'undefined'){
    map.flyTo([ground.lat,ground.lng],Math.max(map.getZoom(),15));
    marker.openPopup();
  }else{
    window.open('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(venue),'_blank','noopener');
  }
}

function renderSiriusUpcomingPanel(payload){
  siriusUpcomingPayload = payload || null;
  let panel = document.getElementById('siriusUpcomingPanel');
  if(!panel){
    panel = document.createElement('section');
    panel.id = 'siriusUpcomingPanel';
    panel.setAttribute('aria-label','FC SIRIUS今後の試合予定');
    panel.style.cssText = 'position:fixed;z-index:1200;right:10px;bottom:10px;width:min(420px,calc(100vw - 20px));max-height:min(68vh,600px);overflow:hidden;background:#fff;color:#1f2937;border:1px solid #cbd5e1;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.22);font:14px/1.45 system-ui,-apple-system,sans-serif;';
    document.body.appendChild(panel);
  }

  const allMatches = payload && payload.ok && Array.isArray(payload.matches) ? payload.matches : [];
  const selectedGrade = typeof currentGrade !== 'undefined' ? currentGrade : '';
  const gradeMatches = allMatches.filter(m => normalizeUpcomingGrades([m.category,m.title,m.team,m.name,m.description].filter(Boolean).join(' ')).includes(normalizeUpcomingGrade(selectedGrade)));
  const sortedMatches = gradeMatches.slice().sort((a,b) => {
    const da = parseUpcomingDate(a.date), db = parseUpcomingDate(b.date);
    if(da && db) return da - db || String(a.time||'').localeCompare(String(b.time||''));
    if(da) return -1;
    if(db) return 1;
    return String(a.date||'').localeCompare(String(b.date||''));
  });
  const visibleMatches = sortedMatches.slice(0,30);
  const header = '<button type="button" id="siriusUpcomingToggle" aria-expanded="true" style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;border:0;background:#123b65;color:white;padding:11px 13px;font-weight:700;text-align:left;cursor:pointer"><span style="min-width:0">⚽ 直近の試合予定 <span style="font-size:12px;font-weight:500;opacity:.9">' + escapeHtml(selectedGrade ? (GRADE_LABELS[selectedGrade] || selectedGrade) : '') + '</span><span style="display:block;font-size:11px;font-weight:500;opacity:.85;margin-top:2px">' + visibleMatches.length + '件表示' + (gradeMatches.length > visibleMatches.length ? '（全' + gradeMatches.length + '件）' : '') + '</span></span><span id="siriusUpcomingArrow" aria-hidden="true">▾</span></button>';

  let body = '';
  if(!payload || !payload.ok){
    body = '<div style="padding:14px;color:#9a3412">' + escapeHtml(payload && payload.error ? payload.error : '予定を取得できませんでした') + '<div style="font-size:12px;margin-top:6px">設定と公式サイトの公開状態を確認してください。</div></div>';
  }else if(allMatches.length === 0){
    body = '<div style="padding:14px;color:#64748b">現在、取得できる今後の試合予定はありません。</div>';
  }else if(gradeMatches.length === 0){
    body = '<div style="padding:14px;color:#64748b"><strong>' + escapeHtml(GRADE_LABELS[selectedGrade] || selectedGrade) + 'の予定は見つかりませんでした。</strong><div style="margin-top:5px;font-size:12px">上部の学年フィルタを切り替えると、予定も連動して切り替わります。</div></div>';
  }else{
    const groups = [];
    const groupMap = {};
    visibleMatches.forEach(m => {
      const info = upcomingDateLabel(m.date);
      const key = info.key;
      if(!groupMap[key]){
        groupMap[key] = {info:info,matches:[]};
        groups.push(groupMap[key]);
      }
      groupMap[key].matches.push(m);
    });
    body = '<div id="siriusUpcomingBody" style="overflow:auto;max-height:min(58vh,520px);padding:8px 10px 10px;-webkit-overflow-scrolling:touch">';
    body += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:0 2px 7px;color:#64748b;font-size:11px"><span>日付ごとに表示・学年フィルタ連動</span><span>' + gradeMatches.length + '試合</span></div>';
    groups.forEach(group => {
      body += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:9px 1px 4px;padding:0 2px"><strong style="font-size:13px;color:#334155">' + escapeHtml(group.info.main) + '</strong><span style="font-size:10px;color:' + (group.info.days >= 0 && group.info.days <= 2 ? '#b45309' : '#64748b') + ';font-weight:700">' + escapeHtml(group.info.sub || '') + ' · ' + group.matches.length + '試合</span></div>';
      group.matches.forEach(m => {
        const category = normalizeUpcomingGrades([m.category,m.title,m.team,m.name,m.description].filter(Boolean).join(' ')).includes(normalizeUpcomingGrade(selectedGrade)) ? selectedGrade : (m.category || selectedGrade);
        body += '<article style="padding:9px 10px;margin-bottom:6px;border:1px solid #e2e8f0;border-radius:10px;background:' + (group.info.days >= 0 && group.info.days <= 2 ? '#fffaf0' : '#fff') + ';border-left:3px solid ' + (group.info.days === 0 ? '#dc2626' : (group.info.days >= 0 && group.info.days <= 2 ? '#d97706' : '#cbd5e1')) + '">';
        body += '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">';
        if(m.time) body += '<strong style="font-size:12px;color:#334155">' + escapeHtml(m.time) + '</strong>';
        body += '<span style="font-size:10px;background:#e0f2fe;color:#075985;padding:2px 7px;border-radius:99px">' + escapeHtml(category) + '</span>';
        if(group.info.days === 0) body += '<span style="font-size:10px;background:#fee2e2;color:#991b1b;padding:2px 7px;border-radius:99px">今日</span>';
        else if(group.info.days === 1) body += '<span style="font-size:10px;background:#ffedd5;color:#9a3412;padding:2px 7px;border-radius:99px">明日</span>';
        body += '</div>';
        body += '<div style="font-size:13px;font-weight:700;margin-top:5px;line-height:1.4;overflow-wrap:anywhere">' + escapeHtml(m.title || '試合予定') + '</div>';
        if(m.venue){
          body += '<button type="button" data-upcoming-venue="' + escapeHtml(m.venue) + '" style="display:block;text-align:left;margin-top:6px;padding:0;border:0;background:transparent;color:#2563eb;font-size:12px;cursor:pointer;overflow-wrap:anywhere">📍 ' + escapeHtml(m.venue) + '　›</button>';
        }
        if(m.sourceUrl) body += '<div style="margin-top:5px;font-size:11px"><a href="' + escapeHtml(m.sourceUrl) + '" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:none">公式ページを見る ↗</a></div>';
        body += '</article>';
      });
    });
    if(gradeMatches.length > visibleMatches.length) body += '<div style="padding:8px;text-align:center;color:#64748b;font-size:11px">表示は直近30件までです。</div>';
    body += '</div>';
  }

  panel.innerHTML = header + '<div id="siriusUpcomingContent">' + body + '</div>';
  const toggle = panel.querySelector('#siriusUpcomingToggle');
  toggle.addEventListener('click',()=>{
    const content = panel.querySelector('#siriusUpcomingContent');
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded',String(!isOpen));
    content.style.display = isOpen ? 'none' : 'block';
    const arrow = panel.querySelector('#siriusUpcomingArrow');
    if(arrow) arrow.textContent = isOpen ? '▸' : '▾';
  });
  panel.querySelectorAll('[data-upcoming-venue]').forEach(button=>{
    button.addEventListener('click',()=>focusUpcomingVenue(button.getAttribute('data-upcoming-venue') || ''));
  });
}
/* ---------------- smart file import (Excel/CSV, points or matches) ---------------- */
const RESULT_MAP = { Win:'勝', Lose:'敗', Draw:'分', 勝:'勝', 敗:'敗', 分:'分' };

function normalizeDateStr(s){
  s = (s||'').trim();
  let m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return s;
}

function normalizeForMatch(s){
  return (s||'').replace(/\s+/g,'').toLowerCase();
}

// シート側の入力ゆれ・誤字を、地図側の正式名称に読み替えるための対応表
const TEAM_NAME_ALIASES = {
  'FC golazo goi一宮': 'FC golazo gol一宮',
  'RED BAZZ': 'RED BUZZ',
  'FC Toyotake': 'FC Toyoake',
};

function findTeamPoint(name){
  const clean = (name||'').trim();
  let p = points.find(pp=>pp.name.trim()===clean);
  if(!p && TEAM_NAME_ALIASES[clean]){
    const aliasTarget = TEAM_NAME_ALIASES[clean];
    p = points.find(pp=>pp.name.trim()===aliasTarget);
  }
  if(!p){
    const norm = normalizeForMatch(clean);
    p = points.find(pp=>normalizeForMatch(pp.name)===norm);
  }
  return p;
}

function matchKey(teamId, m){
  return [teamId, m.date||'', m.category||'', m.score||'', m.result||'', m.siriusTeam||'', m.pkScore||''].join('|');
}

function isSiriusTeamName(name){
  const n=String(name||'').replace(/[\s\u3000]+/g,'').toUpperCase();
  return n.indexOf('FCSIRIUS')===0 || n.indexOf('FCシリウス')===0;
}
function normalizeInternalTeamName(name){
  return String(name||'').replace(/[\s\u3000]+/g,'').toUpperCase();
}
function flipResult(result){
  return result==='勝'?'敗':result==='敗'?'勝':result;
}
function invertScore(score){
  const m=String(score||'').match(/^(\d+)\s*[-－―−:]\s*(\d+)$/);
  return m ? m[2]+'-'+m[1] : String(score||'');
}
function upsertInternalMatch(row){
  const side=String(row.siriusTeam||'').trim(), opponent=String(row.team||'').trim();
  if(!side || !opponent || !isSiriusTeamName(side) || !isSiriusTeamName(opponent)) return false;
  const sideFirst=normalizeInternalTeamName(side).localeCompare(normalizeInternalTeamName(opponent),'en')<=0;
  const teamA=sideFirst?side:opponent, teamB=sideFirst?opponent:side;
  const score=sideFirst?row.score:invertScore(row.score);
  const pkScore=sideFirst?row.pkScore:invertScore(row.pkScore);
  let result=sideFirst?row.result:flipResult(row.result);
  const scoreParts=String(score||'').match(/^(\d+)-(\d+)$/);
  const pkParts=String(pkScore||'').match(/^(\d+)-(\d+)$/);
  if(scoreParts && Number(scoreParts[1])!==Number(scoreParts[2])) result=Number(scoreParts[1])>Number(scoreParts[2])?'勝':'敗';
  else if(pkParts && Number(pkParts[1])!==Number(pkParts[2])) result=Number(pkParts[1])>Number(pkParts[2])?'勝':'敗';
  const item={date:row.date||'',category:row.category||'',teamA,teamB,score,pkScore,result,matchType:'internal',source:'official'};
  const key=[item.date,item.category,normalizeInternalTeamName(teamA),normalizeInternalTeamName(teamB),item.score,item.pkScore].join('|');
  if(internalMatches.some(m=>[m.date,m.category,normalizeInternalTeamName(m.teamA),normalizeInternalTeamName(m.teamB),m.score||'',m.pkScore||''].join('|')===key)) return false;
  internalMatches.push(item);
  return true;
}

function refreshMarkerVisual(p){
  const marker = markers[p.id];
  if(!marker) return;
  marker.setPopupContent(popupHtml(p));
  const v = teamVisual(p.matches);
  marker.setIcon(makeIcon(p.id===selectedId, v.color, v.skull));
}

// rows: array of arrays (raw cell values). Auto-detects header row & shape, then imports.
function importRows(rows){
  // find a plausible header row within the first 15 rows
  let headerIdx = -1, header = null;
  const maxScan = Math.min(rows.length, 15);
  for(let i=0;i<maxScan;i++){
    const row = (rows[i]||[]).map(c=>String(c==null?'':c).trim());
    if(row.includes('日付') && row.includes('FC名')){ headerIdx = i; header = row; break; }
    if((row.includes('name') || row.includes('名称')) && (row.includes('lat') || row.includes('緯度'))){ headerIdx = i; header = row; break; }
    if((row.includes('team') || row.includes('チーム名')) && (row.includes('date') || row.includes('日付')) && row.includes('score')){ headerIdx = i; header = row; break; }
  }
  if(headerIdx === -1){
    toast('ファイルの列構成を認識できませんでした');
    return;
  }
  const col = name => header.indexOf(name);

  if(header.includes('日付') && header.includes('FC名')){
    // 元シート形式: 日付,開始時間,終了時間,場所,引率,TM名,カテゴリ,自チームスコア,相手チームスコア,得失点,勝敗,相手チーム名,備考,FC名
    const iDate=col('日付'), iCat=col('カテゴリ'), iMy=col('自チームスコア'), iOpp=col('相手チームスコア'), iRes=col('勝敗'), iTeam=col('FC名'), iPlace=col('場所');
    let added=0, dup=0, noTeam=0; const unmatched = new Set(); const touched = new Set();
    const unmatchedPlaces = new Set();
    const existingKeys = new Set();
    points.forEach(p=> (p.matches||[]).forEach(m=> existingKeys.add(matchKey(p.id, m))));
    for(let i=headerIdx+1;i<rows.length;i++){
      const r = rows[i]||[];
      if(r.every(c=> c===undefined || c===null || String(c).trim()==='')) continue;
      const teamRaw = String(r[iTeam]==null?'':r[iTeam]).trim();
      if(!teamRaw) continue;
      const date = normalizeDateStr(String(r[iDate]==null?'':r[iDate]));
      const category = String(r[iCat]==null?'':r[iCat]).trim();
      const my = String(r[iMy]==null?'':r[iMy]).trim();
      const opp = String(r[iOpp]==null?'':r[iOpp]).trim();
      const score = (my!=='' && opp!=='') ? `${my}-${opp}` : '';
      const resultRaw = String(r[iRes]==null?'':r[iRes]).trim();
      const result = RESULT_MAP[resultRaw] || resultRaw;

      // 旧形式にSIRIUSチーム名が含まれる場合、対外チームとして登録しない。
      // 両側がSIRIUS内チームなら内部対戦として保存し、片側の区分が不明なら保留する。
      if(isSiriusTeamName(teamRaw)){
        if(isSiriusTeamName(opp)){
          upsertInternalMatch({team:opp,siriusTeam:teamRaw,date,category,score,pkScore:'',result});
        } else {
          console.warn('旧形式のSIRIUSチーム記録はチーム区分を確認できないため、対外戦績から除外:', teamRaw, date, category);
        }
        continue;
      }

      if(iPlace>=0){
        const place = String(r[iPlace]==null?'':r[iPlace]).trim();
        if(place){
          const ok = upsertGroundMatch(place, {date, category, opponent: teamRaw, score, result});
          if(!ok) unmatchedPlaces.add(place);
        }
      }

      const p = findTeamPoint(teamRaw);
      if(!p){ noTeam++; unmatched.add(teamRaw); continue; }
      const key = matchKey(p.id, {date, category, score, result});
      if(existingKeys.has(key)){ dup++; continue; }
      addMatch(p.id, {date, category, score, result, place:iPlace>=0?String(r[iPlace]||'').trim():''}, {silent:true});
      existingKeys.add(key);
      touched.add(p.id);
      added++;
    }
    touched.forEach(id=>{ const p = points.find(pp=>pp.id===id); if(p) refreshMarkerVisual(p); });
    refreshGroundMarkers();
    renderList();
    persist();
    let msg = `戦績 ${added}件登録`;
    if(dup) msg += `／重複${dup}件スキップ`;
    if(noTeam) msg += `／該当チーム無し${noTeam}件`;
    if(unmatchedPlaces.size) msg += `／未登録グラウンド${unmatchedPlaces.size}件`;
    toast(msg);
    if(unmatched.size) console.warn('未マッチのチーム名:', [...unmatched]);
    if(unmatchedPlaces.size) console.warn('座標未登録のグラウンド:', [...unmatchedPlaces]);
    return;
  }

  if((header.includes('team') || header.includes('チーム名')) && (header.includes('date') || header.includes('日付'))){
    // シンプル形式: team,date,category,score,result + optional siriusTeam,pkScore,matchType
    const iTeam = col('team')>=0?col('team'):col('チーム名');
    const iDate = col('date')>=0?col('date'):col('日付');
    const iCat = col('category')>=0?col('category'):col('カテゴリ');
    const iScore = col('score')>=0?col('score'):col('スコア');
    const iRes = col('result')>=0?col('result'):col('結果');
    const iSiriusTeam = col('siriusTeam');
    const iPkScore = col('pkScore');
    const iMatchType = col('matchType')>=0?col('matchType'):col('試合区分');
    let added=0, dup=0, noTeam=0, internalAdded=0, internalDup=0; const unmatched = new Set(); const touched = new Set();
    const existingKeys = new Set();
    points.forEach(p=> (p.matches||[]).forEach(m=> existingKeys.add(matchKey(p.id, m))));
    for(let i=headerIdx+1;i<rows.length;i++){
      const r = rows[i]||[];
      if(r.every(c=> c===undefined || c===null || String(c).trim()==='')) continue;
      const teamRaw = String(r[iTeam]==null?'':r[iTeam]).trim();
      if(!teamRaw) continue;
      const date = normalizeDateStr(String(r[iDate]==null?'':r[iDate]));
      const category = String(iCat>=0 && r[iCat]!=null?r[iCat]:'').trim();
      const score = String(iScore>=0 && r[iScore]!=null?r[iScore]:'').trim();
      const resultRaw = String(iRes>=0 && r[iRes]!=null?r[iRes]:'').trim();
      const result = RESULT_MAP[resultRaw] || resultRaw;
      const siriusTeam = String(iSiriusTeam>=0 && r[iSiriusTeam]!=null?r[iSiriusTeam]:'').trim();
      const pkScore = String(iPkScore>=0 && r[iPkScore]!=null?r[iPkScore]:'').trim();
      const matchTypeRaw = String(iMatchType>=0 && r[iMatchType]!=null?r[iMatchType]:'').trim().toLowerCase();
      const isInternal = matchTypeRaw==='internal' || matchTypeRaw==='チーム内' ||
        (isSiriusTeamName(teamRaw) && isSiriusTeamName(siriusTeam));
      if(isInternal){
        const inserted=upsertInternalMatch({team:teamRaw,siriusTeam:siriusTeam,date,category,score,pkScore,result});
        if(inserted) internalAdded++; else internalDup++;
        continue;
      }
      if(isSiriusTeamName(teamRaw)){
        console.warn('SIRIUSチーム名ですが相手側チーム区分が不明なため、対外戦績から除外:', teamRaw, date, category);
        continue;
      }
      const p = findTeamPoint(teamRaw);
      if(!p){ noTeam++; unmatched.add(teamRaw); continue; }
      const match = {date, category, score, result, siriusTeam, pkScore, matchType:'external'};
      const key = matchKey(p.id, match);
      if(existingKeys.has(key)){ dup++; continue; }
      addMatch(p.id, match, {silent:true});
      existingKeys.add(key);
      touched.add(p.id);
      added++;
    }
    touched.forEach(id=>{ const p = points.find(pp=>pp.id===id); if(p) refreshMarkerVisual(p); });
    renderList();
    persist();
    let msg = `対外戦績 ${added}件登録`;
    if(dup) msg += `／重複${dup}件スキップ`;
    if(internalAdded || internalDup) msg += `／チーム内対戦 ${internalAdded}件追加・重複${internalDup}件`;
    if(noTeam) msg += `／該当チーム無し${noTeam}件`;
    toast(msg);
    if(unmatched.size) console.warn('未マッチのチーム名:', [...unmatched]);
    return;
  }
  // 拠点形式: name/名称, lat/緯度, lng/経度, note/メモ, url/リンク
  {
    const iName = col('name')>=0?col('name'):col('名称');
    const iLat = col('lat')>=0?col('lat'):col('緯度');
    const iLng = col('lng')>=0?col('lng'):col('経度');
    const iNote = col('note')>=0?col('note'):col('メモ');
    const iUrl = col('url')>=0?col('url'):(col('リンク')>=0?col('リンク'):col('link'));
    let added=0, updated=0;
    for(let i=headerIdx+1;i<rows.length;i++){
      const r = rows[i]||[];
      if(r.every(c=> c===undefined || c===null || String(c).trim()==='')) continue;
      const name = String(r[iName]==null?'':r[iName]).trim();
      if(!name) continue;
      const lat = Number(r[iLat]), lng = Number(r[iLng]);
      if(Number.isNaN(lat) || Number.isNaN(lng)) continue;
      const note = iNote>=0 ? String(r[iNote]==null?'':r[iNote]).trim() : '';
      const url = iUrl>=0 ? String(r[iUrl]==null?'':r[iUrl]).trim() : '';
      const existing = points.find(pp=>pp.name.trim()===name);
      if(existing){
        existing.lat = lat; existing.lng = lng;
        if(note) existing.note = note;
        if(url) existing.url = url;
        refreshMarkerVisual(existing);
        const marker = markers[existing.id];
        if(marker) marker.setLatLng([lat,lng]);
        updated++;
      } else {
        addPoint(name, lat, lng, {note, url, silent:true});
        added++;
      }
    }
    renderList();
    persist();
    toast(`拠点 追加${added}件／更新${updated}件`);
  }
}

/* ---------------- list rendering ---------------- */
function buildPointCard(p){
  const card = document.createElement('div');
  card.className = 'point-card' + (p.id===selectedId ? ' selected' : '');
  const matches = matchesForGrade(p.matches);
  const s = recordSummary(matches);
  const isOpen = expandedEdit.has(p.id);

  const matchRowsHtml = matches.length
    ? matches.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')).map(m=>`
        <div class="match-row">
          <span>${escapeHtml(m.date||'')}${m.category ? ' ' + escapeHtml(m.category) : ''}</span>
          <span class="mscore">${escapeHtml(m.score||'')}</span>
          <span class="mresult">${escapeHtml(m.result||'')}</span>
          <button class="btn btn-ghost btn-sm" data-act="delmatch" data-mid="${m.id}" title="削除">✕</button>
        </div>`).join('')
    : '<div class="match-empty">戦績はまだ登録されていません</div>';

  const v = teamVisual(matches);
  const swatchHtml = v.skull
    ? `<span class="swatch" style="background:#1F2933;display:flex;align-items:center;justify-content:center;font-size:7px;">💀</span>`
    : `<span class="swatch" style="background:${v.color};"></span>`;
  const badgeHtml = matches.length
    ? `<span class="badge">${s.win}勝${s.draw}分${s.lose}敗${v.rate!==null ? ` ${Math.round(v.rate)}%` : ''}</span>`
    : '';

  card.innerHTML = `
    <div class="point-head" data-act="select">
      ${swatchHtml}
      <span class="point-name">${escapeHtml(p.name)}</span>
      ${badgeHtml}
      <button class="btn btn-ghost btn-sm" data-act="edit" title="編集">✎</button>
      <button class="btn btn-ghost btn-sm" data-act="del" title="削除">✕</button>
    </div>
    <div class="point-coords">${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</div>
    ${p.note ? `<div class="point-coords" style="padding-top:0;">${escapeHtml(p.note)}</div>` : ''}
    <div class="point-edit${isOpen ? ' open' : ''}" data-edit>
      <div class="row">
        <input type="text" data-f="name" value="${escapeHtml(p.name)}">
      </div>
      <div class="row">
        <input type="number" step="any" data-f="lat" value="${p.lat}">
        <input type="number" step="any" data-f="lng" value="${p.lng}">
      </div>
      <div class="row">
        <input type="text" data-f="note" value="${escapeHtml(p.note||'')}" placeholder="所在地・精度メモ">
      </div>
      <div class="row">
        <input type="text" data-f="url" value="${escapeHtml(p.url||'')}" placeholder="チーム紹介ページURL（公式サイト/Instagram等）">
      </div>
      <div class="row">
        <button class="btn btn-primary btn-sm" data-act="save">保存</button>
      </div>

      <div class="match-section">
        <div class="section-title">戦績（${escapeHtml(GRADE_LABELS[currentGrade]||currentGrade)}のみ表示中）</div>
        <div class="match-list">${matchRowsHtml}</div>
        <div class="row">
          <input type="text" data-f="mdate" placeholder="日付 例)2026-05-10">
          <select data-f="mcat">
            ${GRADE_OPTIONS.map(g=>`<option value="${g}"${g===currentGrade?' selected':''}>${g}（${GRADE_LABELS[g]}）</option>`).join('')}
            <option value="その他">その他</option>
          </select>
        </div>
        <div class="row">
          <input type="text" data-f="mscore" placeholder="スコア 例)3-1">
          <select data-f="mresult">
            <option value="勝">勝</option>
            <option value="分">分</option>
            <option value="敗">敗</option>
          </select>
        </div>
        <div class="row">
          <button class="btn btn-sm btn-block" data-act="addmatch">戦績を追加</button>
        </div>
      </div>
    </div>
  `;

  card.querySelector('[data-act="select"]').addEventListener('click', (e)=>{
    if(e.target.closest('button')) return;
    selectPoint(p.id);
  });
  card.querySelector('[data-act="del"]').addEventListener('click', (e)=>{
    e.stopPropagation();
    removePoint(p.id);
  });
  card.querySelector('[data-act="edit"]').addEventListener('click', (e)=>{
    e.stopPropagation();
    if(expandedEdit.has(p.id)) expandedEdit.delete(p.id); else expandedEdit.add(p.id);
    renderList();
  });
  card.querySelector('[data-act="save"]').addEventListener('click', (e)=>{
    e.stopPropagation();
    const name = card.querySelector('[data-f="name"]').value;
    const lat = card.querySelector('[data-f="lat"]').value;
    const lng = card.querySelector('[data-f="lng"]').value;
    const note = card.querySelector('[data-f="note"]').value;
    const url = card.querySelector('[data-f="url"]').value;
    updatePoint(p.id, {name, lat, lng, note, url});
    toast('更新しました');
  });
  card.querySelectorAll('[data-act="delmatch"]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      removeMatch(p.id, btn.dataset.mid);
    });
  });
  const addMatchBtn = card.querySelector('[data-act="addmatch"]');
  if(addMatchBtn){
    addMatchBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const date = card.querySelector('[data-f="mdate"]').value.trim();
      const category = card.querySelector('[data-f="mcat"]').value;
      const score = card.querySelector('[data-f="mscore"]').value.trim();
      const result = card.querySelector('[data-f="mresult"]').value;
      if(!date && !score){ toast('日付かスコアを入力してください'); return; }
      expandedEdit.add(p.id);
      addMatch(p.id, {date, category, score, result});
      toast('戦績を追加しました');
    });
  }

  return card;
}

function getRankedTeams(){
  const withData = points
    .filter(p => matchesForGrade(p.matches).length > 0)
    .map(p => {
      const v = teamVisual(p.matches);
      const s = recordSummary(p.matches);
      const loseRate = s.total ? (s.lose / s.total) * 100 : 0;
      return { p, v, s, loseRate };
    });

  const topWin = [...withData]
    .sort((a,b)=> b.v.rate - a.v.rate || b.s.win - a.s.win)
    .slice(0,3)
    .map(x=>x.p);

  const topWinIds = new Set(topWin.map(p=>p.id));

  const topLose = [...withData]
    .filter(x=> !topWinIds.has(x.p.id))
    .sort((a,b)=> b.loseRate - a.loseRate || b.s.lose - a.s.lose)
    .slice(0,3)
    .map(x=>x.p);

  return { topWin, topLose };
}

function renderList(){
  applyTeamFilter();
  const countLabel = document.getElementById('countLabel');
  if(countLabel) countLabel.textContent = `${points.length} 地点 ｜ ${GRADE_LABELS[currentGrade]||currentGrade}`;
}

function downloadFile(filename, content, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
