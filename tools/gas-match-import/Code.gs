/**
 * FC SIRIUS公式サイト 試合結果取得プロトタイプ（読み取り専用）
 *
 * 公式サイトの月別ページを取得し、試合結果候補を実行ログに出す。
 * Google Sheetsへの書き込みやトリガー登録は行わない。
 */

const SIRIUS_IMPORT_CONFIG = {
  previewPageUrl: 'https://sc.footballnavi.jp/fcsirius/page.php?pno=2044',
  sourceLabel: 'FC SIRIUS公式サイト 2026年6月',
  sourceYear: 2026,
  sourceMonth: 6,
  maxCandidates: 150
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
  const line = candidate.text;
  const match = line.match(/^[〇×△]\s*(.*?)\s+(\d{1,2})\s*[-－―−:：]\s*(\d{1,2})(?:\s*\(PK[^)]*\))?\s*(.*)$/i);
  if (!match) return null;

  const siriusTeam = (match[1] || '').replace(/\s+/g, ' ').trim();
  const pkMatch = line.match(/\(PK\s*([0-9]{1,2})\s*[-－―−:：]\s*([0-9]{1,2})\)/i);
  const pkScore = pkMatch ? pkMatch[1] + '-' + pkMatch[2] : '';
  let opponent = (match[4] || '').trim();
  opponent = opponent.replace(/\s*（FM）\s*$/i, '').replace(/\s*\(FM\)\s*$/i, '');
  opponent = opponent.replace(/\s+(?:予選リーグ.*|決勝戦|準決勝|準々決勝|\d+位通過|\d+位決定戦|\d+位決定リーグ).*$/, '').trim();
  if (!opponent) return null;

  const resultMark = line.charAt(0);
  const resultLabel = resultMark === '〇' ? '勝' : resultMark === '×' ? '敗' : '分';
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
function fetchMatchCandidates_(url) {
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
      currentDate = SIRIUS_IMPORT_CONFIG.sourceYear + '-' +
        ('0' + SIRIUS_IMPORT_CONFIG.sourceMonth).slice(-2) + '-' +
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
