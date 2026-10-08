/* ---------------- keep map sized correctly (fixes blank map on mobile) ---------------- */
function fixMapSize(){ map.invalidateSize(); }

/* ---------------- separate markers sharing (near-)identical coordinates ---------------- */
function deconflictCoordinates(list){
  const groups = {};
  list.forEach(it=>{
    const key = it.lat.toFixed(3) + ',' + it.lng.toFixed(3);
    (groups[key] = groups[key] || []).push(it);
  });
  Object.values(groups).forEach(group=>{
    const n = group.length;
    if(n <= 1) return;
    const radius = 0.0045; // ~500m: enough to separate visually at city-level zoom
    group.forEach((it, i)=>{
      const angle = (2*Math.PI*i)/n;
      const latRad = it.lat * Math.PI/180;
      it.lat = it.lat + radius*Math.cos(angle);
      it.lng = it.lng + radius*Math.sin(angle)/Math.cos(latRad);
    });
  });
}
window.addEventListener('load', fixMapSize);
window.addEventListener('resize', fixMapSize);
window.addEventListener('orientationchange', ()=> setTimeout(fixMapSize, 300));
if('ResizeObserver' in window){
  const ro = new ResizeObserver(()=> fixMapSize());
  ro.observe(document.getElementById('map'));
  ro.observe(document.querySelector('.map-wrap'));
}
setTimeout(fixMapSize, 100);
setTimeout(fixMapSize, 500);
setTimeout(fixMapSize, 1500);

/* ---------------- avoid overlapping name labels ---------------- */
let declutterTimer = null;
function declutterLabels(){
  const showTeam = document.body.classList.contains('team-labels-visible');
  const showGround = document.body.classList.contains('ground-labels-visible');
  if(!showTeam && !showGround) return;

  const entries = [];
  if(showTeam){
    points.forEach(p=>{
      const m = markers[p.id];
      if(m) entries.push({ marker:m, lat:p.lat, lng:p.lng, name:p.name, cls:'name-label team-label' });
    });
  }
  if(showGround){
    Object.values(grounds).forEach(g=>{
      const m = groundMarkers[g.name];
      if(m) entries.push({ marker:m, lat:g.lat, lng:g.lng, name:g.name, cls:'name-label ground-label' });
    });
  }
  if(entries.length===0) return;

  entries.forEach(e=>{
    const pt = map.latLngToContainerPoint([e.lat, e.lng]);
    e.x = pt.x; e.y = pt.y;
  });
  // stable placement order: top-to-bottom, then left-to-right
  entries.sort((a,b)=> (a.y - b.y) || (a.x - b.x));

  const CELL_W = 60, CELL_H = 16;
  const cellCounts = {};
  entries.forEach(e=>{
    const key = Math.round(e.x / CELL_W) + '_' + Math.round(e.y / CELL_H);
    const n = cellCounts[key] || 0;
    cellCounts[key] = n + 1;
    const offsetY = -10 - (14 * n); // stack further labels progressively higher
    const tt = e.marker.getTooltip && e.marker.getTooltip();
    const currentOffsetY = (tt && tt.options && tt.options.offset) ? tt.options.offset[1] : null;
    if(currentOffsetY !== offsetY){
      e.marker.unbindTooltip();
      e.marker.bindTooltip(e.name, { permanent:true, direction:'top', offset:[0, offsetY], className: e.cls });
    }
  });
}
function scheduleDeclutter(){
  clearTimeout(declutterTimer);
  declutterTimer = setTimeout(declutterLabels, 120);
}
map.on('zoomend', scheduleDeclutter);
map.on('moveend', scheduleDeclutter);

/* ---------------- collapsible sections ---------------- */
document.querySelectorAll('[data-collapse-toggle]').forEach(el=>{
  el.addEventListener('click', ()=>{
    const targetId = el.dataset.target;
    const body = targetId ? document.getElementById(targetId) : el.nextElementSibling;
    if(!body) return;
    body.classList.toggle('collapsed');
    const isOpen = !body.classList.contains('collapsed');
    const chev = el.querySelector('.chev');
    if(chev) chev.textContent = isOpen ? '▾' : '▸';
    el.classList.toggle('active', isOpen);
    fixMapSize();
  });
});

document.getElementById('btnToggleGroundsVisible').addEventListener('click', ()=>{
  groundsVisible = !groundsVisible;
  document.getElementById('btnToggleGroundsVisible').classList.toggle('active', groundsVisible);
  applyGroundGradeFilter();
});

const TILE_ORDER = ['std','pale','blank','photo'];
const TILE_LABELS = { std:'標準地図', pale:'淡色地図', blank:'白地図', photo:'写真地図' };
let currentTileKey = 'pale';

document.getElementById('btnCycleTileLayer').addEventListener('click', ()=>{
  const idx = TILE_ORDER.indexOf(currentTileKey);
  currentTileKey = TILE_ORDER[(idx+1) % TILE_ORDER.length];
  map.removeLayer(currentTile);
  currentTile = makeTileLayer(currentTileKey).addTo(map);
  document.getElementById('btnCycleTileLayer').querySelector('.lbl').textContent = TILE_LABELS[currentTileKey];
});

document.getElementById('btnToggleTeamLabels').addEventListener('click', ()=>{
  const visible = document.body.classList.toggle('team-labels-visible');
  document.getElementById('btnToggleTeamLabels').classList.toggle('active', visible);
  if(visible) declutterLabels();
});

document.getElementById('btnToggleGroundLabels').addEventListener('click', ()=>{
  const visible = document.body.classList.toggle('ground-labels-visible');
  document.getElementById('btnToggleGroundLabels').classList.toggle('active', visible);
  if(visible) declutterLabels();
});

const FILTER_LABELS = {
  green: '勝率100%（全勝）',
  yellow: '勝率60%〜99%',
  orange: '勝率30%〜59%',
  red: '勝率30%未満',
  skull: '全敗',
};

document.querySelector('.legend-bar').addEventListener('click', (e)=>{
  const item = e.target.closest('.legend-item[data-filter]');
  if(!item) return;
  const f = item.dataset.filter;
  activeTeamFilter = (activeTeamFilter === f) ? null : f;
  document.querySelectorAll('.legend-bar .legend-item[data-filter]').forEach(el=>{
    el.classList.toggle('active-filter', el.dataset.filter === activeTeamFilter);
  });
  applyTeamFilter();
  scheduleDeclutter();
  toast(activeTeamFilter ? `絞り込み: ${FILTER_LABELS[activeTeamFilter]}` : '絞り込みを解除しました');
});

/* ---------------- name / address search ---------------- */
const mapSearchInput = document.getElementById('mapSearchInput');
const mapSearchResults = document.getElementById('mapSearchResults');
const mapSearchInputMobile = document.getElementById('mapSearchInputMobile');
const mapSearchResultsMobile = document.getElementById('mapSearchResultsMobile');

function normalizeSearchText(s){
  return (s||'').toString().toLowerCase().replace(/\s+/g,'');
}
function positionSearchResults(){
  const input = window.matchMedia('(max-width:600px)').matches ? mapSearchInputMobile : mapSearchInput;
  const box = window.matchMedia('(max-width:600px)').matches ? mapSearchResultsMobile : mapSearchResults;
  if(!input || !box) return;
  const rect=input.getBoundingClientRect();
  const viewportH=window.innerHeight;
  box.style.maxHeight=Math.max(80,viewportH-rect.bottom-12)+'px';
  if(box===mapSearchResults){
    box.style.left=rect.left+'px'; box.style.width=rect.width+'px'; box.style.top=(rect.bottom+4)+'px';
  }
}
function runMapSearch(rawQuery, targetResults=mapSearchResults){
  const q=normalizeSearchText(rawQuery);
  targetResults.innerHTML='';
  if(!q){targetResults.classList.remove('show');return;}
  const results=[];
  points.forEach(p=>{
    const hay=normalizeSearchText(p.name+' '+(p.note||''));
    if(hay.includes(q)){
      const sm=recordSummary(p.matches);
      results.push({type:'team',name:p.name,sub:`${p.note||'対戦チーム'}${sm.total?` ｜ ${sm.win}勝${sm.draw}分${sm.lose}敗`:''}`,ref:p,score:hay.indexOf(q)});
    }
  });
  Object.values(grounds).forEach(g=>{
    const posts=getGroundMemoPosts(g.name);
    const memo=posts.length?posts[0].memo:'';
    const hayRaw=[g.name,g.address,g.accuracy,g.updatedAt,g.parking,g.toilet,g.access,g.facilities,g.spectator,g.caution,memo].filter(Boolean).join(' ');
    const hay=normalizeSearchText(hayRaw);
    if(hay.includes(q)){
      const acc=(g.accuracy||'').trim().toUpperCase();
      results.push({type:'ground',name:g.name,sub:`⚽ 会場${acc?' ｜ 精度'+acc:''}${memo?' ｜ メモあり':''} ｜ ${g.address||'住所情報なし'}`,ref:g,score:hay.indexOf(q)});
    }
  });
  results.sort((a,b)=>(a.score||0)-(b.score||0));
  if(!results.length){
    targetResults.innerHTML='<div class="search-empty">該当する地点が見つかりません</div>';
    targetResults.classList.add('show'); positionSearchResults(); return;
  }
  results.slice(0,25).forEach(r=>{
    const item=document.createElement('div'); item.className='search-result-item';
    item.innerHTML=`<span class="sr-type">${r.type==='ground'?'⚽ グラウンド':'チーム'}</span><span class="sr-name">${escapeHtml(r.name)}</span><span class="sr-sub">${escapeHtml(r.sub)}</span>`;
    item.addEventListener('click',()=>{
      let marker,lat,lng;
      if(r.type==='team'){marker=markers[r.ref.id];lat=r.ref.lat;lng=r.ref.lng;if(marker)selectPoint(r.ref.id);}
      else{marker=groundMarkers[r.ref.name];lat=r.ref.lat;lng=r.ref.lng;}
      if(marker){map.flyTo([lat,lng],Math.max(map.getZoom(),15));marker.openPopup();}
      targetResults.classList.remove('show');
      if(mapSearchInput) mapSearchInput.value='';
      if(mapSearchInputMobile) mapSearchInputMobile.value='';
      const panel=document.getElementById('mobileSearchPanel'); if(panel) panel.classList.remove('open');
      const legendBody=document.getElementById('legendBody');
      legendBody.classList.add('collapsed'); document.getElementById('btnHeaderToggle').classList.remove('active'); fixMapSize();
    });
    targetResults.appendChild(item);
  });
  targetResults.classList.add('show'); positionSearchResults();
}
if(mapSearchInput) mapSearchInput.addEventListener('input',e=>runMapSearch(e.target.value,mapSearchResults));
if(mapSearchInput) mapSearchInput.addEventListener('focus',e=>{if(e.target.value)runMapSearch(e.target.value,mapSearchResults)});
if(mapSearchInputMobile) mapSearchInputMobile.addEventListener('input',e=>runMapSearch(e.target.value,mapSearchResultsMobile));
if(mapSearchInputMobile) mapSearchInputMobile.addEventListener('focus',e=>{if(e.target.value)runMapSearch(e.target.value,mapSearchResultsMobile)});
window.addEventListener('resize',()=>{if(mapSearchResults.classList.contains('show')||mapSearchResultsMobile.classList.contains('show'))positionSearchResults();});

const mobileSearchPanel=document.getElementById('mobileSearchPanel');
const mobileSearchBtn=document.getElementById('mobileSearchBtn');
const mobileSearchClose=document.getElementById('mobileSearchClose');
if(mobileSearchBtn) mobileSearchBtn.addEventListener('click',()=>{
  mobileSearchPanel.classList.add('open');
  mapSearchInputMobile.focus();
});
if(mobileSearchClose) mobileSearchClose.addEventListener('click',()=>{
  mobileSearchPanel.classList.remove('open');
  mapSearchResultsMobile.classList.remove('show');
});
/* ---------------- team <-> ground navigation ---------------- */
function openGroundByName(name){
  const g=grounds[name];
  const marker=g && groundMarkers[name];
  if(!g || !marker){toast('会場情報が見つかりません');return;}
  map.flyTo([g.lat,g.lng],Math.max(map.getZoom(),15));
  marker.openPopup();
}
function openTeamByName(name){
  const p=findTeamPoint(name);
  const marker=p && markers[p.id];
  if(!p || !marker){toast('チーム位置が見つかりません');return;}
  map.flyTo([p.lat,p.lng],Math.max(map.getZoom(),13));
  marker.openPopup();
}

/* ---------------- 観戦ガイドサマリー ---------------- */
function allGradeMatchesForCurrent(){
  const arr=[];
  points.forEach(p=>{
    matchesForGrade(p.matches).forEach(m=>arr.push({...m, opponent:p.name, pointId:p.id}));
  });
  return arr;
}
function formatGuideDate(v){
  if(!v) return '';
  const d=new Date(v);
  if(Number.isNaN(d.getTime())) return v;
  return `${d.getMonth()+1}/${d.getDate()}`;
}
function updateGuide(){
  const matches=allGradeMatchesForCurrent();
  const opponents=new Set(matches.map(m=>m.opponent));
  const wins=matches.filter(m=>m.result==='勝').length;
  const draws=matches.filter(m=>m.result==='分').length;
  const loses=matches.filter(m=>m.result==='敗').length;
  const tc=document.getElementById('teamCountMain');
  const ts=document.getElementById('teamCountSub');
  const rm=document.getElementById('overallRecordMain');
  const rs=document.getElementById('overallRecordSub');
  if(tc) tc.textContent=`${opponents.size}チーム`;
  if(ts) ts.textContent=`${GRADE_LABELS[currentGrade]||currentGrade}・対戦実績`;
  if(rm) rm.textContent=matches.length ? `${matches.length}試合 ${wins}勝${draws}分${loses}敗` : '試合データなし';
  const winRate=matches.length ? Math.round((wins/matches.length)*100) : 0;
  if(rs) rs.textContent=matches.length ? `勝率 ${winRate}%・${GRADE_LABELS[currentGrade]||currentGrade}` : '表示学年の全対戦';


  const recent=matches.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,6);
  const old=document.getElementById('recentGuideSection');
  if(old) old.remove();
  if(recent.length){
    const sec=document.createElement('div'); sec.id='recentGuideSection'; sec.className='guide-section';
    sec.innerHTML=`<div class="guide-section-title">最近の対戦</div><div class="recent-list">${recent.map(m=>{
      const cls=m.result==='勝'?'result-win':m.result==='分'?'result-draw':'result-lose';
      return `<div class="recent-item" data-point-id="${m.pointId}"><div class="ri-top">${escapeHtml(formatGuideDate(m.date))}</div><div class="ri-team">${escapeHtml(m.opponent)}</div><div class="ri-score ${cls}">${escapeHtml(m.score||'-')} ${escapeHtml(m.result||'')}</div></div>`;
    }).join('')}</div>`;
    const anchor=document.getElementById('guideSearchAnchor');
    (anchor||document.querySelector('.guide-search')).before(sec);
    sec.querySelectorAll('.recent-item').forEach(el=>el.addEventListener('click',()=>{ const id=Number(el.dataset.pointId); if(markers[id]){ selectPoint(id); map.flyTo(markers[id].getLatLng(),15); markers[id].openPopup(); } }));
  }
}

/* ---------------- grade select (学年別表示) ---------------- */
const gradeSelectEl = document.getElementById('gradeSelect');
gradeSelectEl.innerHTML = GRADE_OPTIONS.map(g=>`<option value="${g}">${GRADE_LABELS[g]}</option>`).join('');
gradeSelectEl.value = currentGrade;

function refreshAllForGrade(){
  points.forEach(p=>{
    const marker = markers[p.id];
    if(marker){
      marker.setPopupContent(popupHtml(p));
      const v = teamVisual(p.matches);
      const hasCurrent = matchesForGrade(p.matches).length > 0;
      marker.setIcon(showOtherGrades && !hasCurrent ? makeOtherGradeIcon(p.id===selectedId) : makeIcon(p.id===selectedId, v.color, v.skull));
    }
  });
  Object.values(grounds).forEach(g=>{
    const marker = groundMarkers[g.name];
    if(marker) marker.setPopupContent(groundPopupHtml(g));
  });
  applyGroundGradeFilter();
  renderList();
  updateGuide();
}

gradeSelectEl.addEventListener('change', (e)=>{
  currentGrade = e.target.value;
  saveGrade(currentGrade);
  refreshAllForGrade();
  toast(`表示学年: ${GRADE_LABELS[currentGrade]}`);
});

const otherGradeToggleEl = document.getElementById('otherGradeToggle');
if(otherGradeToggleEl){
  otherGradeToggleEl.addEventListener('change', e=>{
    showOtherGrades=e.target.checked;
    refreshAllForGrade();
    toast(showOtherGrades ? '他学年の対戦情報を地図に追加表示' : '選択学年のみ表示');
  });
}

/* ---------------- persistence ---------------- */
async function loadPersisted(){
  if(!window.storage){ return; }
  try{
    const res = await window.storage.get(STORAGE_KEY);
    if(res && res.value){
      const saved = JSON.parse(res.value);
      if(Array.isArray(saved)){
        points = saved;
        nextId = points.reduce((m,p)=>Math.max(m,p.id),0) + 1;
      }
    }
  }catch(e){ /* no saved data yet */ }
}
let persistFailedNotified = false;
async function persist(){
  if(!window.storage){ return; }
  try{
    await window.storage.set(STORAGE_KEY, JSON.stringify(points));
  }catch(e){
    console.error('storage save failed', e);
    if(!persistFailedNotified){
      persistFailedNotified = true;
      toast('自動保存でエラー発生。作業は継続できます。念のためCSV書出で保存してください');
    }
  }
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.remove('show'), 2200);
}

/* ---------------- accuracy grade -> color (used only for note text, no longer for icon color) ---------------- */
function extractGrade(note){
  if(!note) return null;
  const m = note.match(/精度([A-D])/);
  return m ? m[1] : null;
}

/* ---------------- win-rate -> color / skull ---------------- */
function teamVisual(matches){
  const s = recordSummary(matches);
  if(s.total===0) return { color:'#9CA3AF', skull:false, rate:null, ...s };
  const allLoss = (s.win===0 && s.draw===0 && s.lose===s.total);
  if(allLoss) return { color:'#1F2933', skull:true, rate:0, ...s };
  const rate = (s.win / s.total) * 100;
  let color;
  if(rate >= 100) color = '#22C55E';       // 緑: 勝率100%
  else if(rate >= 60) color = '#EAB308';   // 黄: 60-99%
  else if(rate >= 30) color = '#F97316';   // 橙: 30-59%
  else color = '#EF4444';                  // 赤: 30%未満
  return { color, skull:false, rate, ...s };
}

// 凡例クリックによる絞り込み用: 勝率カテゴリを1語のラベルに分類
function teamCategory(matches){
  const v = teamVisual(matches);
  if(v.rate === null) return null; // 戦績データなし（絞り込み対象外）
  if(v.skull) return 'skull';
  if(v.rate >= 100) return 'green';
  if(v.rate >= 60) return 'yellow';
  if(v.rate >= 30) return 'orange';
  return 'red';
}

let activeTeamFilter = null; // 'green'|'yellow'|'orange'|'red'|'skull'|null

function applyTeamFilter(){
  points.forEach(p=>{
    const marker=markers[p.id];
    if(!marker) return;
    const hasCurrent=matchesForGrade(p.matches).length>0;
    const hasOther=matchesForOtherGrades(p.matches).length>0;
    const accuracy=teamAccuracy(p);
    let show=accuracy!=='D' && (hasCurrent || (showOtherGrades && hasOther));
    if(activeTeamFilter && hasCurrent) show=show && teamCategory(p.matches)===activeTeamFilter;
    const onMap=map.hasLayer(marker);
    if(show && !onMap) marker.addTo(map);
    if(!show && onMap) map.removeLayer(marker);
    marker.setOpacity(accuracy==='C' ? 0.72 : accuracy==='B' ? 0.88 : 1);
    if(showOtherGrades && !hasCurrent) marker.setOpacity(Math.min(marker.options.opacity || 1, 0.55));
  });
}

/* ---------------- marker icon ---------------- */
function makeIcon(active, color, skull){
  const ring = active ? '0 0 0 3px #1F2933, 0 1px 4px rgba(0,0,0,.4)' : '0 1px 4px rgba(0,0,0,.4)';
  if(skull){
    return L.divIcon({
      className: '',
      html: `<div style="width:20px;height:20px;border-radius:50%;background:#1F2933;border:2px solid #fff;box-shadow:${ring};display:flex;align-items:center;justify-content:center;font-size:12px;line-height:1;">💀</div>`,
      iconSize: [20,20],
      iconAnchor: [10,10],
    });
  }
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:${ring};"></div>`,
    iconSize: [16,16],
    iconAnchor: [8,8],
  });
}

function makeOtherGradeIcon(active){
  const ring=active ? '0 0 0 2px #64748B, 0 1px 4px rgba(0,0,0,.25)' : '0 1px 3px rgba(0,0,0,.25)';
  return L.divIcon({className:'',html:`<div style="width:13px;height:13px;border-radius:50%;background:#CBD5E1;border:2px solid #fff;box-shadow:${ring};display:flex;align-items:center;justify-content:center;font-size:7px;color:#475569;">他</div>`,iconSize:[17,17],iconAnchor:[8.5,8.5]});
}

/* ---------------- core operations ---------------- */
function addPoint(name, lat, lng, {fly=false, note='', matches=[], silent=false, url=''} = {}){
  lat = Number(lat); lng = Number(lng);
  if(Number.isNaN(lat) || Number.isNaN(lng)){ toast('緯度・経度が不正です'); return null; }
  const p = { id: nextId++, name: name && name.trim() ? name.trim() : `地点${nextId-1}`, lat, lng, note: note || '', matches: matches || [], url: url || '' };
  points.push(p);
  renderMarker(p);
  if(!silent){
    renderList();
    persist();
    if(fly) map.flyTo([lat,lng], Math.max(map.getZoom(), 14));
  }
  return p;
}

/* ---------------- match records (戦績) ---------------- */
function recordSummary(matches){
  const filtered = matchesForGrade(matches);
  const s = { win:0, draw:0, lose:0, total: filtered.length };
  filtered.forEach(m=>{
    if(m.result==='勝') s.win++;
    else if(m.result==='分') s.draw++;
    else if(m.result==='敗') s.lose++;
  });
  return s;
}

function addMatch(pointId, match, {silent=false} = {}){
  const p = points.find(pp=>pp.id===pointId);
  if(!p) return null;
  if(!p.matches) p.matches = [];
  const full = { id: 'm'+Date.now()+Math.random().toString(36).slice(2,6), date:'', category:'', score:'', result:'', ...match };
  p.matches.push(full);
  if(!silent){
    const marker = markers[pointId];
    if(marker){
      marker.setPopupContent(popupHtml(p));
      const v = teamVisual(p.matches);
      marker.setIcon(makeIcon(pointId===selectedId, v.color, v.skull));
    }
    renderList();
    persist();
  }
  return full;
}

function removeMatch(pointId, matchId){
  const p = points.find(pp=>pp.id===pointId);
  if(!p) return;
  p.matches = (p.matches||[]).filter(m=>m.id!==matchId);
  const marker = markers[pointId];
  if(marker){
    marker.setPopupContent(popupHtml(p));
    const v = teamVisual(p.matches);
    marker.setIcon(makeIcon(pointId===selectedId, v.color, v.skull));
  }
  renderList();
  persist();
}

function popupHtml(p){
  const noteLine = p.note ? `<div style="font-size:11.5px;color:#5A6472;margin-top:2px;">${escapeHtml(p.note)}</div>` : '';
  const matches = matchesForGrade(p.matches);
  let recordBlock;
  if(matches.length){
    const s = recordSummary(matches);
    const v = teamVisual(matches);
    const rows = matches.slice()
      .sort((a,b)=> (b.date||'').localeCompare(a.date||''))
      .map(m=>{
        const place=m.place ? `<a href="#" data-ground-link="${escapeHtml(m.place)}" style="color:#2563EB;text-decoration:none;">${escapeHtml(m.place)}</a>` : '';
        return `<div class="precord-row">
          <span>${escapeHtml(m.date||'')}${m.category ? ' ' + escapeHtml(m.category) : ''}</span>
          <span class="pmono">${escapeHtml(m.score||'')} ${escapeHtml(m.result||'')}</span>
          ${place ? `<span style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${place}</span>` : ''}
        </div>`;
      }).join('');
    const rateText = v.skull ? '全敗 💀' : `勝率${Math.round(v.rate)}%`;
    recordBlock = `<div class="precord">
        <div class="precord-title">戦績（${escapeHtml(GRADE_LABELS[currentGrade]||currentGrade)}）</div>
        <div class="match-summary"><div class="match-stat"><b>${s.win}</b><span>勝</span></div><div class="match-stat"><b>${s.draw}</b><span>分</span></div><div class="match-stat"><b>${s.lose}</b><span>敗</span></div><div class="match-stat"><b>${Math.round(v.rate||0)}%</b><span>勝率</span></div></div>
        ${rows}
      </div>`;
  } else {
    recordBlock = `<div class="precord"><div style="font-size:11px;color:#5A6472;">${escapeHtml(GRADE_LABELS[currentGrade]||currentGrade)}の戦績データなし</div></div>`;
  }
  let otherGradeBlock='';
  if(showOtherGrades){
    const rows=GRADE_OPTIONS.filter(g=>g!==currentGrade).map(g=>{
      const s=gradeSummary(p.matches,g);
      return s.total ? `<div class="precord-row"><span>${escapeHtml(g)}（${escapeHtml(GRADE_LABELS[g])}）</span><span>${s.win}勝${s.draw}分${s.lose}敗</span><span>全${s.total}試合</span></div>` : '';
    }).filter(Boolean).join('');
    if(rows) otherGradeBlock=`<div class="precord"><div class="precord-title">他学年の戦績</div>${rows}</div>`;
  }
  const linkLine = p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" class="popup-action">🔗 チーム紹介</a>` : '';
  const mapLink = `<a href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener" class="popup-action primary">📍 Google Maps</a>`;
  const accuracy = teamAccuracy(p);
  const accuracyLine = `<div style=\"margin-top:5px;font-size:11px;\">拠点精度：${accuracyBadge(accuracy)} ${escapeHtml(accuracyLabel(accuracy))}</div>`;
  return `<b>${escapeHtml(p.name)}</b><span class=\"pcoord\">${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</span>${accuracyLine}${noteLine}${recordBlock}${otherGradeBlock}<div class=\"popup-actions\">${mapLink}${linkLine}</div>`;
}

function teamAccuracy(p){
  const m = String(p?.note || '').match(/精度\s*([ABCD])/i);
  return m ? m[1].toUpperCase() : (p?.lat != null && p?.lng != null ? 'D' : 'D');
}
function accuracyLabel(a){
  return ({A:'実拠点・公式住所',B:'公式活動場所・主要拠点',C:'活動地域・市区町村代表点',D:'拠点未確認'})[a] || '拠点未確認';
}
function accuracyBadge(a){
  const bg = ({A:'#16A34A',B:'#2563EB',C:'#D97706',D:'#64748B'})[a] || '#64748B';
  return `<span style=\"display:inline-block;padding:2px 6px;border-radius:10px;background:${bg};color:#fff;font-size:10px;font-weight:700;margin-left:4px;\">精度${a}</span>`;
}

function renderMarker(p){
  const v=teamVisual(p.matches);
  const hasCurrent=matchesForGrade(p.matches).length>0;
  const icon=showOtherGrades && !hasCurrent ? makeOtherGradeIcon(p.id===selectedId) : makeIcon(p.id===selectedId,v.color,v.skull);
  const accuracy = teamAccuracy(p);
  const marker=L.marker([p.lat,p.lng],{icon}).addTo(map);
  marker.setOpacity(accuracy==='C' ? 0.72 : accuracy==='B' ? 0.88 : 1);
  marker.bindPopup(popupHtml(p), { maxWidth: 320 });
  marker.on('popupopen', (e)=>{
    const container=e.popup.getElement();
    container.querySelectorAll('[data-ground-link]').forEach(el=>{
      el.onclick=ev=>{ev.preventDefault();openGroundByName(el.dataset.groundLink);}
    });
  });
  marker.bindTooltip(p.name, { permanent:true, direction:'top', offset:[0,-10], className:'name-label team-label' });
  if(accuracy==='D') map.removeLayer(marker);
  marker.on('dragend', ()=>{
    const ll = marker.getLatLng();
    p.lat = ll.lat; p.lng = ll.lng;
    renderList();
    persist();
    marker.setPopupContent(popupHtml(p));
  });
  marker.on('click', ()=>{ selectPoint(p.id); });
  markers[p.id] = marker;
}

function removePoint(id){
  points = points.filter(p=>p.id!==id);
  if(markers[id]){ map.removeLayer(markers[id]); delete markers[id]; }
  if(selectedId===id) selectedId = null;
  renderList();
  persist();
}

function updatePoint(id, {name, lat, lng, note, url}){
  const p = points.find(p=>p.id===id);
  if(!p) return;
  if(name!==undefined) p.name = name.trim() || p.name;
  if(lat!==undefined && !Number.isNaN(Number(lat))) p.lat = Number(lat);
  if(lng!==undefined && !Number.isNaN(Number(lng))) p.lng = Number(lng);
  if(note!==undefined) p.note = note;
  if(url!==undefined) p.url = url;
  const marker = markers[id];
  if(marker){
    marker.setLatLng([p.lat, p.lng]);
    marker.setPopupContent(popupHtml(p));
    marker.setTooltipContent(p.name);
    const v = teamVisual(p.matches);
    marker.setIcon(makeIcon(id===selectedId, v.color, v.skull));
  }
  renderList();
  persist();
}

function selectPoint(id){
  selectedId = (selectedId===id) ? null : id;
  Object.entries(markers).forEach(([mid, m])=>{
    const pt = points.find(pp=>pp.id===Number(mid));
    const v = teamVisual(pt ? pt.matches : []);
    m.setIcon(makeIcon(Number(mid)===selectedId, v.color, v.skull));
  });
  renderList();
  if(selectedId){
    const p = points.find(p=>p.id===selectedId);
    if(p){ markers[p.id].openPopup(); }
  }
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

