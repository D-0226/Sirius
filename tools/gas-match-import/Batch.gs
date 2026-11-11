/**
 * FC SIRIUS 定期取込バッチ
 *
 * Code.gs と同じApps Scriptプロジェクトに追加して使用する。
 * 公式サイトの全月別ページを取得し、対外戦績は「全学年データ」、
 * チーム内対戦は「チーム内対戦データ」に分離して追記する。
 * 解析失敗・既存行と競合する候補は「取込要確認」に記録する。
 */

const SIRIUS_BATCH_CONFIG = {
  externalSheetName: '全学年データ',
  internalSheetName: 'チーム内対戦データ',
  reviewSheetName: '取込要確認',
  logSheetName: '取込ログ',
  triggerHandler: 'runSiriusImportBatch',
  triggerHour: 3
};

/**
 * 初回に手動実行する。現在のスプレッドシートIDを保存し、毎日1回のトリガーを登録する。
 * 既存の同じハンドラのトリガーは重複登録しない。
 */
function setupSiriusImportDailyTrigger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('対象スプレッドシートに紐づいたApps Scriptから実行してください。');

  PropertiesService.getScriptProperties().setProperty('SIRIUS_BATCH_SPREADSHEET_ID', ss.getId());
  deleteSiriusImportDailyTriggers_();
  ScriptApp.newTrigger(SIRIUS_BATCH_CONFIG.triggerHandler)
    .timeBased()
    .everyDays(1)
    .atHour(SIRIUS_BATCH_CONFIG.triggerHour)
    .create();

  ensureSiriusBatchSheet_(ss, SIRIUS_BATCH_CONFIG.reviewSheetName,
    ['timestamp', 'status', 'year', 'month', 'sourceUrl', 'raw', 'details']);
  ensureSiriusBatchSheet_(ss, SIRIUS_BATCH_CONFIG.logSheetName,
    ['timestamp', 'status', 'pages', 'candidates', 'addedExternal', 'addedInternal', 'duplicates', 'review', 'errors', 'details']);
  console.log('毎日 ' + SIRIUS_BATCH_CONFIG.triggerHour + '時台の取込トリガーを登録しました。Spreadsheet=' + ss.getName());
}

/** 定期実行を停止する。スプレッドシートのデータは削除しない。 */
function stopSiriusImportDailyTrigger() {
  deleteSiriusImportDailyTriggers_();
  console.log('定期取込トリガーを停止しました。既存データは変更していません。');
}

/**
 * 定期取込の本体。手動実行による動作確認にも使用できる。
 * 全対象ページの取得が成功するまでデータ行は書き込まない。
 */
function runSiriusImportBatch() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.warn('別の取込処理が実行中のため、今回はスキップしました。');
    return;
  }

  const startedAt = new Date();
  const summary = {
    pages: 0, candidates: 0, addedExternal: 0, addedInternal: 0,
    duplicates: 0, review: 0, errors: 0, details: []
  };
  let ss = null;

  try {
    const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SIRIUS_BATCH_SPREADSHEET_ID');
    if (spreadsheetId) {
      ss = SpreadsheetApp.openById(spreadsheetId);
    } else {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    }
    if (!ss) throw new Error('対象スプレッドシートが未設定です。setupSiriusImportDailyTriggerを先に実行してください。');

    const externalSheet = ss.getSheetByName(SIRIUS_BATCH_CONFIG.externalSheetName);
    if (!externalSheet) throw new Error('タブ「' + SIRIUS_BATCH_CONFIG.externalSheetName + '」がありません。');
    const externalHeaders = ensureSiriusExternalHeaders_(externalSheet);
    const internalSheet = ensureSiriusBatchSheet_(ss, SIRIUS_BATCH_CONFIG.internalSheetName,
      ['date', 'category', 'teamA', 'teamB', 'score', 'pkScore', 'result', 'sourceUrl', 'raw']);
    const reviewSheet = ensureSiriusBatchSheet_(ss, SIRIUS_BATCH_CONFIG.reviewSheetName,
      ['timestamp', 'status', 'year', 'month', 'sourceUrl', 'raw', 'details']);
    const logSheet = ensureSiriusBatchSheet_(ss, SIRIUS_BATCH_CONFIG.logSheetName,
      ['timestamp', 'status', 'pages', 'candidates', 'addedExternal', 'addedInternal', 'duplicates', 'review', 'errors', 'details']);

    const inventory = fetchMonthlyPageInventory_();
    const parsedRecords = [];

    // 全ページを先に取得。HTTPエラーがあれば、データ行の追加は行わない。
    inventory.forEach(function(page) {
      const fetched = fetchMatchCandidates_(page.url, page.year, page.month);
      if (fetched.status < 200 || fetched.status >= 300) {
        throw new Error('月別ページ取得失敗: ' + page.year + '-' + page.month + ' HTTP=' + fetched.status + ' URL=' + page.url);
      }
      summary.pages++;
      summary.candidates += fetched.candidates.length;
      fetched.candidates.forEach(function(candidate) {
        const row = parseCandidateToCsvRow_(candidate);
        parsedRecords.push({
          page: page,
          candidate: candidate,
          row: row
        });
      });
    });

    const externalState = loadSiriusExternalState_(externalSheet, externalHeaders, ss);
    const internalState = loadSiriusInternalState_(internalSheet);
    const externalRowsToAppend = [];
    const internalRowsToAppend = [];
    const reviewRowsToAppend = [];
    const batchExternalExact = new Set();
    const batchExternalIdentity = new Map();
    const batchExternalLegacyIdentity = new Set();
    const venueUpdates = new Map();
    const batchInternalExact = new Set();

    parsedRecords.forEach(function(record) {
      const page = record.page;
      const candidate = record.candidate;
      const row = record.row;

      if (!row) {
        summary.review++;
        reviewRowsToAppend.push([
          startedAt, '解析失敗', page.year, page.month, page.url,
          candidate.text, '結果行を解析できません。公式ページを目視確認してください。'
        ]);
        return;
      }

      const sourceUrl = page.url;
      if (isInternalSiriusMatch_(row.team)) {
        const internal = normalizeSiriusInternalRecord_(row, sourceUrl, candidate.text);
        if (!internal) {
          summary.review++;
          reviewRowsToAppend.push([
            startedAt, '内部対戦要確認', page.year, page.month, sourceUrl,
            candidate.text, '内部対戦のチーム名またはスコアを正規化できません。'
          ]);
          return;
        }
        const exactKey = siriusInternalExactKey_(internal);
        const identityKey = siriusInternalIdentityKey_(internal);
        if (internalState.exact.has(exactKey) || batchInternalExact.has(exactKey)) {
          summary.duplicates++;
          return;
        }
        const oldInternal = internalState.byIdentity.get(identityKey);
        if (oldInternal) {
          summary.review++;
          reviewRowsToAppend.push([
            startedAt, '内部対戦の既存記録と差異', page.year, page.month, sourceUrl,
            candidate.text, '既存=' + JSON.stringify(oldInternal) + ' / 取得=' + JSON.stringify(internal)
          ]);
          return;
        }
        batchInternalExact.add(exactKey);
        internalRowsToAppend.push([
          internal.date, internal.category, internal.teamA, internal.teamB,
          internal.score, internal.pkScore, internal.result, sourceUrl, candidate.text
        ]);
        internalState.exact.add(exactKey);
        internalState.byIdentity.set(identityKey, internal);
        summary.addedInternal++;
        return;
      }

      const external = {
        team: row.team,
        date: row.date || '',
        category: row.category || '',
        score: row.score || '',
        result: row.result || '',
        siriusTeam: row.siriusTeam || '',
        pkScore: row.pkScore || '',
        place: row.place || ''
      };
      const exactKey = siriusExternalExactKey_(external);
      const identityKey = siriusExternalIdentityKey_(external);
      if (externalState.exact.has(exactKey) || batchExternalExact.has(exactKey)) {
        // 既存行の会場が空欄の場合だけ補完する。既存の会場値は上書きしない。
        if (externalState.exact.has(exactKey) && external.place) {
          const existingExact = externalState.byExact.get(exactKey);
          if (existingExact && !existingExact.place) venueUpdates.set(existingExact.rowNumber, external.place);
        }
        summary.duplicates++;
        return;
      }
      const legacyKey = siriusExternalLegacyIdentityKey_(external);
      const oldExternal = externalState.byIdentity.get(identityKey) || batchExternalIdentity.get(identityKey) ||
        externalState.legacyByIdentity.get(legacyKey) || (batchExternalLegacyIdentity.has(legacyKey) ? { legacyRecord: true } : null);
      if (oldExternal) {
        summary.review++;
        reviewRowsToAppend.push([
          startedAt, '対外戦績の既存記録と差異', page.year, page.month, sourceUrl,
          candidate.text, '既存=' + JSON.stringify(oldExternal) + ' / 取得=' + JSON.stringify(external)
        ]);
        return;
      }

      batchExternalExact.add(exactKey);
      batchExternalIdentity.set(identityKey, external);
      batchExternalLegacyIdentity.add(legacyKey);
      externalRowsToAppend.push(siriusMapExternalRow_(externalHeaders, external));
      externalState.exact.add(exactKey);
      externalState.byIdentity.set(identityKey, external);
      summary.addedExternal++;
    });

    // 既存の会場欄が空欄の完全一致レコードだけ補完する。非空欄の既存値は変更しない。
    const placeColumn = externalHeaders.indexOf('place') + 1;
    venueUpdates.forEach(function(place, rowNumber) {
      if (placeColumn > 0) externalSheet.getRange(rowNumber, placeColumn).setValue(place);
    });

    // 集計結果をまとめて書き込み。既存行の上書き・削除はしない。
    if (externalRowsToAppend.length) {
      externalSheet.getRange(externalSheet.getLastRow() + 1, 1, externalRowsToAppend.length, externalHeaders.length)
        .setValues(externalRowsToAppend);
    }
    if (internalRowsToAppend.length) {
      internalSheet.getRange(internalSheet.getLastRow() + 1, 1, internalRowsToAppend.length, 9)
        .setValues(internalRowsToAppend);
    }
    if (reviewRowsToAppend.length) {
      reviewSheet.getRange(reviewSheet.getLastRow() + 1, 1, reviewRowsToAppend.length, 7)
        .setValues(reviewRowsToAppend);
    }

    summary.details.push('取得ページ=' + inventory.length);
    summary.details.push('対外追加=' + summary.addedExternal);
    summary.details.push('内部対戦追加=' + summary.addedInternal);
    summary.details.push('重複スキップ=' + summary.duplicates);
    summary.details.push('要確認=' + summary.review);
    appendSiriusBatchLog_(logSheet, startedAt, '完了', summary);
    console.log('SIRIUS定期取込完了: ' + summary.details.join(' / '));
  } catch (error) {
    summary.errors++;
    summary.details.push(String(error && error.stack ? error.stack : error));
    if (ss) {
      const logSheet = ensureSiriusBatchSheet_(ss, SIRIUS_BATCH_CONFIG.logSheetName,
        ['timestamp', 'status', 'pages', 'candidates', 'addedExternal', 'addedInternal', 'duplicates', 'review', 'errors', 'details']);
      appendSiriusBatchLog_(logSheet, startedAt, '失敗', summary);
    }
    console.error('SIRIUS定期取込失敗。詳細=' + summary.details.join(' / '));
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function ensureSiriusExternalHeaders_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  let headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0]
    .map(function(v) { return String(v || '').trim(); });
  const required = ['team', 'date', 'category', 'score', 'result'];
  required.forEach(function(name) {
    if (headers.indexOf(name) < 0) throw new Error('「' + sheet.getName() + '」に必要な列 ' + name + ' がありません。');
  });
  ['siriusTeam', 'pkScore', 'place'].forEach(function(name) {
    if (headers.indexOf(name) < 0) {
      headers.push(name);
      sheet.getRange(1, headers.length).setValue(name);
    }
  });
  return headers;
}

function ensureSiriusBatchSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else {
    const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length))
      .getDisplayValues()[0].map(function(v) { return String(v || '').trim(); });
    headers.forEach(function(header) {
      if (current.indexOf(header) < 0) {
        const col = current.findIndex(function(v) { return !v; });
        const targetCol = col >= 0 ? col + 1 : current.length + 1;
        sheet.getRange(1, targetCol).setValue(header);
        current[targetCol - 1] = header;
      }
    });
    const managedPrefix = current.slice(0, headers.length);
    if (headers.some(function(header, i) { return managedPrefix[i] !== header; })) {
      throw new Error('タブ「' + name + '」の列順が想定と異なります。データの誤書込を防ぐため停止しました。期待列=' + headers.join(',') + ' / 現在=' + managedPrefix.join(','));
    }
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function loadSiriusExternalState_(sheet, headers, ss) {
  const values = sheet.getDataRange().getValues();
  const idx = {};
  headers.forEach(function(h, i) { idx[h] = i; });
  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  const exact = new Set();
  const byExact = new Map();
  const byIdentity = new Map();
  const legacyByIdentity = new Map();
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r.every(function(v) { return v === '' || v == null; })) continue;
    const obj = {
      team: r[idx.team], date: normalizeSheetDate_(r[idx.date], tz),
      category: r[idx.category], score: r[idx.score], result: r[idx.result],
      siriusTeam: idx.siriusTeam >= 0 ? r[idx.siriusTeam] : '',
      pkScore: idx.pkScore >= 0 ? r[idx.pkScore] : '',
      place: idx.place >= 0 ? String(r[idx.place] || '') : ''
    };
    const exactKey = siriusExternalExactKey_(obj);
    exact.add(exactKey);
    if (!byExact.has(exactKey)) byExact.set(exactKey, {rowNumber:i + 1, place:obj.place});
    const identity = siriusExternalIdentityKey_(obj);
    if (!byIdentity.has(identity)) byIdentity.set(identity, obj);
    // 旧データにsiriusTeam列がない／空欄の場合、歴史データの再取込を避けるため
    // 日付・カテゴリ・対戦相手が一致した候補は自動追加せず要確認に回す。
    if (!normalizeMatchText_(obj.siriusTeam)) {
      const legacyIdentity = siriusExternalLegacyIdentityKey_(obj);
      if (!legacyByIdentity.has(legacyIdentity)) legacyByIdentity.set(legacyIdentity, obj);
    }
  }
  return { exact: exact, byExact: byExact, byIdentity: byIdentity, legacyByIdentity: legacyByIdentity };
}

function loadSiriusInternalState_(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function(v) { return String(v || '').trim(); });
  const idx = {};
  headers.forEach(function(h, i) { idx[h] = i; });
  const exact = new Set();
  const byIdentity = new Map();
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r.every(function(v) { return v === '' || v == null; })) continue;
    const obj = {
      date: String(r[idx.date] || ''), category: String(r[idx.category] || ''),
      teamA: String(r[idx.teamA] || ''), teamB: String(r[idx.teamB] || ''),
      score: String(r[idx.score] || ''), pkScore: String(r[idx.pkScore] || ''),
      result: String(r[idx.result] || '')
    };
    exact.add(siriusInternalExactKey_(obj));
    const identity = siriusInternalIdentityKey_(obj);
    if (!byIdentity.has(identity)) byIdentity.set(identity, obj);
  }
  return { exact: exact, byIdentity: byIdentity };
}

function siriusMapExternalRow_(headers, obj) {
  return headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(obj, header) ? obj[header] : '';
  });
}

function siriusExternalExactKey_(m) {
  return [
    normalizeMatchText_(m.team), normalizeMatchText_(m.date), normalizeMatchText_(m.category),
    normalizeMatchText_(m.score).replace(/[－―−：]/g, '-'), normalizeMatchText_(m.result),
    normalizeMatchText_(m.siriusTeam), normalizeMatchText_(m.pkScore).replace(/[－―−：]/g, '-')
  ].join('|');
}

function siriusExternalLegacyIdentityKey_(m) {
  return [
    normalizeMatchText_(m.date), normalizeMatchText_(m.category),
    normalizeMatchText_(m.team)
  ].join('|');
}

function siriusExternalIdentityKey_(m) {
  return [
    normalizeMatchText_(m.date), normalizeMatchText_(m.category),
    normalizeMatchText_(m.team), normalizeMatchText_(m.siriusTeam)
  ].join('|');
}

function normalizeSiriusInternalRecord_(row, sourceUrl, raw) {
  const side = String(row.siriusTeam || '').trim();
  const opponent = String(row.team || '').trim();
  if (!side || !opponent || !isInternalSiriusMatch_(opponent)) return null;

  const sideFirst = normalizeMatchText_(side).replace(/[\u3000\s]+/g, '').toUpperCase()
    .localeCompare(normalizeMatchText_(opponent).replace(/[\u3000\s]+/g, '').toUpperCase()) <= 0;
  const teamA = sideFirst ? side : opponent;
  const teamB = sideFirst ? opponent : side;
  const score = sideFirst ? row.score : siriusInvertScore_(row.score);
  const pkScore = sideFirst ? row.pkScore : siriusInvertScore_(row.pkScore);
  let result = sideFirst ? row.result : siriusFlipResult_(row.result);

  const normal = String(score || '').match(/^(\d+)-(\d+)$/);
  const pk = String(pkScore || '').match(/^(\d+)-(\d+)$/);
  if (normal && Number(normal[1]) !== Number(normal[2])) {
    result = Number(normal[1]) > Number(normal[2]) ? '勝' : '敗';
  } else if (pk && Number(pk[1]) !== Number(pk[2])) {
    result = Number(pk[1]) > Number(pk[2]) ? '勝' : '敗';
  }
  return {
    date: row.date || '', category: row.category || '', teamA: teamA, teamB: teamB,
    score: score || '', pkScore: pkScore || '', result: result || '',
    sourceUrl: sourceUrl, raw: raw || ''
  };
}

function siriusInternalExactKey_(m) {
  return [
    normalizeMatchText_(m.date), normalizeMatchText_(m.category),
    normalizeMatchText_(m.teamA), normalizeMatchText_(m.teamB),
    normalizeMatchText_(m.score).replace(/[－―−：]/g, '-'),
    normalizeMatchText_(m.pkScore).replace(/[－―−：]/g, '-')
  ].join('|');
}

function siriusInternalIdentityKey_(m) {
  return [
    normalizeMatchText_(m.date), normalizeMatchText_(m.category),
    normalizeMatchText_(m.teamA), normalizeMatchText_(m.teamB)
  ].join('|');
}

function siriusInvertScore_(score) {
  const match = String(score || '').match(/^(\d+)\s*[-－―−:：]\s*(\d+)$/);
  return match ? match[2] + '-' + match[1] : String(score || '');
}

function siriusFlipResult_(result) {
  return result === '勝' ? '敗' : result === '敗' ? '勝' : result;
}

function appendSiriusBatchLog_(sheet, timestamp, status, summary) {
  sheet.appendRow([
    timestamp, status, summary.pages, summary.candidates,
    summary.addedExternal, summary.addedInternal, summary.duplicates,
    summary.review, summary.errors, summary.details.join(' / ')
  ]);
}

function deleteSiriusImportDailyTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === SIRIUS_BATCH_CONFIG.triggerHandler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}


/**
 * 過去会場データ補完の読み取り専用プレビュー。
 * 2025年以降を3か月ページずつ走査し、既存「全学年データ」と照合する。
 * シートへの書き込みは一切行わない。成功したバッチだけプレビュー位置を進める。
 */
function previewSiriusVenueBackfillBatch() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('別の処理が実行中です。');
  try {
    const ss = getSiriusBackfillSpreadsheet_();
    const sheet = ss.getSheetByName(SIRIUS_BATCH_CONFIG.externalSheetName);
    if (!sheet) throw new Error('タブ「' + SIRIUS_BATCH_CONFIG.externalSheetName + '」がありません。');
    const values = sheet.getDataRange().getValues();
    if (!values.length) throw new Error('全学年データにヘッダーがありません。');
    const headers = values[0].map(function(v) { return String(v || '').trim(); });
    const idx = {};
    headers.forEach(function(h, i) { idx[h] = i; });
    ['team', 'date', 'category', 'score', 'result'].forEach(function(h) {
      if (idx[h] == null) throw new Error('必要な列「' + h + '」がありません。');
    });

    const inventory = fetchMonthlyPageInventory_();
    const props = PropertiesService.getScriptProperties();
    const start = Math.max(1, Number(props.getProperty('SIRIUS_VENUE_PREVIEW_CURSOR') || 1));
    const size = 3;
    const batch = inventory.slice(start - 1, start - 1 + size);
    if (!batch.length) {
      console.log('プレビュー完了。全ページ走査済みです。総ページ数=' + inventory.length);
      return;
    }

    const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
    const exactRows = new Map();
    const legacyRows = new Map();
    function addIndex(map, key, rowNumber) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(rowNumber);
    }
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (r.every(function(v) { return v === '' || v == null; })) continue;
      const obj = {
        team: r[idx.team],
        date: normalizeSheetDate_(r[idx.date], tz),
        category: r[idx.category],
        score: r[idx.score],
        result: r[idx.result],
        siriusTeam: idx.siriusTeam == null ? '' : r[idx.siriusTeam],
        pkScore: idx.pkScore == null ? '' : r[idx.pkScore]
      };
      addIndex(exactRows, siriusExternalExactKey_(obj), i + 1);
      const legacyKey = [
        normalizeMatchText_(obj.date), normalizeMatchText_(obj.category),
        normalizeMatchText_(obj.team), normalizeMatchText_(obj.score).replace(/[－―−：]/g, '-'),
        normalizeMatchText_(obj.result)
      ].join('|');
      addIndex(legacyRows, legacyKey, i + 1);
    }

    const counts = {pages:0,candidates:0,withVenue:0,missingDate:0,parseFailures:0,internal:0,exact:0,legacyUnique:0,ambiguous:0,notFound:0};
    const samples = [];
    batch.forEach(function(page) {
      const fetched = fetchMatchCandidates_(page.url, page.year, page.month);
      if (fetched.status < 200 || fetched.status >= 300) {
        throw new Error('取得失敗。カーソルは進めていません: ' + page.year + '-' + page.month + ' HTTP=' + fetched.status);
      }
      counts.pages++;
      fetched.candidates.forEach(function(candidate) {
        counts.candidates++;
        const row = parseCandidateToCsvRow_(candidate);
        if (!row) { counts.parseFailures++; return; }
        if (!row.place) return;
        counts.withVenue++;
        if (!row.date) { counts.missingDate++; if (samples.length < 12) samples.push(page.year + '-' + ('0' + page.month).slice(-2) + ' 日付未取得 / ' + row.team + ' / ' + row.place); return; }
        if (isInternalSiriusMatch_(row.team)) { counts.internal++; return; }
        const exactKey = siriusExternalExactKey_(row);
        const exact = exactRows.get(exactKey) || [];
        let status = '';
        let rowNumber = 0;
        if (exact.length === 1) {
          counts.exact++; status = '完全一致'; rowNumber = exact[0];
        } else if (exact.length > 1) {
          counts.ambiguous++; status = '完全一致が複数';
        } else {
          const legacyKey = [
            normalizeMatchText_(row.date), normalizeMatchText_(row.category),
            normalizeMatchText_(row.team), normalizeMatchText_(row.score).replace(/[－―−：]/g, '-'),
            normalizeMatchText_(row.result)
          ].join('|');
          const legacy = legacyRows.get(legacyKey) || [];
          if (legacy.length === 1) { counts.legacyUnique++; status = '旧形式で一意一致'; rowNumber = legacy[0]; }
          else if (legacy.length > 1) { counts.ambiguous++; status = '旧形式で複数一致'; }
          else { counts.notFound++; status = '既存行なし'; }
        }
        if (samples.length < 12) {
          samples.push(page.year + '-' + ('0' + page.month).slice(-2) + ' ' + status +
            ' / ' + row.date + ' / ' + row.team + ' / ' + row.siriusTeam +
            ' / ' + row.place + (rowNumber ? ' / sheetRow=' + rowNumber : ''));
        }
      });
    });

    console.log('会場補完プレビュー（読み取り専用）');
    console.log('対象ページ=' + start + '-' + (start + batch.length - 1) + ' / 総ページ=' + inventory.length);
    console.log('既存シート列=' + headers.join(','));
    console.log('集計=' + JSON.stringify(counts));
    samples.forEach(function(s) { console.log('SAMPLE ' + s); });
    if (counts.missingDate > 0) {
      console.log('停止: 試合日が取得できない候補があります。カーソルは進めていません。日付解析を修正してから再実行してください。');
      throw new Error('日付未取得=' + counts.missingDate + '。誤照合防止のためプレビューを停止しました。');
    }
    const nextCursor = start + batch.length;
    props.setProperty('SIRIUS_VENUE_PREVIEW_CURSOR', String(nextCursor));
    const totals = accumulateSiriusVenuePreviewTotals_(counts);
    console.log('次回プレビュー開始位置=' + nextCursor);
    if (nextCursor > inventory.length) {
      console.log('全ページのプレビュー完了。累計=' + JSON.stringify(totals));
    }
    console.log('シートへの書き込み・既存データ変更は行っていません。');
  } finally {
    lock.releaseLock();
  }
}

/** プレビュー走査位置だけを先頭に戻す。シートのデータは変更しない。 */
function resetSiriusVenueBackfillPreview() {
  PropertiesService.getScriptProperties().deleteProperty('SIRIUS_VENUE_PREVIEW_CURSOR');
  console.log('会場補完プレビュー位置を1に戻しました。シートのデータは変更していません。');
}

function getSiriusBackfillSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SIRIUS_BATCH_SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('対象スプレッドシートが未設定です。');
  return ss;
}


/**
 * 会場補完の最初の月別ページについて、日付見出しの実際の表記を確認する。
 * 読み取り専用。HTMLの文字列行と候補の日付をログ出力する。
 */
function diagnoseSiriusVenueBackfillDates() {
  const inventory = fetchMonthlyPageInventory_();
  const page = inventory[0];
  const response = UrlFetchApp.fetch(page.url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiriusMatchPreview/1.0)' }
  });
  const status = response.getResponseCode();
  const lines = htmlToPlainText_(response.getContentText('Shift_JIS')).split('\\n')
    .map(function(line) { return normalizeFullWidthDigits_(line).replace(/[\\t\\u00a0 ]+/g, ' ').trim(); })
    .filter(function(line) { return line.length > 0; });
  console.log('DATE DIAG page=' + page.year + '-' + ('0' + page.month).slice(-2) + ' URL=' + page.url + ' HTTP=' + status);
  let printed = 0;
  lines.forEach(function(line, index) {
    if (!/(月|日|20\\d{2}[\\/.-]|\\d{1,2}[\\/.-]\\d{1,2})/.test(line)) return;
    if (printed >= 50) return;
    console.log('DATE LINE ' + (index + 1) + ': ' + line);
    printed++;
  });
  const parsed = fetchMatchCandidates_(page.url, page.year, page.month);
  console.log('候補=' + parsed.candidates.length + ' / 日付あり=' +
    parsed.candidates.filter(function(c) { return !!c.date; }).length +
    ' / 日付なし=' + parsed.candidates.filter(function(c) { return !c.date; }).length);
  parsed.candidates.slice(0, 10).forEach(function(c, i) {
    console.log('CANDIDATE ' + (i + 1) + ' date=' + c.date + ' category=' + c.category + ' text=' + c.text);
  });
}


/**
 * 会場補完プレビューの累計をスクリプトプロパティに保存する。
 * Google Sheetsのデータは変更しない。
 */
function accumulateSiriusVenuePreviewTotals_(counts) {
  const props = PropertiesService.getScriptProperties();
  const key = 'SIRIUS_VENUE_PREVIEW_TOTALS';
  let totals = {};
  try { totals = JSON.parse(props.getProperty(key) || '{}'); } catch (e) { totals = {}; }
  Object.keys(counts).forEach(function(name) {
    totals[name] = Number(totals[name] || 0) + Number(counts[name] || 0);
  });
  props.setProperty(key, JSON.stringify(totals));
  return totals;
}

/**
 * 自動プレビュー開始。現在のカーソル（現在はページ13）から再開する。
 * 3ページずつ実行し、次回を1分後の時間主導トリガーで予約する。
 * 既存の会場プレビューカーソルはリセットしない。
 */
function startSiriusVenueBackfillPreviewAuto() {
  const props = PropertiesService.getScriptProperties();
  const cursor = Math.max(1, Number(props.getProperty('SIRIUS_VENUE_PREVIEW_CURSOR') || 1));
  const totalsKey = 'SIRIUS_VENUE_PREVIEW_TOTALS';
  if (!props.getProperty(totalsKey)) {
    // ここまでに手動確認済みのページ1〜12の集計値を引き継ぐ。
    const initial = cursor === 13
      ? {pages:12,candidates:1447,withVenue:1341,missingDate:0,parseFailures:6,internal:48,exact:1007,legacyUnique:48,ambiguous:1,notFound:237}
      : {pages:0,candidates:0,withVenue:0,missingDate:0,parseFailures:0,internal:0,exact:0,legacyUnique:0,ambiguous:0,notFound:0};
    props.setProperty(totalsKey, JSON.stringify(initial));
  }
  deleteSiriusVenueBackfillPreviewAutoTriggers_();
  console.log('会場補完プレビュー自動実行を開始します。開始ページ=' + cursor + '。3ページずつ実行します。');
  runSiriusVenueBackfillPreviewAuto_();
}

/** 時間主導トリガーから呼び出す。全ページ完了時に自動停止する。 */
function runSiriusVenueBackfillPreviewAuto_() {
  try {
    previewSiriusVenueBackfillBatch();
  } catch (error) {
    deleteSiriusVenueBackfillPreviewAutoTriggers_();
    console.error('会場補完プレビュー自動実行を停止しました。カーソルは異常発生前の位置を維持します。詳細=' + error);
    throw error;
  }

  const inventory = fetchMonthlyPageInventory_();
  const cursor = Math.max(1, Number(PropertiesService.getScriptProperties()
    .getProperty('SIRIUS_VENUE_PREVIEW_CURSOR') || 1));
  if (cursor <= inventory.length) {
    deleteSiriusVenueBackfillPreviewAutoTriggers_();
    ScriptApp.newTrigger('runSiriusVenueBackfillPreviewAuto_')
      .timeBased()
      .after(60 * 1000)
      .create();
    console.log('次の3ページを約1分後に自動実行します。次回開始ページ=' + cursor);
  } else {
    deleteSiriusVenueBackfillPreviewAutoTriggers_();
    const totals = PropertiesService.getScriptProperties().getProperty('SIRIUS_VENUE_PREVIEW_TOTALS') || '{}';
    console.log('全36ページの自動プレビューが完了しました。累計=' + totals);
    console.log('Google Sheetsのデータは変更していません。');
  }
}

/** 会場プレビュー専用トリガーだけを削除する。日次取込トリガーには触れない。 */
function deleteSiriusVenueBackfillPreviewAutoTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'runSiriusVenueBackfillPreviewAuto_') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/** 自動プレビューを途中停止する。カーソル・集計値・シートデータは保持する。 */
function stopSiriusVenueBackfillPreviewAuto() {
  deleteSiriusVenueBackfillPreviewAutoTriggers_();
  console.log('会場補完プレビューの自動実行を停止しました。再開時はstartSiriusVenueBackfillPreviewAutoを実行してください。');
}


/**
 * 会場補完の第2段階監査（読み取り専用）。
 * 完全一致行のplace空欄/設定済みを分類し、旧形式一致・曖昧・未一致・解析失敗を再集計する。
 * 3ページ単位で実行し、専用カーソルを進める。Google Sheetsには一切書き込まない。
 */
function previewSiriusVenueBackfillAuditBatch() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('別の処理が実行中です。');
  try {
    const ss = getSiriusBackfillSpreadsheet_();
    const sheet = ss.getSheetByName(SIRIUS_BATCH_CONFIG.externalSheetName);
    if (!sheet) throw new Error('タブ「' + SIRIUS_BATCH_CONFIG.externalSheetName + '」がありません。');
    const values = sheet.getDataRange().getValues();
    if (!values.length) throw new Error('全学年データにヘッダーがありません。');
    const headers = values[0].map(function(v) { return String(v || '').trim(); });
    const idx = {};
    headers.forEach(function(h, i) { idx[h] = i; });
    ['team', 'date', 'category', 'score', 'result'].forEach(function(h) {
      if (idx[h] == null) throw new Error('必要な列「' + h + '」がありません。');
    });
    const inventory = fetchMonthlyPageInventory_();
    const props = PropertiesService.getScriptProperties();
    const start = Math.max(1, Number(props.getProperty('SIRIUS_VENUE_AUDIT_CURSOR') || 1));
    const batch = inventory.slice(start - 1, start - 1 + 3);
    if (!batch.length) {
      console.log('第2段階監査は完了済みです。総ページ=' + inventory.length);
      return;
    }

    const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
    const exactRows = new Map();
    const legacyRows = new Map();
    function add(map, key, entry) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(entry);
    }
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (r.every(function(v) { return v === '' || v == null; })) continue;
      const obj = {
        team: r[idx.team], date: normalizeSheetDate_(r[idx.date], tz),
        category: r[idx.category], score: r[idx.score], result: r[idx.result],
        siriusTeam: idx.siriusTeam == null ? '' : r[idx.siriusTeam],
        pkScore: idx.pkScore == null ? '' : r[idx.pkScore]
      };
      const entry = {
        rowNumber: i + 1,
        place: idx.place == null ? '' : String(r[idx.place] || '').trim()
      };
      add(exactRows, siriusExternalExactKey_(obj), entry);
      const legacyKey = [
        normalizeMatchText_(obj.date), normalizeMatchText_(obj.category),
        normalizeMatchText_(obj.team), normalizeMatchText_(obj.score).replace(/[－―−：]/g, '-'),
        normalizeMatchText_(obj.result)
      ].join('|');
      add(legacyRows, legacyKey, entry);
    }

    const counts = {
      pages:0, candidates:0, withVenue:0, missingDate:0, parseFailures:0,
      internal:0, exactBlank:0, exactPopulated:0, legacyUnique:0,
      ambiguous:0, notFound:0
    };
    const samples = {parseFailures:[],legacyUnique:[],ambiguous:[],notFound:[]};
    batch.forEach(function(page) {
      const fetched = fetchMatchCandidates_(page.url, page.year, page.month);
      if (fetched.status < 200 || fetched.status >= 300) {
        throw new Error('取得失敗。監査カーソルは進めていません: ' + page.year + '-' + page.month + ' HTTP=' + fetched.status);
      }
      counts.pages++;
      fetched.candidates.forEach(function(candidate) {
        counts.candidates++;
        const row = parseCandidateToCsvRow_(candidate);
        const label = page.year + '-' + ('0' + page.month).slice(-2);
        if (!row) {
          counts.parseFailures++;
          if (samples.parseFailures.length < 10) samples.parseFailures.push(label + ' / ' + String(candidate.text || '').slice(0, 180));
          return;
        }
        if (!row.place) return;
        counts.withVenue++;
        if (!row.date) { counts.missingDate++; return; }
        if (isInternalSiriusMatch_(row.team)) { counts.internal++; return; }

        const exact = exactRows.get(siriusExternalExactKey_(row)) || [];
        if (exact.length === 1) {
          if (exact[0].place) counts.exactPopulated++;
          else counts.exactBlank++;
          return;
        }
        if (exact.length > 1) {
          counts.ambiguous++;
          if (samples.ambiguous.length < 10) samples.ambiguous.push(label + ' / 完全一致複数 / ' + row.date + ' / ' + row.team + ' / ' + row.place + ' / rows=' + exact.map(function(x) { return x.rowNumber; }).join(','));
          return;
        }
        const legacyKey = [
          normalizeMatchText_(row.date), normalizeMatchText_(row.category),
          normalizeMatchText_(row.team), normalizeMatchText_(row.score).replace(/[－―−：]/g, '-'),
          normalizeMatchText_(row.result)
        ].join('|');
        const legacy = legacyRows.get(legacyKey) || [];
        if (legacy.length === 1) {
          counts.legacyUnique++;
          if (samples.legacyUnique.length < 10) samples.legacyUnique.push(label + ' / ' + row.date + ' / ' + row.team + ' / ' + row.siriusTeam + ' / ' + row.place + ' / sheetRow=' + legacy[0].rowNumber);
        } else if (legacy.length > 1) {
          counts.ambiguous++;
          if (samples.ambiguous.length < 10) samples.ambiguous.push(label + ' / 旧形式複数 / ' + row.date + ' / ' + row.team + ' / ' + row.place + ' / rows=' + legacy.map(function(x) { return x.rowNumber; }).join(','));
        } else {
          counts.notFound++;
          if (samples.notFound.length < 10) samples.notFound.push(label + ' / ' + row.date + ' / ' + row.team + ' / ' + row.siriusTeam + ' / ' + row.score + ' / ' + row.place);
        }
      });
    });

    console.log('会場補完第2段階監査（読み取り専用）');
    console.log('対象ページ=' + start + '-' + (start + batch.length - 1) + ' / 総ページ=' + inventory.length);
    console.log('既存シート列=' + headers.join(',') + ' / place列=' + (idx.place == null ? 'なし' : 'あり'));
    console.log('今回集計=' + JSON.stringify(counts));
    Object.keys(samples).forEach(function(k) {
      samples[k].forEach(function(s) { console.log('AUDIT ' + k + ' ' + s); });
    });
    if (counts.missingDate > 0) {
      console.log('停止: 日付未取得候補があります。カーソルは進めていません。');
      throw new Error('日付未取得=' + counts.missingDate + '。誤照合防止のため監査を停止しました。');
    }
    const totalsKey = 'SIRIUS_VENUE_AUDIT_TOTALS';
    let totals = {};
    try { totals = JSON.parse(props.getProperty(totalsKey) || '{}'); } catch (e) { totals = {}; }
    Object.keys(counts).forEach(function(k) { totals[k] = Number(totals[k] || 0) + counts[k]; });
    props.setProperty(totalsKey, JSON.stringify(totals));
    const next = start + batch.length;
    props.setProperty('SIRIUS_VENUE_AUDIT_CURSOR', String(next));
    console.log('次回開始ページ=' + next + ' / 累計=' + JSON.stringify(totals));
    if (next > inventory.length) {
      console.log('全ページの第2段階監査が完了しました。place列=' + (idx.place == null ? 'なし（全完全一致は空欄扱い）' : 'あり'));
    }
    console.log('Google Sheetsへの書き込み・既存データ変更は行っていません。');
  } finally {
    lock.releaseLock();
  }
}

/** 第2段階監査を先頭から自動実行する。 */
function startSiriusVenueBackfillAuditAuto() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('SIRIUS_VENUE_AUDIT_CURSOR');
  props.deleteProperty('SIRIUS_VENUE_AUDIT_TOTALS');
  deleteSiriusVenueBackfillAuditAutoTriggers_();
  console.log('会場補完第2段階監査を開始します。3ページずつ、読み取り専用で実行します。');
  runSiriusVenueBackfillAuditAuto_();
}

/** 第2段階監査の自動継続ハンドラ。 */
function runSiriusVenueBackfillAuditAuto_() {
  try {
    previewSiriusVenueBackfillAuditBatch();
  } catch (error) {
    deleteSiriusVenueBackfillAuditAutoTriggers_();
    console.error('第2段階監査を停止しました。カーソルは成功済みページの次を保持します。詳細=' + error);
    throw error;
  }
  const inventory = fetchMonthlyPageInventory_();
  const cursor = Math.max(1, Number(PropertiesService.getScriptProperties()
    .getProperty('SIRIUS_VENUE_AUDIT_CURSOR') || 1));
  if (cursor <= inventory.length) {
    deleteSiriusVenueBackfillAuditAutoTriggers_();
    ScriptApp.newTrigger('runSiriusVenueBackfillAuditAuto_').timeBased().after(60 * 1000).create();
    console.log('次の監査バッチを約1分後に実行します。次回開始ページ=' + cursor);
  } else {
    deleteSiriusVenueBackfillAuditAutoTriggers_();
    console.log('第2段階監査の自動実行が完了しました。累計=' +
      (PropertiesService.getScriptProperties().getProperty('SIRIUS_VENUE_AUDIT_TOTALS') || '{}'));
    console.log('Google Sheetsへの書き込み・既存データ変更は行っていません。');
  }
}

function deleteSiriusVenueBackfillAuditAutoTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'runSiriusVenueBackfillAuditAuto_') ScriptApp.deleteTrigger(trigger);
  });
}

/** 第2段階監査の自動実行を停止する。進捗・集計値は保持する。 */
function stopSiriusVenueBackfillAuditAuto() {
  deleteSiriusVenueBackfillAuditAutoTriggers_();
  console.log('第2段階監査を停止しました。再開時はstartSiriusVenueBackfillAuditAutoを実行してください（先頭から再監査します）。');
}

/**
 * 実データ補完直前の書き込み計画プレビュー（読み取り専用）。
 * 完全一致かつ既存place空欄の行だけを補完候補として集計する。
 * 旧形式一致・複数一致・未一致は候補に含めない。
 * 3ページずつ実行し、スプレッドシートには一切書き込まない。
 */
function previewSiriusVenueBackfillWritePlanBatch() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('別の処理が実行中です。');
  try {
    const ss = getSiriusBackfillSpreadsheet_();
    const sheet = ss.getSheetByName(SIRIUS_BATCH_CONFIG.externalSheetName);
    if (!sheet) throw new Error('タブ「' + SIRIUS_BATCH_CONFIG.externalSheetName + '」がありません。');
    const values = sheet.getDataRange().getValues();
    if (!values.length) throw new Error('全学年データにヘッダーがありません。');
    const headers = values[0].map(function(v) { return String(v || '').trim(); });
    const idx = {};
    headers.forEach(function(h, i) { idx[h] = i; });
    ['team', 'date', 'category', 'score', 'result'].forEach(function(h) {
      if (idx[h] == null) throw new Error('必要な列「' + h + '」がありません。');
    });

    const inventory = fetchMonthlyPageInventory_();
    const props = PropertiesService.getScriptProperties();
    const start = Math.max(1, Number(props.getProperty('SIRIUS_VENUE_WRITEPLAN_CURSOR') || 1));
    const batch = inventory.slice(start - 1, start - 1 + 3);
    if (!batch.length) {
      console.log('書き込み計画プレビューは完了済みです。総ページ=' + inventory.length);
      return;
    }

    const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
    const exactRows = new Map();
    const legacyRows = new Map();
    function add(map, key, entry) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(entry);
    }
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (r.every(function(v) { return v === '' || v == null; })) continue;
      const obj = {
        team: r[idx.team], date: normalizeSheetDate_(r[idx.date], tz),
        category: r[idx.category], score: r[idx.score], result: r[idx.result],
        siriusTeam: idx.siriusTeam == null ? '' : r[idx.siriusTeam],
        pkScore: idx.pkScore == null ? '' : r[idx.pkScore]
      };
      const entry = {
        rowNumber: i + 1,
        place: idx.place == null ? '' : String(r[idx.place] || '').trim()
      };
      add(exactRows, siriusExternalExactKey_(obj), entry);
      const legacyKey = [
        normalizeMatchText_(obj.date), normalizeMatchText_(obj.category),
        normalizeMatchText_(obj.team), normalizeMatchText_(obj.score).replace(/[－―−：]/g, '-'),
        normalizeMatchText_(obj.result)
      ].join('|');
      add(legacyRows, legacyKey, entry);
    }

    const counts = {
      pages:0, candidates:0, withVenue:0, missingDate:0, parseFailures:0,
      internal:0, eligibleExactBlank:0, exactAlreadyPopulated:0,
      legacyUniqueExcluded:0, ambiguousExcluded:0, notFoundExcluded:0
    };
    const monthCounts = {};
    const samples = [];
    batch.forEach(function(page) {
      const fetched = fetchMatchCandidates_(page.url, page.year, page.month);
      if (fetched.status < 200 || fetched.status >= 300) {
        throw new Error('取得失敗。計画プレビューカーソルは進めていません: ' +
          page.year + '-' + page.month + ' HTTP=' + fetched.status);
      }
      counts.pages++;
      const month = page.year + '-' + ('0' + page.month).slice(-2);
      if (!monthCounts[month]) monthCounts[month] = {eligible:0, populated:0, legacy:0, ambiguous:0, notFound:0};
      fetched.candidates.forEach(function(candidate) {
        counts.candidates++;
        const row = parseCandidateToCsvRow_(candidate);
        if (!row) { counts.parseFailures++; return; }
        if (!row.place) return;
        counts.withVenue++;
        if (!row.date) { counts.missingDate++; return; }
        if (isInternalSiriusMatch_(row.team)) { counts.internal++; return; }

        const exact = exactRows.get(siriusExternalExactKey_(row)) || [];
        if (exact.length === 1) {
          if (exact[0].place) {
            counts.exactAlreadyPopulated++;
            monthCounts[month].populated++;
          } else {
            counts.eligibleExactBlank++;
            monthCounts[month].eligible++;
            if (samples.length < 10) {
              samples.push(month + ' / sheetRow=' + exact[0].rowNumber +
                ' / ' + row.date + ' / ' + row.team + ' / ' + row.siriusTeam + ' / ' + row.place);
            }
          }
          return;
        }
        if (exact.length > 1) {
          counts.ambiguousExcluded++;
          monthCounts[month].ambiguous++;
          return;
        }
        const legacyKey = [
          normalizeMatchText_(row.date), normalizeMatchText_(row.category),
          normalizeMatchText_(row.team), normalizeMatchText_(row.score).replace(/[－―−：]/g, '-'),
          normalizeMatchText_(row.result)
        ].join('|');
        const legacy = legacyRows.get(legacyKey) || [];
        if (legacy.length === 1) {
          counts.legacyUniqueExcluded++;
          monthCounts[month].legacy++;
        } else if (legacy.length > 1) {
          counts.ambiguousExcluded++;
          monthCounts[month].ambiguous++;
        } else {
          counts.notFoundExcluded++;
          monthCounts[month].notFound++;
        }
      });
    });

    console.log('会場補完・書き込み計画プレビュー（読み取り専用）');
    console.log('対象ページ=' + start + '-' + (start + batch.length - 1) + ' / 総ページ=' + inventory.length);
    console.log('既存シート列=' + headers.join(',') + ' / place列=' + (idx.place == null ? 'なし' : 'あり'));
    console.log('今回集計=' + JSON.stringify(counts));
    console.log('月別内訳=' + JSON.stringify(monthCounts));
    samples.forEach(function(s) { console.log('WRITEPLAN_SAMPLE ' + s); });
    if (counts.missingDate > 0) {
      console.log('停止: 日付未取得候補があります。カーソルは進めていません。');
      throw new Error('日付未取得=' + counts.missingDate + '。誤照合防止のため停止しました。');
    }

    const totalsKey = 'SIRIUS_VENUE_WRITEPLAN_TOTALS';
    let totals = {};
    try { totals = JSON.parse(props.getProperty(totalsKey) || '{}'); } catch (e) { totals = {}; }
    Object.keys(counts).forEach(function(k) { totals[k] = Number(totals[k] || 0) + counts[k]; });
    const monthlyKey = 'SIRIUS_VENUE_WRITEPLAN_MONTHS';
    let allMonths = {};
    try { allMonths = JSON.parse(props.getProperty(monthlyKey) || '{}'); } catch (e) { allMonths = {}; }
    Object.keys(monthCounts).forEach(function(month) {
      if (!allMonths[month]) allMonths[month] = {eligible:0, populated:0, legacy:0, ambiguous:0, notFound:0};
      Object.keys(monthCounts[month]).forEach(function(k) {
        allMonths[month][k] += monthCounts[month][k];
      });
    });
    props.setProperty(totalsKey, JSON.stringify(totals));
    props.setProperty(monthlyKey, JSON.stringify(allMonths));
    const next = start + batch.length;
    props.setProperty('SIRIUS_VENUE_WRITEPLAN_CURSOR', String(next));
    console.log('次回開始ページ=' + next + ' / 累計=' + JSON.stringify(totals));
    if (next > inventory.length) {
      console.log('全ページの書き込み計画プレビュー完了。最終累計=' + JSON.stringify(totals));
      console.log('全期間の月別内訳=' + JSON.stringify(allMonths));
    }
    console.log('Google Sheetsへの書き込み・既存データ変更は行っていません。');
  } finally {
    lock.releaseLock();
  }
}

/** 書き込み計画プレビューを先頭から自動実行する。 */
function startSiriusVenueBackfillWritePlanAuto() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('SIRIUS_VENUE_WRITEPLAN_CURSOR');
  props.deleteProperty('SIRIUS_VENUE_WRITEPLAN_TOTALS');
  props.deleteProperty('SIRIUS_VENUE_WRITEPLAN_MONTHS');
  deleteSiriusVenueBackfillWritePlanAutoTriggers_();
  console.log('会場補完・書き込み計画プレビューを開始します。3ページずつ、読み取り専用で実行します。');
  runSiriusVenueBackfillWritePlanAuto_();
}

/** 書き込み計画プレビューの自動継続ハンドラ。 */
function runSiriusVenueBackfillWritePlanAuto_() {
  try {
    previewSiriusVenueBackfillWritePlanBatch();
  } catch (error) {
    deleteSiriusVenueBackfillWritePlanAutoTriggers_();
    console.error('書き込み計画プレビューを停止しました。詳細=' + error);
    throw error;
  }
  const inventory = fetchMonthlyPageInventory_();
  const cursor = Math.max(1, Number(PropertiesService.getScriptProperties()
    .getProperty('SIRIUS_VENUE_WRITEPLAN_CURSOR') || 1));
  if (cursor <= inventory.length) {
    deleteSiriusVenueBackfillWritePlanAutoTriggers_();
    ScriptApp.newTrigger('runSiriusVenueBackfillWritePlanAuto_').timeBased().after(60 * 1000).create();
    console.log('次の計画プレビューを約1分後に実行します。次回開始ページ=' + cursor);
  } else {
    deleteSiriusVenueBackfillWritePlanAutoTriggers_();
    console.log('書き込み計画プレビューの自動実行が完了しました。累計=' +
      (PropertiesService.getScriptProperties().getProperty('SIRIUS_VENUE_WRITEPLAN_TOTALS') || '{}'));
    console.log('Google Sheetsへの書き込み・既存データ変更は行っていません。');
  }
}

function deleteSiriusVenueBackfillWritePlanAutoTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'runSiriusVenueBackfillWritePlanAuto_') ScriptApp.deleteTrigger(trigger);
  });
}

/** 自動プレビューを停止する。カーソルと集計値は保持する。 */
function stopSiriusVenueBackfillWritePlanAuto() {
  deleteSiriusVenueBackfillWritePlanAutoTriggers_();
  console.log('書き込み計画プレビューを停止しました。シートデータは変更していません。');
}

