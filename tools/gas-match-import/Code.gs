/**
 * FC SIRIUS公式サイト 試合結果取得プロトタイプ（読み取り専用）
 *
 * 公式サイトの月別ページを取得し、試合結果候補を実行ログに出す。
 * Google Sheetsへの書き込みやトリガー登録は行わない。
 */

const SIRIUS_IMPORT_CONFIG = {
  indexPageUrl: 'https://sc.footballnavi.jp/fcsirius/page.php?pno=459',
  previewPageUrl: 'https://sc.footballnavi.jp/fcsirius/page.php?pno=2044',
  sourceLabel: 'FC SIRIUS公式サイト 2026年6月',
  sourceYear: 2026,
  sourceMonth: 6,
  maxCandidates: 150,
  batchStartIndex: 1,
  batchSize: 10
};

/**
 * CSV形式を確認する（読み取り専用。Google Sheetsへの書き込みは行わない）。
 * 既存5列を維持し、末尾にsiriusTeamとpkScoreを追加する。
 */
function previewCsvJune2026() {
  const result = fetchMatchCandidates_(SIRIUS_IMPORT_CONFIG.previewPageUrl);
  const header = ['team', 'date', 'category', 'score', 'result', 'siriusTeam', 'pkScore'];
  const csvLines = [header.map(csvEscape_).join(',')];
  let parsedCount = 0;
  let parseFailureCount = 0;

  result.candidates.forEach(function(candidate) {
    const row = parseCandidateToCsvRow_(candidate);
    if (!row) {
      parseFailureCount++;
      return;
    }
    parsedCount++;
    csvLines.push([
      row.team,
      row.date,
      row.category,
      row.score,
      row.result,
      row.siriusTeam,
      row.pkScore
    ].map(csvEscape_).join(','));
  });

  console.log('SOURCE: ' + SIRIUS_IMPORT_CONFIG.sourceLabel);
  console.log('CSV preview URL: ' + SIRIUS_IMPORT_CONFIG.previewPageUrl);
  console.log('HTTP status: ' + result.status);
  console.log('Candidate count: ' + result.candidates.length);
  console.log('CSV parse success: ' + parsedCount);
  console.log('CSV parse needs review: ' + parseFailureCount);
  console.log('CSV columns: ' + header.join(','));
  console.log('CSV output (read-only preview):\n' + csvLines.join('\n'));
}



/**
 * 月別ページを10件ずつ取得して、全期間データの解析状況を確認する（読み取り専用）。
 * 次のバッチへ進むときは SIRIUS_IMPORT_CONFIG.batchStartIndex を 1, 11, 21... と変更する。
 * 本番シートへの書き込み・既存データの削除は行わない。
 */
function previewMonthlyPageBatch() {
  const inventory = fetchMonthlyPageInventory_();
  const startIndex = Math.max(1, Number(SIRIUS_IMPORT_CONFIG.batchStartIndex) || 1);
  const batchSize = Math.max(1, Number(SIRIUS_IMPORT_CONFIG.batchSize) || 10);
  const batch = inventory.slice(startIndex - 1, startIndex - 1 + batchSize);

  console.log('Monthly pages total: ' + inventory.length);
  console.log('Batch range: ' + startIndex + '-' + (startIndex + batch.length - 1));
  console.log('Batch page count: ' + batch.length);
  if (batch.length === 0) {
    console.log('対象ページなし。batchStartIndex が総ページ数を超えていないか確認してください。');
    return;
  }

  const totals = {
    pagesOk: 0,
    pagesFailed: 0,
    retrySucceeded: 0,
    candidates: 0,
    parsed: 0,
    parseFailures: 0,
    internal: 0
  };
  const failedPages = [];

  batch.forEach(function(page, offset) {
    const pageNo = startIndex + offset;
    let result = fetchMatchCandidates_(page.url, page.year, page.month);
    let retried = false;

    // 503だけを対象に、2秒待って1回だけ再試行する。無限リトライはしない。
    if (result.status === 503) {
      retried = true;
      Utilities.sleep(2000);
      result = fetchMatchCandidates_(page.url, page.year, page.month);
      if (result.status >= 200 && result.status < 300) {
        totals.retrySucceeded++;
      }
    }

    let parsed = 0;
    let failed = 0;
    let internal = 0;
    if (result.status >= 200 && result.status < 300) {
      totals.pagesOk++;
    } else {
      totals.pagesFailed++;
      failedPages.push({
        pageNo: pageNo,
        year: page.year,
        month: page.month,
        status: result.status,
        url: page.url
      });
      console.log('FETCH FAILURE page=' + pageNo + ' date=' + page.year + '-' +
        ('0' + page.month).slice(-2) + ' HTTP=' + result.status + ' url=' + page.url);
    }

    let failureSamples = 0;
    result.candidates.forEach(function(candidate) {
      const row = parseCandidateToCsvRow_(candidate);
      if (!row) {
        failed++;
        if (failureSamples < 5) {
          console.log('PARSE FAILURE SAMPLE page=' + pageNo + ' raw=' + candidate.text);
          failureSamples++;
        }
        return;
      }
      parsed++;
      if (isInternalSiriusMatch_(row.team)) internal++;
    });

    totals.candidates += result.candidates.length;
    totals.parsed += parsed;
    totals.parseFailures += failed;
    totals.internal += internal;
    console.log(
      pageNo + '\\t' + page.year + '-' + ('0' + page.month).slice(-2) +
      '\\tHTTP=' + result.status +
      (retried ? '\\tretried503=yes' : '') +
      '\\tcandidates=' + result.candidates.length +
      '\\tparsed=' + parsed +
      '\\tparseFailures=' + failed +
      '\\tinternal=' + internal +
      '\\t' + page.url
    );
  });

  console.log('BATCH SUMMARY');
  console.log('pagesOK=' + totals.pagesOk);
  console.log('pagesFailed=' + totals.pagesFailed);
  console.log('retrySucceeded=' + totals.retrySucceeded);
  console.log('candidates=' + totals.candidates);
  console.log('parsed=' + totals.parsed);
  console.log('parseFailures=' + totals.parseFailures);
  console.log('internalSirius=' + totals.internal);
  if (failedPages.length > 0) {
    console.log('FAILED PAGE LIST (再実行・後日確認用)');
    failedPages.forEach(function(page) {
      console.log(page.pageNo + '\\t' + page.year + '-' + ('0' + page.month).slice(-2) +
        '\\tHTTP=' + page.status + '\\t' + page.url);
    });
  } else {
    console.log('FAILED PAGE LIST: none');
  }
  console.log('プレビューのみ。シートへの書き込み・既存データの削除は行っていません。');
}

/** 公式サイトの月別ページ一覧を取得して年月・URL配列を返す。 */
function fetchMonthlyPageInventory_() {
  const response = UrlFetchApp.fetch(SIRIUS_IMPORT_CONFIG.indexPageUrl, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiriusMatchPreview/1.0)' }
  });
  const status = response.getResponseCode();
  const html = response.getContentText('Shift_JIS');
  if (status < 200 || status >= 300) {
    throw new Error('月別ページ一覧の取得に失敗しました。HTTP status=' + status + '。データは変更していません。');
  }

  // 既存のURL台帳プレビューと同じ方法で、月別リンクを抽出する。
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']*page\.php\?pno=\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const pages = [];
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    const label = htmlToPlainText_(match[2]).replace(/[\t\r\n ]+/g, '').trim();
    const monthMatch = label.match(/^(\d{1,2})月$/);
    if (!monthMatch) continue;

    const prefixText = htmlToPlainText_(html.slice(0, match.index))
      .replace(/[\t\r\n ]+/g, ' ');
    const yearMatches = prefixText.match(/20\d{2}年/g);
    if (!yearMatches || yearMatches.length === 0) continue;

    const year = Number(yearMatches[yearMatches.length - 1].replace('年', ''));
    const month = Number(monthMatch[1]);
    const href = match[1].replace(/&amp;/gi, '&');
    const url = /^https?:\/\//i.test(href)
      ? href
      : 'https://sc.footballnavi.jp/fcsirius/' + href.replace(/^\.\//, '').replace(/^\//, '');
    pages.push({ year: year, month: month, url: url });
  }

  pages.sort(function(a, b) { return a.year - b.year || a.month - b.month; });
  if (pages.length === 0) {
    throw new Error('月別ページのリンクを抽出できませんでした。HTML構造を確認してください。');
  }
  return pages;
}
/**
 * 公式サイトの試合日程・結果一覧から、月別ページのURL台帳を作る（読み取り専用）。
 * 年度・月・URLをログ出力する。スプレッドシートへの書き込みは行わない。
 */
function previewMonthlyPageInventory() {
  const response = UrlFetchApp.fetch(SIRIUS_IMPORT_CONFIG.indexPageUrl, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiriusMatchPreview/1.0)' }
  });
  const status = response.getResponseCode();
  const html = response.getContentText('Shift_JIS');

  console.log('INDEX URL: ' + SIRIUS_IMPORT_CONFIG.indexPageUrl);
  console.log('HTTP status: ' + status);
  if (status < 200 || status >= 300) {
    throw new Error('月別ページ一覧の取得に失敗しました。HTTP status=' + status + '。データは変更していません。');
  }

  // 年度の見出しと月リンクをHTML上の順番で読み取る。
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']*page\.php\?pno=\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const anchors = [];
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    const label = htmlToPlainText_(match[2]).replace(/[\t\r\n ]+/g, '').trim();
    const monthMatch = label.match(/^(\d{1,2})月$/);
    if (!monthMatch) continue;

    const prefixText = htmlToPlainText_(html.slice(0, match.index))
      .replace(/[\t\r\n ]+/g, ' ');
    const yearMatches = prefixText.match(/20\d{2}年/g);
    if (!yearMatches || yearMatches.length === 0) continue;
    const year = Number(yearMatches[yearMatches.length - 1].replace('年', ''));
    const month = Number(monthMatch[1]);
    const href = match[1].replace(/&amp;/gi, '&');
    const absoluteUrl = /^https?:\/\//i.test(href)
      ? href
      : 'https://sc.footballnavi.jp/fcsirius/' + href.replace(/^\.\//, '').replace(/^\//, '');
    anchors.push({ year: year, month: month, url: absoluteUrl });
  }

  if (anchors.length === 0) {
    throw new Error('月別ページのリンクを抽出できませんでした。HTML構造を確認してください。');
  }

  anchors.sort(function(a, b) {
    return a.year - b.year || a.month - b.month;
  });

  console.log('Monthly page count: ' + anchors.length);
  anchors.forEach(function(item, index) {
    console.log(
      (index + 1) + '\t' + item.year + '-' + ('0' + item.month).slice(-2) + '\t' + item.url
    );
  });
  console.log('URL台帳プレビューのみ。シートへの書き込み・既存データの削除は行っていません。');
}

/**
 * 再構築用プレビュー（読み取り専用）。
 * 既存データとの照合は行わず、公式サイトから取得した試合候補を分類して件数確認する。
 * シートへの書き込み・既存データの削除は一切行わない。
 */
function previewRebuildJune2026() {
  const result = fetchMatchCandidates_(SIRIUS_IMPORT_CONFIG.previewPageUrl);

  console.log('SOURCE: ' + SIRIUS_IMPORT_CONFIG.sourceLabel);
  console.log('URL: ' + SIRIUS_IMPORT_CONFIG.previewPageUrl);
  console.log('HTTP status: ' + result.status);

  // HTTPエラー時に「0件取得」と誤認して先に進まないよう、ここで停止する。
  if (result.status < 200 || result.status >= 300) {
    throw new Error('公式サイトの取得に失敗しました。HTTP status=' + result.status + '。データは変更していません。');
  }

  const counts = {
    '通常試合候補': 0,
    '集計対象外（SIRIUS内）': 0,
    '解析失敗': 0
  };

  console.log('Fetched candidates: ' + result.candidates.length);
  result.candidates.forEach(function(candidate, index) {
    const row = parseCandidateToCsvRow_(candidate);
    if (!row) {
      counts['解析失敗']++;
      console.log((index + 1) + '\t解析失敗\traw=' + candidate.text);
      return;
    }

    if (isInternalSiriusMatch_(row.team)) {
      counts['集計対象外（SIRIUS内）']++;
      console.log(
        (index + 1) + '\t集計対象外（SIRIUS内）' +
        '\tdate=' + row.date +
        '\tcategory=' + row.category +
        '\topponent=' + row.team +
        '\tscore=' + row.score +
        '\tresult=' + row.result +
        '\tsiriusTeam=' + row.siriusTeam +
        '\tpkScore=' + row.pkScore
      );
      return;
    }

    counts['通常試合候補']++;
    console.log(
      (index + 1) + '\t通常試合候補' +
      '\tdate=' + row.date +
      '\tcategory=' + row.category +
      '\topponent=' + row.team +
      '\tscore=' + row.score +
      '\tresult=' + row.result +
      '\tsiriusTeam=' + row.siriusTeam +
      '\tpkScore=' + row.pkScore
    );
  });

  console.log('Summary:');
  console.log('取得候補=' + result.candidates.length);
  console.log('通常試合候補=' + counts['通常試合候補']);
  console.log('集計対象外（SIRIUS内）=' + counts['集計対象外（SIRIUS内）']);
  console.log('解析失敗=' + counts['解析失敗']);
  console.log('プレビューのみ。シートへの書き込み・既存データの削除は行っていません。');
}

/**
 * 既存の「全学年データ」タブと照合する（読み取り専用）。
 * 対戦相手がFC SIRIUS内のチーム名なら集計対象外とし、外部チームとの一致候補は「要確認」とする。
 * この関数は対象スプレッドシートに紐づいたGASで実行すること。
 */
function previewReconciliationJune2026() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('対象スプレッドシートに紐づいたApps Scriptから実行してください。');
  }

  const sheet = ss.getSheetByName('全学年データ');
  if (!sheet) {
    throw new Error('タブ「全学年データ」が見つかりません。');
  }

  const values = sheet.getDataRange().getValues();
  if (values.length < 1) {
    throw new Error('「全学年データ」にヘッダー行がありません。');
  }

  const headers = values[0].map(function(value) {
    return String(value == null ? '' : value).trim();
  });
  const required = ['team', 'date', 'category', 'score', 'result'];
  const indexes = {};
  required.forEach(function(name) {
    indexes[name] = headers.indexOf(name);
    if (indexes[name] < 0) {
      throw new Error('必要な列「' + name + '」が見つかりません。現在のヘッダー: ' + headers.join(','));
    }
  });

  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  const existing = {};
  let existingRows = 0;
  for (let i = 1; i < values.length; i++) {
    const record = values[i];
    if (record.every(function(value) { return value === '' || value == null; })) continue;
    const key = makeMatchKey_(
      record[indexes.team],
      normalizeSheetDate_(record[indexes.date], tz),
      record[indexes.category],
      record[indexes.score],
      record[indexes.result]
    );
    existing[key] = (existing[key] || 0) + 1;
    existingRows++;
  }

  const result = fetchMatchCandidates_(SIRIUS_IMPORT_CONFIG.previewPageUrl);
  const counts = { '追加候補': 0, '要確認（一致候補あり）': 0, '集計対象外（SIRIUS内）': 0, '解析失敗': 0 };
  console.log('SOURCE: ' + SIRIUS_IMPORT_CONFIG.sourceLabel);
  console.log('Spreadsheet: ' + ss.getName());
  console.log('Sheet: ' + sheet.getName());
  console.log('Existing data rows: ' + existingRows);
  console.log('Fetched candidates: ' + result.candidates.length);
  console.log('HTTP status: ' + result.status);

  result.candidates.forEach(function(candidate, index) {
    const row = parseCandidateToCsvRow_(candidate);
    if (!row) {
      counts['解析失敗']++;
      console.log((index + 1) + '\t解析失敗\traw=' + candidate.text);
      return;
    }
    if (isInternalSiriusMatch_(row.team)) {
      counts['集計対象外（SIRIUS内）']++;
      console.log((index + 1) + '\t集計対象外（SIRIUS内）\tdate=' + row.date + '\tcategory=' + row.category + '\topponent=' + row.team + '\tscore=' + row.score + '\tresult=' + row.result + '\tsiriusTeam=' + row.siriusTeam + '\tpkScore=' + row.pkScore);
      return;
    }
    const key = makeMatchKey_(row.team, row.date, row.category, row.score, row.result);
    const matches = existing[key] || 0;
    const status = matches > 0 ? '要確認（一致候補あり）' : '追加候補';
    counts[status]++;
    console.log(
      (index + 1) + '\t' + status +
      '\texistingMatches=' + matches +
      '\tdate=' + row.date +
      '\tcategory=' + row.category +
      '\tteam=' + row.team +
      '\tscore=' + row.score +
      '\tresult=' + row.result +
      '\tsiriusTeam=' + row.siriusTeam +
      '\tpkScore=' + row.pkScore
    );
  });

  console.log('Summary:');
  console.log('追加候補=' + counts['追加候補']);
  console.log('要確認（一致候補あり）=' + counts['要確認（一致候補あり）']);
  console.log('集計対象外（SIRIUS内）=' + counts['集計対象外（SIRIUS内）']);
  console.log('解析失敗=' + counts['解析失敗']);
  console.log('照合のみ。シートへの書き込み・変更は行っていません。');
}

/** 対戦相手がFC SIRIUS内のチーム名かを判定する。 */
function isInternalSiriusMatch_(opponent) {
  const normalized = normalizeMatchText_(opponent).replace(/[\u3000\s]+/g, '').toUpperCase();
  return normalized.indexOf('FCSIRIUS') === 0 || normalized.indexOf('FCシリウス') === 0;
}

function makeMatchKey_(team, date, category, score, result) {
  return [
    normalizeMatchText_(team),
    normalizeMatchText_(date),
    normalizeMatchText_(category),
    normalizeMatchText_(score).replace(/[－―−：]/g, '-'),
    normalizeMatchText_(result)
  ].join('|');
}

function normalizeMatchText_(value) {
  return String(value == null ? '' : value)
    .replace(/[\u3000\s]+/g, ' ')
    .trim();
}

function normalizeSheetDate_(value, timeZone) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
  }
  const text = normalizeMatchText_(value);
  const match = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (match) {
    return match[1] + '-' + ('0' + match[2]).slice(-2) + '-' + ('0' + match[3]).slice(-2);
  }
  return text;
}

/** CSVセルをエスケープする。 */
function csvEscape_(value) {
  const text = value == null ? '' : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

/**
 * PK戦スコアがある試合だけを抽出して確認する（読み取り専用）。
 */
function previewPKRowsJune2026() {
  const result = fetchMatchCandidates_(SIRIUS_IMPORT_CONFIG.previewPageUrl);
  let pkCount = 0;
  let parseFailureCount = 0;
  console.log('SOURCE: ' + SIRIUS_IMPORT_CONFIG.sourceLabel);
  console.log('PK preview URL: ' + SIRIUS_IMPORT_CONFIG.previewPageUrl);
  console.log('Candidate count: ' + result.candidates.length);
  result.candidates.forEach(function(candidate, index) {
    const row = parseCandidateToCsvRow_(candidate);
    if (!row) {
      parseFailureCount++;
      return;
    }
    if (!row.pkScore) return;
    pkCount++;
    console.log(
      (pkCount) + '\t' +
      'team=' + row.team + '\t' +
      'siriusTeam=' + row.siriusTeam + '\t' +
      'date=' + candidate.date + '\t' +
      'category=' + candidate.category + '\t' +
      'score=' + row.score + '\t' +
      'result=' + row.result + '\t' +
      'pkScore=' + row.pkScore + '\t' +
      'raw=' + candidate.text
    );
  });
  console.log('PK rows found: ' + pkCount);
  console.log('Parse failures: ' + parseFailureCount);
}

function previewJune2026() {
  const result = fetchMatchCandidates_(SIRIUS_IMPORT_CONFIG.previewPageUrl);
  console.log('SOURCE: ' + SIRIUS_IMPORT_CONFIG.sourceLabel);
  console.log('URL: ' + SIRIUS_IMPORT_CONFIG.previewPageUrl);
  console.log('HTTP status: ' + result.status);
  console.log('Candidate count: ' + result.candidates.length);
  let parsedCount = 0;
  const previewLimit = 15;
  result.candidates.forEach(function(candidate, index) {
    const row = parseCandidateToCsvRow_(candidate);
    if (row) parsedCount++;
    if (index >= previewLimit) return;
    console.log(
      (index + 1) + '\t' +
      'team=' + (row ? row.team : '(要確認)') + '\t' +
      'siriusTeam=' + (row ? row.siriusTeam : '(要確認)') + '\t' +
      'date=' + candidate.date + '\t' +
      'category=' + candidate.category + '\t' +
      'score=' + (row ? row.score : '(要確認)') + '\t' +
      'result=' + (row ? row.result : '(要確認)') + '\t' +
      'pkScore=' + (row ? (row.pkScore || '-') : '(要確認)') + '\t' +
      'raw=' + candidate.text
    );
  });
  console.log('CSV parse success: ' + parsedCount);
  console.log('CSV parse needs review: ' + (result.candidates.length - parsedCount));
  console.log('Preview rows shown: ' + Math.min(previewLimit, result.candidates.length));
}

/**
 * CSV行に変換する。
 * teamは対戦相手、score/pkScoreはFC SIRIUS側から見たスコア、
 * resultは公式表示記号、siriusTeamはFC SIRIUS側のチーム名。
 */
function parseCandidateToCsvRow_(candidate) {
  const line = normalizeMatchText_(candidate.text);
  // 公式ページには勝ちマーク「○」「〇」「◯」が混在し、PK表記には全角括弧もある。
  const match = line.match(/^[〇○◯×△]\s*(.*?)\s+(\d{1,2})\s*[-－―−:：]\s*(\d{1,2})(?:\s*[（(]\s*PK\s*([0-9]{1,2})\s*[-－―−:：]\s*([0-9]{1,2})\s*[）)])?\s*(.*)$/i);
  if (!match) return null;

  const siriusTeam = (match[1] || '').replace(/\s+/g, ' ').trim();
  const pkScore = match[4] && match[5] ? match[4] + '-' + match[5] : '';
  let opponent = (match[6] || '').trim();
  opponent = opponent.replace(/\s*[（(]FM[）)]\s*$/i, '');
  opponent = opponent.replace(/\s+(?:予選リーグ.*|決勝戦|準決勝|準々決勝|\d+位通過|\d+位決定戦|\d+位決定リーグ).*$/, '').trim();
  if (!opponent) return null;

  const resultMark = line.charAt(0);
  const resultLabel = (resultMark === '〇' || resultMark === '○' || resultMark === '◯')
    ? '勝'
    : resultMark === '×' ? '敗' : '分';
  return {
    team: opponent,
    siriusTeam: siriusTeam,
    pkScore: pkScore,
    date: candidate.date,
    category: candidate.category,
    score: match[2] + '-' + match[3],
    result: resultLabel
  };
}

/** 公式ページの文字コード・タイトル・スコア行を診断する。 */
function diagnoseJune2026Page() {
  const response = UrlFetchApp.fetch(SIRIUS_IMPORT_CONFIG.previewPageUrl, {
    muteHttpExceptions: true,
    followRedirects: true
  });
  const html = response.getContentText('Shift_JIS');
  console.log('HTTP status: ' + response.getResponseCode());
  console.log('Content-Type: ' + (response.getHeaders()['Content-Type'] || '(unknown)'));
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  console.log('HTML title: ' + (title ? title[1].replace(/<[^>]+>/g, '').trim() : '(not found)'));
  console.log('HTML length: ' + html.length);
  console.log('HTML preview (first 6000 chars):\n' + html.slice(0, 6000));

  const lines = htmlToPlainText_(html).split('\n')
    .map(function(line) { return normalizeFullWidthDigits_(line).replace(/[\t\u00a0 ]+/g, ' ').trim(); })
    .filter(function(line) { return line.length > 0; });
  const scorePattern = /[0-9]{1,2}\s*[-－―−:：]\s*[0-9]{1,2}/;
  let printed = 0;
  for (let i = 0; i < lines.length && printed < 40; i++) {
    if (!scorePattern.test(lines[i])) continue;
    console.log('SCORE TEXT LINE ' + (printed + 1) + ': ' +
      lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 2)).join(' | '));
    printed++;
  }
  console.log('Score-containing text lines: ' + printed);
}

/**
 * スコアを含む行を候補化する。
 * ページにある全角数字を半角に正規化して判定し、日付・カテゴリは直近の見出しを引き継ぐ。
 */
function fetchMatchCandidates_(url, sourceYear, sourceMonth) {
  const effectiveYear = sourceYear || SIRIUS_IMPORT_CONFIG.sourceYear;
  const effectiveMonth = sourceMonth || SIRIUS_IMPORT_CONFIG.sourceMonth;
  const response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiriusMatchPreview/1.0)' }
  });
  const status = response.getResponseCode();
  const html = response.getContentText('Shift_JIS');
  if (status < 200 || status >= 300) return { status: status, candidates: [] };

  const lines = htmlToPlainText_(html).split('\n')
    .map(function(line) {
      return normalizeFullWidthDigits_(line).replace(/[\t\u00a0 ]+/g, ' ').trim();
    })
    .filter(function(line) { return line.length > 0; });

  const candidates = [];
  const seen = {};
  let currentDate = '';
  let currentCategory = '';
  const dateHeaderPattern = /(?:^|[・\s])(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
  const categoryPattern = /U\s*[-－]?\s*(\d{1,2})[^\n]{0,12}/i;
  const scorePattern = /(?:^|[^0-9])([0-9]{1,2})\s*[-－―−:：]\s*([0-9]{1,2})(?:$|[^0-9])/;

  for (let i = 0; i < lines.length && candidates.length < SIRIUS_IMPORT_CONFIG.maxCandidates; i++) {
    const line = lines[i];
    const dateMatch = line.match(dateHeaderPattern);
    if (dateMatch) {
      currentDate = effectiveYear + '-' +
        ('0' + effectiveMonth).slice(-2) + '-' +
        ('0' + dateMatch[2]).slice(-2);
    }

    const categoryMatch = line.match(categoryPattern);
    if (categoryMatch) currentCategory = 'U-' + categoryMatch[1];

    // 時刻（例: 13時集合〜17:00）をスコアと誤認しないよう、
    // 自チーム名を含む行に限定する。集合・中止などの予定情報は対象外。
    if (!scorePattern.test(line)) continue;
    if (!/FC\s*SIRIUS|FCシリウス|シリウス/i.test(line)) continue;
    if (/集合|中止|雨の為|雨天/.test(line)) continue;

    const key = currentDate + '|' + currentCategory + '|' + line;
    if (seen[key]) continue;
    seen[key] = true;
    candidates.push({
      date: currentDate,
      category: currentCategory,
      text: line
    });
  }
  return { status: status, candidates: candidates };
}

function normalizeFullWidthDigits_(text) {
  return text.replace(/[０-９]/g, function(character) {
    return String.fromCharCode(character.charCodeAt(0) - 0xFEE0);
  });
}

/** HTMLタグを除去し、基本的なHTMLエンティティを復元する。 */
function htmlToPlainText_(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/td|\/th|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&times;/gi, '×')
    .replace(/&#(\d+);/g, function(match, code) {
      return String.fromCharCode(Number(code));
    })
    .replace(/&#x([0-9a-f]+);/gi, function(match, code) {
      return String.fromCharCode(parseInt(code, 16));
    })
    .replace(/\r/g, '');
}
