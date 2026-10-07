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
  return [teamId, m.date||'', m.category||'', m.score||'', m.result||''].join('|');
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
    // シンプル形式: team/チーム名, date/日付, category/カテゴリ, score/スコア, result/結果
    const iTeam = col('team')>=0?col('team'):col('チーム名');
    const iDate = col('date')>=0?col('date'):col('日付');
    const iCat = col('category')>=0?col('category'):col('カテゴリ');
    const iScore = col('score')>=0?col('score'):col('スコア');
    const iRes = col('result')>=0?col('result'):col('結果');
    let added=0, dup=0, noTeam=0; const unmatched = new Set(); const touched = new Set();
    const existingKeys = new Set();
    points.forEach(p=> (p.matches||[]).forEach(m=> existingKeys.add(matchKey(p.id, m))));
    for(let i=headerIdx+1;i<rows.length;i++){
      const r = rows[i]||[];
      if(r.every(c=> c===undefined || c===null || String(c).trim()==='')) continue;
      const teamRaw = String(r[iTeam]==null?'':r[iTeam]).trim();
      if(!teamRaw) continue;
      const p = findTeamPoint(teamRaw);
      if(!p){ noTeam++; unmatched.add(teamRaw); continue; }
      const date = normalizeDateStr(String(r[iDate]==null?'':r[iDate]));
      const category = String(r[iCat]==null?'':r[iCat]).trim();
      const score = String(r[iScore]==null?'':r[iScore]).trim();
      const resultRaw = String(r[iRes]==null?'':r[iRes]).trim();
      const result = RESULT_MAP[resultRaw] || resultRaw;
      const key = matchKey(p.id, {date, category, score, result});
      if(existingKeys.has(key)){ dup++; continue; }
      addMatch(p.id, {date, category, score, result}, {silent:true});
      existingKeys.add(key);
      touched.add(p.id);
      added++;
    }
    touched.forEach(id=>{ const p = points.find(pp=>pp.id===id); if(p) refreshMarkerVisual(p); });
    renderList();
    persist();
    let msg = `戦績 ${added}件登録`;
    if(dup) msg += `／重複${dup}件スキップ`;
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

