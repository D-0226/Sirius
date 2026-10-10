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
        pkScore: row.pkScore || ''
      };
      const exactKey = siriusExternalExactKey_(external);
      const identityKey = siriusExternalIdentityKey_(external);
      if (externalState.exact.has(exactKey) || batchExternalExact.has(exactKey)) {
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
      externalRowsToAppend(siriusMapExternalRow_(externalHeaders, external));
      externalState.exact.add(exactKey);
      externalState.byIdentity.set(identityKey, external);
      summary.addedExternal++;
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
  ['siriusTeam', 'pkScore'].forEach(function(name) {
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
  const byIdentity = new Map();
  const legacyByIdentity = new Map();
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r.every(function(v) { return v === '' || v == null; })) continue;
    const obj = {
      team: r[idx.team], date: normalizeSheetDate_(r[idx.date], tz),
      category: r[idx.category], score: r[idx.score], result: r[idx.result],
      siriusTeam: idx.siriusTeam >= 0 ? r[idx.siriusTeam] : '',
      pkScore: idx.pkScore >= 0 ? r[idx.pkScore] : ''
    };
    exact.add(siriusExternalExactKey_(obj));
    const identity = siriusExternalIdentityKey_(obj);
    if (!byIdentity.has(identity)) byIdentity.set(identity, obj);
    // 旧データにsiriusTeam列がない／空欄の場合、歴史データの再取込を避けるため
    // 日付・カテゴリ・対戦相手が一致した候補は自動追加せず要確認に回す。
    if (!normalizeMatchText_(obj.siriusTeam)) {
      const legacyIdentity = siriusExternalLegacyIdentityKey_(obj);
      if (!legacyByIdentity.has(legacyIdentity)) legacyByIdentity.set(legacyIdentity, obj);
    }
  }
  return { exact: exact, byIdentity: byIdentity, legacyByIdentity: legacyByIdentity };
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
