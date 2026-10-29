/**
 * FC SIRIUS 会場カタログ収集
 *
 * Code.gs / Batch.gs と同じ Apps Script プロジェクトに追加する。
 * 試合データのシート・定期取込トリガーには触れず、専用の「会場カタログ」だけを更新する。
 *
 * 実行手順:
 * 1. startSiriusGroundCatalogCollection() を手動実行
 * 2. 時間主導トリガーで自動継続。完了後、必要に応じて geocodeSiriusGroundCatalogBatch() を手動実行
 * 3. 公開Webアプリの /exec?type=grounds でカタログJSONを取得可能
 */

const SIRIUS_GROUND_CATALOG_CONFIG = {
  sheetName: '会場カタログ',
  stateKey: 'SIRIUS_GROUND_CATALOG_STATE_V1',
  inventoryChunkKey: 'SIRIUS_GROUND_CATALOG_INVENTORY_',
  inventoryCountKey: 'SIRIUS_GROUND_CATALOG_INVENTORY_COUNT',
  continuationHandler: 'continueSiriusGroundCatalogCollection_',
  monthlyPagesPerRun: 8,
  upcomingPageNumbers: [2048, 2049],
  geocodeBatchSize: 10
};

const SIRIUS_GROUND_CATALOG_HEADERS = [
  'ground', 'normalizedName', 'lat', 'lng', 'geoStatus',
  'sourceCount', 'sourceUrls', 'firstSeen', 'lastSeen', 'notes', 'address', 'officialText'
];

/** 会場収集を開始する。既に進行中なら状態を壊さずエラーにする。 */
function startSiriusGroundCatalogCollection() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(SIRIUS_GROUND_CATALOG_CONFIG.stateKey)) {
    throw new Error('会場収集が進行中です。continueSiriusGroundCatalogCollection_() を実行して再開してください。');
  }

  const monthly = fetchMonthlyPageInventory_();
  if (!monthly || !monthly.length) throw new Error('公式サイトの月別ページ一覧が空です。');
  const upcoming = SIRIUS_GROUND_CATALOG_CONFIG.upcomingPageNumbers.map(function(pageNo) {
    return {
      year: 0,
      month: 0,
      url: 'https://sc.footballnavi.jp/fcsirius/page.php?pno=' + pageNo,
      kind: 'upcoming'
    };
  });
  const inventory = monthly.map(function(p) {
    return { year: p.year, month: p.month, url: p.url, kind: 'monthly' };
  }).concat(upcoming);

  saveSiriusGroundCatalogInventory_(inventory);
  props.setProperty(SIRIUS_GROUND_CATALOG_CONFIG.stateKey, JSON.stringify({
    status: 'RUNNING',
    nextIndex: 1,
    totalPages: inventory.length,
    processedPages: 0,
    candidatesFound: 0,
    startedAt: new Date().toISOString(),
    lastError: ''
  }));

  ensureSiriusGroundCatalogSheet_();
  deleteSiriusGroundCatalogTriggers_();
  console.log('会場カタログ収集開始: 月別ページ=' + monthly.length +
    ', 予定ページ=' + upcoming.length + ', 合計=' + inventory.length);
  continueSiriusGroundCatalogCollection_();
}

/** 進行中の会場収集を再開する。 */
function resumeSiriusGroundCatalogCollection() {
  const raw = PropertiesService.getScriptProperties().getProperty(SIRIUS_GROUND_CATALOG_CONFIG.stateKey);
  if (!raw) throw new Error('進行中の会場収集状態がありません。startSiriusGroundCatalogCollection() から開始してください。');
  continueSiriusGroundCatalogCollection_();
}

/** 現在の収集を停止する。既に会場カタログに記録された行は削除しない。 */
function stopSiriusGroundCatalogCollection() {
  deleteSiriusGroundCatalogTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(SIRIUS_GROUND_CATALOG_CONFIG.stateKey);
  deleteSiriusGroundCatalogInventory_();
  console.log('会場収集を停止しました。カタログに書き込まれたデータは保持しています。');
}

function continueSiriusGroundCatalogCollection_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    scheduleSiriusGroundCatalogContinuation_();
    console.log('他の処理が実行中のため、会場収集を次回に延期しました。');
    return;
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(SIRIUS_GROUND_CATALOG_CONFIG.stateKey);
    if (!raw) {
      deleteSiriusGroundCatalogTriggers_();
      console.log('会場収集状態がありません。');
      return;
    }

    const state = JSON.parse(raw);
    const inventory = loadSiriusGroundCatalogInventory_();
    if (!inventory || inventory.length !== state.totalPages) {
      throw new Error('会場収集用URL一覧がないか、件数が一致しません。状態を保持して停止しました。');
    }

    const startedAt = Date.now();
    const endIndex = Math.min(
      inventory.length,
      state.nextIndex + SIRIUS_GROUND_CATALOG_CONFIG.monthlyPagesPerRun - 1
    );

    for (let index = state.nextIndex; index <= endIndex; index++) {
      if (Date.now() - startedAt > 210000) {
        state.nextIndex = index;
        props.setProperty(SIRIUS_GROUND_CATALOG_CONFIG.stateKey, JSON.stringify(state));
        scheduleSiriusGroundCatalogContinuation_();
        console.log('実行時間上限に近づいたため一時停止。次ページ=' + index);
        return;
      }

      const page = inventory[index - 1];
      const response = fetchWithRetry_(page.url, {
        followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiriusGroundCatalog/1.0)' }
      }, 5);
      const status = response.getResponseCode();
      if (status < 200 || status >= 300) {
        state.lastError = 'HTTP ' + status + ' / ' + page.url;
        state.nextIndex = index;
        props.setProperty(SIRIUS_GROUND_CATALOG_CONFIG.stateKey, JSON.stringify(state));
        throw new Error('会場収集ページの取得に失敗しました。状態を保持しました。次ページ=' + index + ' HTTP=' + status);
      }

      const html = response.getContentText('Shift_JIS');
      let found;
      if (page.kind === 'upcoming') {
        // 既存の予定抽出ロジックを再利用し、公式予定ページから会場名を取得する。
        const matches = fetchUpcomingSiriusMatches_();
        found = matches.filter(function(m) {
          return !!m.venue && String(m.sourceUrl || '') === page.url;
        }).map(function(m) {
          return { name: m.venue, url: m.sourceUrl || page.url };
        });
      } else {
        found = extractSiriusGroundCandidatesFromMonthlyHtml_(html, page.url);
      }

      const added = upsertSiriusGroundCatalogCandidates_(found, page.url);
      state.processedPages++;
      state.candidatesFound += found.length;
      state.nextIndex = index + 1;
      state.lastError = '';
      props.setProperty(SIRIUS_GROUND_CATALOG_CONFIG.stateKey, JSON.stringify(state));

      console.log('会場収集 ' + index + '/' + inventory.length +
        ' kind=' + page.kind +
        (page.year ? ' month=' + page.year + '-' + ('0' + page.month).slice(-2) : '') +
        ' candidates=' + found.length + ' catalogUpdated=' + added +
        ' url=' + page.url);
    }

    if (state.nextIndex <= inventory.length) {
      scheduleSiriusGroundCatalogContinuation_();
      console.log('会場収集バッチ完了。次ページ=' + state.nextIndex + '/' + inventory.length);
      return;
    }

    state.status = 'COMPLETED';
    state.finishedAt = new Date().toISOString();
    props.setProperty(SIRIUS_GROUND_CATALOG_CONFIG.stateKey, JSON.stringify(state));
    deleteSiriusGroundCatalogTriggers_();
    deleteSiriusGroundCatalogInventory_();
    console.log('========== 会場カタログ収集完了 ==========');
    console.log('処理ページ=' + state.processedPages + '/' + state.totalPages);
    console.log('検出候補件数（重複を含む）=' + state.candidatesFound);
    console.log('カタログ登録会場数=' + Math.max(0, ensureSiriusGroundCatalogSheet_().getLastRow() - 1));
    console.log('公開API: WebアプリURLに ?type=grounds を付けると会場一覧JSONを返します。');
  } finally {
    lock.releaseLock();
  }
}

/** 月別結果ページから、会場らしい名称と参照元URLを抽出する。 */
function extractSiriusGroundCandidatesFromMonthlyHtml_(html, sourceUrl) {
  const plain = htmlToPlainText_(String(html || ''));
  const lines = plain.split('\n').map(function(line) {
    return String(line || '').replace(/[\t\u00a0 ]+/g, ' ').trim();
  }).filter(function(line) { return !!line; });

  const out = [];
  const seen = {};
  const venueWords = /(?:グラウンド|グランド|運動広場|運動公園|競技場|サッカー場|球技場|体育館|フットサル場|多目的G|スポーツセンター|小学校|中学校|高校|高等学校|大学|公園|ヴィラ|ビレッジ|G$|グランド$)/i;

  function addCandidate(raw) {
    const original = String(raw || '').replace(/&nbsp;|&#160;/gi, ' ').trim();
    // 公式表記の括弧内住所を保持する。
    const addressMatch = original.match(/[（(]([^）)]*(?:市|区|町|村)[^）)]*)[）)]/);
    const address = addressMatch ? String(addressMatch[1]).trim() : '';
    let name = original
      .replace(/^[・●■◆▶▷\-\s　]+/, '')
      .replace(/[・●■◆▶▷\s　]+$/, '')
      .replace(/^(?:会場|場所|グラウンド|グランド)\s*[:：]\s*/, '')
      .replace(/(?:にて|で開催|で試合).*$/, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name || name.length > 70 || name.length < 2) return;
    if (/^(?:会場|場所|グラウンド|グランド|未定|未記載|なし|不明|試合結果|対戦結果)/.test(name)) return;
    if (/^(?:FC SIRIUS|シリウス)\b/i.test(name)) return;
    if (/(?:ありがとうございました|お疲れ様|頑張り|試合でした|結果は|対戦結果|グラウンドが悪い|雨天|中止|集合時間)/.test(name)) return;
    if (!venueWords.test(name) && !/(?:会場|場所)\s*[:：]/.test(original)) return;
    const key = normalizeSiriusGroundName_(name);
    if (!key) return;
    if (seen[key]) {
      const existing = out.find(function(x) { return normalizeSiriusGroundName_(x.name) === key; });
      if (existing && !existing.address && address) {
        existing.address = address;
        existing.officialText = original;
      }
      return;
    }
    seen[key] = true;
    out.push({ name: name, url: sourceUrl, address: address, officialText: original });
  }

  lines.forEach(function(line) {
    const explicit = line.match(/(?:会場|場所)\s*[:：]\s*(.{2,80})/);
    if (explicit) addCandidate(explicit[1]);

    const at = line.match(/^(.{2,70}?)(?:にて|で開催)/);
    if (at && venueWords.test(at[1])) addCandidate(line);

    if (venueWords.test(line) && line.length <= 70) addCandidate(line);
  });

  return out;
}

/** 会場名の照合キー。表記ゆれを減らすが、元の表示名は変更しない。 */
function normalizeSiriusGroundName_(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　・,，.。()（）［］\[\]「」『』]/g, '')
    .replace(/(?:グラウンド|グランド)$/i, 'g');
}

function ensureSiriusGroundCatalogSheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SIRIUS_BATCH_SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('対象スプレッドシートがありません。setupSiriusImportDailyTrigger() を一度実行するか、紐づくGASから実行してください。');

  let sheet = ss.getSheetByName(SIRIUS_GROUND_CATALOG_CONFIG.sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(SIRIUS_GROUND_CATALOG_CONFIG.sheetName);
    sheet.getRange(1, 1, 1, SIRIUS_GROUND_CATALOG_HEADERS.length)
      .setValues([SIRIUS_GROUND_CATALOG_HEADERS]);
    sheet.setFrozenRows(1);
  } else {
    const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), SIRIUS_GROUND_CATALOG_HEADERS.length))
      .getDisplayValues()[0].map(function(v) { return String(v || '').trim(); });
    SIRIUS_GROUND_CATALOG_HEADERS.forEach(function(header) {
      if (current.indexOf(header) < 0) {
        let blankIndex = current.findIndex(function(value) { return !value; });
        if (blankIndex >= 0) {
          sheet.getRange(1, blankIndex + 1).setValue(header);
          current[blankIndex] = header;
        } else {
          current.push(header);
          sheet.getRange(1, current.length).setValue(header);
        }
      }
    });
  }
  return sheet;
}

/** 収集候補を正規化名で統合。座標・状態・メモなどの既存手入力値は保持する。 */
function upsertSiriusGroundCatalogCandidates_(candidates, fallbackUrl) {
  const sheet = ensureSiriusGroundCatalogSheet_();
  const lastRow = sheet.getLastRow();
  const rows = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, SIRIUS_GROUND_CATALOG_HEADERS.length).getValues()
    : [];
  const indexByKey = {};
  rows.forEach(function(row, i) {
    const key = String(row[1] || normalizeSiriusGroundName_(row[0]));
    if (key) indexByKey[key] = i;
  });

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  let updated = 0;

  (candidates || []).forEach(function(candidate) {
    const name = String(candidate && candidate.name || '').trim();
    const key = normalizeSiriusGroundName_(name);
    if (!name || !key) return;
    const url = String(candidate.url || fallbackUrl || '');
    if (indexByKey[key] !== undefined) {
      const row = rows[indexByKey[key]];
      const urls = String(row[6] || '').split(/\n/).filter(Boolean);
      if (url && urls.indexOf(url) < 0) urls.push(url);
      row[5] = urls.length;
      row[6] = urls.join('\n');
      row[8] = today;
      if (!row[1]) row[1] = key;
      const address = String(candidate.address || '').trim();
      const officialText = String(candidate.officialText || '').trim();
      if (address && !String(row[10] || '').trim()) row[10] = address;
      else if (address && String(row[10] || '').trim() !== address) {
        row[9] = (String(row[9] || '') + '\n住所候補差異：' + address).trim();
        if (String(row[4] || '') !== '確認済み') row[4] = '要確認';
      }
      if (officialText && !String(row[11] || '').trim()) row[11] = officialText;
      updated++;
      return;
    }

    const newRow = [
      name, key, '', '', '住所確認待ち', url ? 1 : 0, url,
      today, today, '', String(candidate.address || '').trim(), String(candidate.officialText || '').trim()
    ];
    indexByKey[key] = rows.length;
    rows.push(newRow);
    updated++;
  });

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, SIRIUS_GROUND_CATALOG_HEADERS.length).setValues(rows);
  }
  return updated;
}

/** カタログをAPI用の軽量JSON配列にする。 */
function getSiriusGroundCatalogForApi_() {
  const sheet = ensureSiriusGroundCatalogSheet_();
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const ix = {};
  headers.forEach(function(h, i) { ix[h] = i; });
  return values.slice(1).filter(function(row) {
    return String(row[ix.ground] || '').trim() !== '';
  }).map(function(row) {
    return {
      ground: row[ix.ground],
      lat: row[ix.lat] === '' ? null : Number(row[ix.lat]),
      lng: row[ix.lng] === '' ? null : Number(row[ix.lng]),
      geoStatus: row[ix.geoStatus] || '未調査',
      sourceCount: Number(row[ix.sourceCount] || 0),
      sourceUrls: String(row[ix.sourceUrls] || '').split('\n').filter(Boolean),
      notes: row[ix.notes] || '',
      address: ix.address === undefined ? '' : String(row[ix.address] || ''),
      officialText: ix.officialText === undefined ? '' : String(row[ix.officialText] || '')
    };
  });
}

/**
 * 会場座標を未調査分だけ最大10件ずつ取得する。
 * 取得結果はすべて「要確認」とし、地図上での確定前に人が確認する。
 * 既に座標がある行や「未取得」と記録済みの行は再検索しない。
 */
/**
 * 住所が抽出されている行だけを座標検索する。
 * 会場名だけでの検索は禁止。取得座標は「要確認」として人の確認を必須にする。
 */
function geocodeSiriusGroundCatalogBatch() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GOOGLE_MAPS_API_KEY');
  if (!apiKey) {
    throw new Error('スクリプトプロパティ GOOGLE_MAPS_API_KEY がありません。Google Places API (New) を有効にしたAPIキーを設定してください。');
  }

  const sheet = ensureSiriusGroundCatalogSheet_();
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) { console.log('会場カタログに会場がありません。'); return; }
  const headers = all[0].map(function(v) { return String(v || '').trim(); });
  const ix = {};
  headers.forEach(function(h, i) { ix[h] = i; });
  ['ground', 'lat', 'lng', 'geoStatus', 'address', 'notes'].forEach(function(h) {
    if (ix[h] === undefined) throw new Error('必要列がありません: ' + h);
  });

  let attempted = 0, located = 0, failed = 0;
  const max = SIRIUS_GROUND_CATALOG_CONFIG.geocodeBatchSize || 10;

  for (let i = 1; i < all.length && attempted < max; i++) {
    const row = all[i];
    const name = String(row[ix.ground] || '').trim();
    if (!name || String(row[ix.geoStatus] || '') === '確認済み') continue;
    if ((row[ix.lat] !== '' && row[ix.lat] != null) || (row[ix.lng] !== '' && row[ix.lng] != null)) continue;

    const address = String(row[ix.address] || '').trim();
    const officialText = ix.officialText === undefined ? '' : String(row[ix.officialText] || '').trim();
    // 住所だけのジオコーディングではなく、Google Maps上の施設検索結果(Places API)を優先する。
    // 住所がある場合は検索語に加え、同名施設の誤選択を抑える。
    const query = [name, address].filter(Boolean).join(' ');
    attempted++;

    try {
      const place = searchSiriusGroundPlace_(query || officialText || name, apiKey);
      if (!place || !place.location) {
        row[ix.geoStatus] = '未取得';
        failed++;
        console.warn('Google Maps施設検索で候補なし: ' + name + ' / query=' + query);
        continue;
      }

      row[ix.lat] = Number(place.location.latitude);
      row[ix.lng] = Number(place.location.longitude);
      row[ix.geoStatus] = '要確認';

      const placeName = place.displayName && place.displayName.text ? place.displayName.text : '';
      const placeAddress = String(place.formattedAddress || '');
      const mapsUrl = String(place.googleMapsUri || '');
      const placeId = String(place.id || '');
      const note = [
        'Google Places検索候補（未確認）',
        '検索語=' + query,
        '候補施設名=' + placeName,
        '候補住所=' + placeAddress,
        'place_id=' + placeId,
        'Google Maps=' + mapsUrl
      ].join('\n');
      const existingNotes = String(row[ix.notes] || '').trim();
      row[ix.notes] = existingNotes ? existingNotes + '\n' + note : note;
      located++;
      console.log('施設検索候補取得: ' + name + ' => ' + placeName + ' / ' + placeAddress + ' / ' + mapsUrl);
    } catch (e) {
      row[ix.geoStatus] = '未取得';
      failed++;
      console.warn('Google Places検索失敗: ' + name + ' / ' + e);
    }

    // APIへの連続アクセスを少し抑制する。
    Utilities.sleep(150);
  }

  sheet.getRange(1, 1, all.length, headers.length).setValues(all);
  console.log('Google Maps施設検索完了: 試行=' + attempted + ', 座標候補取得=' + located +
    ', 失敗=' + failed + '。取得座標はすべて「要確認」です。候補住所とGoogle Maps URLをメモ欄で確認し、現地のグラウンドと一致した場合のみ「確認済み」にしてください。');
}

/**
 * Google Places API (New) のテキスト検索で施設候補を取得する。
 * APIキーはスクリプトプロパティ GOOGLE_MAPS_API_KEY に保存する。
 * 戻り値の先頭候補は自動確定せず、呼び出し側で必ず「要確認」とする。
 */
function searchSiriusGroundPlace_(query, apiKey) {
  const url = 'https://places.googleapis.com/v1/places:searchText';
  const payload = {
    textQuery: String(query || '').trim(),
    languageCode: 'ja',
    regionCode: 'JP',
    maxResultCount: 5
  };
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri'
    },
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('Places API HTTP ' + status + ': ' + body.slice(0, 500));
  }
  const data = JSON.parse(body || '{}');
  const places = Array.isArray(data.places) ? data.places : [];
  if (!places.length) return null;

  // 候補一覧の全件をシートに格納する機能ではなく、最上位候補を仮置きする。
  // 座標を地図に出すには、候補住所・地図リンクを人が確認してからgeoStatusを変更する。
  return places[0];
}

/** 未確認の旧座標をクリアする。geoStatus=確認済みの行は保持する。 */
function clearUnverifiedSiriusGroundCatalogCoordinates() {
  const sheet = ensureSiriusGroundCatalogSheet_();
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) return;
  const headers = all[0].map(function(v) { return String(v || '').trim(); }), ix = {};
  headers.forEach(function(h, i) { ix[h] = i; });
  let cleared = 0;
  for (let i = 1; i < all.length; i++) {
    const row = all[i];
    if (String(row[ix.geoStatus] || '') === '確認済み') continue;
    if (row[ix.lat] !== '' || row[ix.lng] !== '') {
      row[ix.lat] = ''; row[ix.lng] = '';
      row[ix.geoStatus] = String(row[ix.address] || '').trim() ? '住所あり・未測位' : '住所なし';
      cleared++;
    }
  }
  sheet.getRange(1, 1, all.length, headers.length).setValues(all);
  console.log('未確認座標のクリア完了: ' + cleared + '件。確認済み行は変更していません。');
}

/** 収集用URL一覧を分割保存し、PropertiesServiceのサイズ制限を避ける。 */
function saveSiriusGroundCatalogInventory_(inventory) {
  deleteSiriusGroundCatalogInventory_();
  const props = PropertiesService.getScriptProperties();
  const chunkSize = 40;
  const count = Math.ceil(inventory.length / chunkSize);
  for (let i = 0; i < count; i++) {
    props.setProperty(SIRIUS_GROUND_CATALOG_CONFIG.inventoryChunkKey + i,
      JSON.stringify(inventory.slice(i * chunkSize, (i + 1) * chunkSize)));
  }
  props.setProperty(SIRIUS_GROUND_CATALOG_CONFIG.inventoryCountKey, String(count));
}

function loadSiriusGroundCatalogInventory_() {
  const props = PropertiesService.getScriptProperties();
  const count = Number(props.getProperty(SIRIUS_GROUND_CATALOG_CONFIG.inventoryCountKey) || 0);
  if (!count) return null;
  const inventory = [];
  for (let i = 0; i < count; i++) {
    const raw = props.getProperty(SIRIUS_GROUND_CATALOG_CONFIG.inventoryChunkKey + i);
    if (!raw) return null;
    inventory.push.apply(inventory, JSON.parse(raw));
  }
  return inventory;
}

function deleteSiriusGroundCatalogInventory_() {
  const props = PropertiesService.getScriptProperties();
  const count = Number(props.getProperty(SIRIUS_GROUND_CATALOG_CONFIG.inventoryCountKey) || 0);
  for (let i = 0; i < count; i++) {
    props.deleteProperty(SIRIUS_GROUND_CATALOG_CONFIG.inventoryChunkKey + i);
  }
  props.deleteProperty(SIRIUS_GROUND_CATALOG_CONFIG.inventoryCountKey);
}

function scheduleSiriusGroundCatalogContinuation_() {
  deleteSiriusGroundCatalogTriggers_();
  ScriptApp.newTrigger(SIRIUS_GROUND_CATALOG_CONFIG.continuationHandler)
    .timeBased().after(60 * 1000).create();
}

function deleteSiriusGroundCatalogTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === SIRIUS_GROUND_CATALOG_CONFIG.continuationHandler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/** 読み取り専用の抽出確認。指定ページから会場候補をログ出力する。 */
function previewSiriusGroundCandidates() {
  const inventory = fetchMonthlyPageInventory_();
  const sample = inventory.slice(-3);
  sample.forEach(function(page) {
    const response = fetchWithRetry_(page.url, {
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiriusGroundCatalog/1.0)' }
    }, 5);
    const found = extractSiriusGroundCandidatesFromMonthlyHtml_(
      response.getContentText('Shift_JIS'), page.url
    );
    console.log('PAGE ' + page.year + '-' + page.month + ' candidates=' + found.length + ' ' + page.url);
    found.forEach(function(item) { console.log(item.name + '\t' + item.url); });
  });
}