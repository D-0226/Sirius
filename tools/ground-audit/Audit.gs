/**
 * FC SIRIUS観戦ガイド：グラウンド関連データの読み取り専用監査
 *
 * 実行関数: auditGroundDataReadOnly
 * 変更・追加・削除・トリガー登録は行わず、実行ログに監査結果を出力します。
 *
 * 前提: 対象のGoogleスプレッドシートに紐づいたApps Scriptで実行すること。
 */

function auditGroundDataReadOnly() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('対象スプレッドシートを取得できません。シートに紐づいたApps Scriptから実行してください。');

  const names = ss.getSheets().map(s => s.getName());
  const report = {
    audit: 'FC SIRIUS ground data read-only audit',
    executedAt: new Date().toISOString(),
    spreadsheetName: ss.getName(),
    spreadsheetId: ss.getId(),
    readOnly: true,
    sheets: [],
    issues: []
  };

  names.forEach(name => {
    const sh = ss.getSheetByName(name);
    const values = sh.getDataRange().getDisplayValues();
    const sheetInfo = {
      name: name,
      rowsIncludingHeader: values.length,
      columns: values.reduce((max, row) => Math.max(max, row.length), 0),
      headerCandidates: [],
      checks: []
    };

    // 見出し行を特定し、主要な関連列を確認する。シートへの書き込みはしない。
    const headerRowIndex = values.findIndex(row => row.some(cell => {
      const v = normalizeGroundAuditText_(cell);
      return ['ground', 'ground_name', 'groundname', 'grounds', '会場', 'グラウンド', 'グラウンド名', '場所'].includes(v);
    }));

    if (headerRowIndex >= 0) {
      const headers = values[headerRowIndex].map(v => String(v || '').trim());
      const normalizedHeaders = headers.map(normalizeGroundAuditText_);
      sheetInfo.headerRow = headerRowIndex + 1;
      sheetInfo.headers = headers;
      const findCol = aliases => normalizedHeaders.findIndex(h => aliases.includes(h));
      const groundCol = findCol(['ground', 'ground_name', 'groundname', 'grounds', '会場', 'グラウンド', 'グラウンド名', '場所']);
      const latCol = findCol(['lat', 'latitude', '緯度']);
      const lngCol = findCol(['lng', 'lon', 'longitude', '経度']);
      const memoCol = findCol(['memo', 'メモ', '観戦メモ']);
      const dataRows = values.slice(headerRowIndex + 1).filter(row => row.some(v => String(v || '').trim() !== ''));

      sheetInfo.dataRows = dataRows.length;
      sheetInfo.detectedColumns = {
        ground: groundCol >= 0 ? headers[groundCol] : null,
        latitude: latCol >= 0 ? headers[latCol] : null,
        longitude: lngCol >= 0 ? headers[lngCol] : null,
        memo: memoCol >= 0 ? headers[memoCol] : null
      };

      if (groundCol >= 0) {
        const namesSeen = {};
        const blankGroundRows = [];
        dataRows.forEach((row, i) => {
          const ground = String(row[groundCol] || '').trim();
          const sheetRow = headerRowIndex + 2 + i;
          if (!ground) blankGroundRows.push(sheetRow);
          else {
            const key = normalizeGroundAuditText_(ground);
            if (!namesSeen[key]) namesSeen[key] = {name: ground, rows: []};
            namesSeen[key].rows.push(sheetRow);
          }
        });
        const duplicates = Object.keys(namesSeen)
          .filter(k => namesSeen[k].rows.length > 1)
          .map(k => ({normalizedName: k, name: namesSeen[k].name, rows: namesSeen[k].rows}));
        sheetInfo.checks.push({check: 'blank_ground_name_rows', count: blankGroundRows.length, sampleRows: blankGroundRows.slice(0, 30)});
        sheetInfo.checks.push({check: 'duplicate_normalized_ground_names', count: duplicates.length, candidates: duplicates.slice(0, 50)});

        if (duplicates.length) report.issues.push({sheet: name, type: 'duplicate_ground_names', count: duplicates.length});
        if (blankGroundRows.length) report.issues.push({sheet: name, type: 'blank_ground_name', count: blankGroundRows.length});
      }

      if (latCol >= 0 && lngCol >= 0) {
        const invalid = [];
        dataRows.forEach((row, i) => {
          const ground = groundCol >= 0 ? String(row[groundCol] || '').trim() : '';
          const latText = String(row[latCol] || '').trim();
          const lngText = String(row[lngCol] || '').trim();
          const lat = Number(latText);
          const lng = Number(lngText);
          if (!latText || !lngText || !Number.isFinite(lat) || !Number.isFinite(lng) ||
              lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            invalid.push({row: headerRowIndex + 2 + i, ground: ground, lat: latText, lng: lngText});
          }
        });
        sheetInfo.checks.push({check: 'invalid_or_missing_coordinates', count: invalid.length, candidates: invalid.slice(0, 100)});
        if (invalid.length) report.issues.push({sheet: name, type: 'invalid_coordinates', count: invalid.length});
      }

      if (memoCol >= 0) {
        const emptyMemoRows = [];
        dataRows.forEach((row, i) => {
          if (!String(row[memoCol] || '').trim()) emptyMemoRows.push(headerRowIndex + 2 + i);
        });
        sheetInfo.checks.push({check: 'blank_memo_rows', count: emptyMemoRows.length, sampleRows: emptyMemoRows.slice(0, 30)});
      }
    } else {
      sheetInfo.headerRow = null;
      sheetInfo.headers = values.length ? values[0].map(v => String(v || '').trim()) : [];
      sheetInfo.note = '会場名の候補列を含むヘッダー行を自動検出できませんでした。シート名・列名を手動確認してください。';
    }

    report.sheets.push(sheetInfo);
  });

  // 必須タブの有無を確認するだけで、タブ作成や名称変更はしない。
  ['grounds', 'grounds_memo'].forEach(requiredName => {
    if (!names.includes(requiredName)) {
      report.issues.push({type: 'missing_expected_sheet', sheet: requiredName});
    }
  });

  console.log(JSON.stringify(report, null, 2));
  return report;
}

function normalizeGroundAuditText_(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\\s　_-]+/g, '')
    .trim();
}
