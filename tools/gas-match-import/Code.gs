/**
 * FC SIRIUS公式サイト 試合結果取得プロトタイプ（読み取り専用）
 *
 * 目的:
 *  - 公式サイトの月別ページを UrlFetchApp で取得
 *  - HTMLから試合結果らしいテキストを候補として抽出
 *  - Google Sheets への書き込みは行わず、ログにプレビューを出す
 *
 * 最初は2026年6月ページで候補を確認する。
 * 実際のHTML構造を確認してから、日付・カテゴリ・対戦相手の確定ロジックを固める。
 */

const SIRIUS_IMPORT_CONFIG = {
  previewPageUrl: 'https://sc.footballnavi.jp/fcsirius/page.php?pno=2044',
  sourceLabel: 'FC SIRIUS公式サイト 2026年6月',
  maxCandidates: 150
};

/**
 * 実行入口。Apps Scriptエディタから previewJune2026() を実行。
 * 出力先は実行ログのみ。シート変更・トリガー登録はしない。
 */
function previewJune2026() {
  const result = fetchMatchCandidates_(SIRIUS_IMPORT_CONFIG.previewPageUrl);
  console.log('SOURCE: ' + SIRIUS_IMPORT_CONFIG.sourceLabel);
  console.log('URL: ' + SIRIUS_IMPORT_CONFIG.previewPageUrl);
  console.log('HTTP status: ' + result.status);
  console.log('Candidate count: ' + result.candidates.length);
  result.candidates.forEach(function(candidate, index) {
    console.log(
      (index + 1) + '\t' +
      'date=' + (candidate.date || '(未確定)') + '\t' +
      'category=' + (candidate.category || '(未確定)') + '\t' +
      'text=' + candidate.text
    );
  });
}

/**
 * 取得したHTMLの構造を調査する診断関数。
 * 抽出候補が不自然な場合に実行ログから元HTMLの構造を確認する。
 * 先頭の一部と、スコアを含むHTML断片のみ出力する。
 */
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

  const scorePattern = /[0-9]{1,2}\s*[-－―−:：]\s*[0-9]{1,2}/;
  const fragments = html.match(/<(?:tr|li|p|div|td|dd|dt|article)\b[^>]*>[\s\S]{0,1200}?<\/(?:tr|li|p|div|td|dd|dt|article)>/gi) || [];
  let printed = 0;
  fragments.forEach(function(fragment) {
    if (printed >= 40 || !scorePattern.test(fragment)) return;
    console.log('SCORE HTML FRAGMENT ' + (printed + 1) + ': ' +
      fragment.replace(/\s+/g, ' ').slice(0, 1000));
    printed++;
  });
  console.log('Score-containing HTML fragments: ' + printed);
}

/**
 * 月別ページを取得し、スコア表記を含む周辺テキストを候補化する。
 * 日付・カテゴリは周辺テキストからの仮抽出であり、未確定値を推測で補完しない。
 */
function fetchMatchCandidates_(url) {
  const response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SiriusMatchPreview/1.0)'
    }
  });
  const status = response.getResponseCode();
  const html = response.getContentText('Shift_JIS');
  if (status < 200 || status >= 300) {
    return { status: status, candidates: [] };
  }

  const text = htmlToPlainText_(html);
  const candidates = [];
  const lines = text.split('\n')
    .map(function(line) { return line.replace(/[\t\u00a0 ]+/g, ' ').trim(); })
    .filter(function(line) { return line.length > 0; });

  // 例: 2-2 / 10－0 / 1：3 のようなスコア表記を含む行を候補にする。
  // スコア以外の数値を拾いにくくするため、区切りの左右を1～2桁に限定。
  const scorePattern = /(?:^|[^0-9])([0-9]{1,2})\s*[-－―−:：]\s*([0-9]{1,2})(?:$|[^0-9])/;
  for (let i = 0; i < lines.length && candidates.length < SIRIUS_IMPORT_CONFIG.maxCandidates; i++) {
    if (!scorePattern.test(lines[i])) continue;

    const context = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3));
    const combined = context.join(' | ');
    candidates.push({
      date: findDate_(combined),
      category: findCategory_(combined),
      text: combined
    });
  }

  return { status: status, candidates: dedupeCandidates_(candidates) };
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
    .replace(/&#(\d+);/g, function(match, code) {
      return String.fromCharCode(Number(code));
    })
    .replace(/&#x([0-9a-f]+);/gi, function(match, code) {
      return String.fromCharCode(parseInt(code, 16));
    })
    .replace(/\r/g, '');
}

/** 日付表記が明確に見つかった場合のみ YYYY-MM-DD にする。 */
function findDate_(text) {
  let match = text.match(/(202[0-9])\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?/);
  if (match) {
    return match[1] + '-' + ('0' + match[2]).slice(-2) + '-' + ('0' + match[3]).slice(-2);
  }
  match = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (match) {
    // 年が同じ周辺テキストにない場合は年を推測しない。
    return '';
  }
  return '';
}

/** U-7～U-15など、明示されたカテゴリのみ抽出する。 */
function findCategory_(text) {
  const match = text.match(/U\s*[-－]?\s*(\d{1,2})/i);
  return match ? 'U-' + match[1] : '';
}

function dedupeCandidates_(candidates) {
  const seen = {};
  return candidates.filter(function(candidate) {
    const key = candidate.text;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}
