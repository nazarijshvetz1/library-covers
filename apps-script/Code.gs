/**
 * Google Sheets orchestration for the library cover ingestion workflow.
 * No secret values are stored in this source file.
 */

const COVER_AUTOMATION = Object.freeze({
  spreadsheetId: '18SEyo-tAJ8uHoAFMrYbiaGMtmXjhiscQGcYTpJrNtEI',
  sheetName: 'Матеріали',
  headerRow: 3,
  firstInputRow: 4,
  defaultOwner: 'nazarijshvetz1',
  defaultRepo: 'library-covers',
  rawPrefix: 'https://raw.githubusercontent.com/nazarijshvetz1/library-covers/main/covers/',
  headers: [
    'Джерело обкладинки',
    'Попередній перегляд',
    'Підтвердити обкладинку',
    'Статус обкладинки',
    'CAT-ID обкладинки',
    'Request ID обкладинки',
    'Знайдене зображення',
    'Фаза обкладинки',
    'Оновлено обкладинку',
  ],
  statuses: Object.freeze({
    waitingConfirmation: 'Очікує підтвердження',
    submitted: 'Надіслано на обробку',
    processing: 'Обробляється',
    completed: 'Обкладинку додано',
    alreadyExists: 'Файл уже існує',
    imageNotFound: 'Не знайдено зображення',
    unavailable: 'Посилання недоступне',
    unsupported: 'Непідтримуваний формат',
    directPhoto: 'Потрібна пряма фотографія',
    uploadError: 'Помилка завантаження',
    waitingCatId: 'Очікується створення CAT-ID',
  }),
});


/** Creates or repairs the cover fields and installs one edit and one clock trigger. */
function setupCoverAutomation() {
  const sheet = getCoverSheet_();
  const columns = ensureCoverColumns_(sheet);
  const lastRow = sheet.getMaxRows();
  const rowCount = Math.max(1, lastRow - COVER_AUTOMATION.firstInputRow + 1);

  const sourceColumn = columns['Джерело обкладинки'];
  const previewColumn = columns['Попередній перегляд'];
  const confirmColumn = columns['Підтвердити обкладинку'];
  const serviceStart = columns['Request ID обкладинки'];
  const serviceEnd = columns['Оновлено обкладинку'];

  const checkboxRule = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .setAllowInvalid(false)
    .build();
  sheet
    .getRange(COVER_AUTOMATION.firstInputRow, confirmColumn, rowCount, 1)
    .setDataValidation(checkboxRule);

  const previewFormula = [
    '=IF(RC[-1]="";"";',
    'IF(RC[5]<>"";IFERROR(IMAGE(RC[5]);"Зображення недоступне");',
    'IF(REGEXMATCH(LOWER(RC[-1]);"\\.(jpe?g|png|webp)(\\?.*)?$");',
    'IFERROR(IMAGE(RC[-1]);"Зображення недоступне");"Пошук зображення…")))',
  ].join('');
  sheet
    .getRange(COVER_AUTOMATION.firstInputRow, previewColumn, rowCount, 1)
    .setFormulaR1C1(previewFormula);

  sheet.setColumnWidth(sourceColumn, 260);
  sheet.setColumnWidth(previewColumn, 150);
  sheet.setColumnWidth(confirmColumn, 135);
  sheet.setColumnWidth(columns['Статус обкладинки'], 190);
  sheet.setColumnWidth(columns['CAT-ID обкладинки'], 125);
  sheet.hideColumns(serviceStart, serviceEnd - serviceStart + 1);

  configureCoverAutomation();
  installCoverAutomationTriggers();
  return columns;
}


/** Writes only non-secret defaults. GITHUB_TOKEN must be added manually. */
function configureCoverAutomation() {
  PropertiesService.getScriptProperties().setProperties(
    {
      GITHUB_OWNER: COVER_AUTOMATION.defaultOwner,
      GITHUB_REPO: COVER_AUTOMATION.defaultRepo,
    },
    false
  );
}


/** Installs exactly one owned trigger of each required type. */
function installCoverAutomationTriggers() {
  removeCoverAutomationTriggers();
  ScriptApp.newTrigger('onEditCoverAutomation')
    .forSpreadsheet(COVER_AUTOMATION.spreadsheetId)
    .onEdit()
    .create();
  ScriptApp.newTrigger('checkPendingCoverRequests')
    .timeBased()
    .everyMinutes(1)
    .create();
}


/** Removes only cover automation triggers owned by the current user. */
function removeCoverAutomationTriggers() {
  const handlers = new Set(['onEditCoverAutomation', 'checkPendingCoverRequests']);
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers.has(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}


/** Installable edit-trigger entry point. */
function onEditCoverAutomation(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== COVER_AUTOMATION.sheetName) return;
  if (e.range.getLastRow() < COVER_AUTOMATION.firstInputRow) return;

  const columns = findCoverColumns_(sheet);
  if (!columns) return;
  const sourceColumn = columns['Джерело обкладинки'];
  const confirmColumn = columns['Підтвердити обкладинку'];
  const firstChangedColumn = e.range.getColumn();
  const lastChangedColumn = e.range.getLastColumn();

  const startRow = Math.max(e.range.getRow(), COVER_AUTOMATION.firstInputRow);
  const endRow = e.range.getLastRow();
  for (let row = startRow; row <= endRow; row += 1) {
    if (sourceColumn >= firstChangedColumn && sourceColumn <= lastChangedColumn) {
      handleCoverSourceChange_(sheet, row, columns);
    }
    if (confirmColumn >= firstChangedColumn && confirmColumn <= lastChangedColumn) {
      handleCoverConfirmation_(sheet, row, columns);
    }
  }
}


function handleCoverSourceChange_(sheet, row, columns) {
  const source = String(sheet.getRange(row, columns['Джерело обкладинки']).getDisplayValue()).trim();
  sheet.getRange(row, columns['Підтвердити обкладинку']).setValue(false);
  clearCoverCells_(sheet, row, columns, [
    'Статус обкладинки',
    'CAT-ID обкладинки',
    'Request ID обкладинки',
    'Знайдене зображення',
    'Фаза обкладинки',
    'Оновлено обкладинку',
  ]);
  if (!source) return;
  if (!/^https?:\/\//i.test(source)) {
    setCoverStatus_(sheet, row, columns, COVER_AUTOMATION.statuses.unavailable);
    return;
  }
  submitCoverRequest(row, 'preview', false);
}


function handleCoverConfirmation_(sheet, row, columns) {
  const confirmed = sheet.getRange(row, columns['Підтвердити обкладинку']).isChecked();
  if (!confirmed) return;
  const source = String(sheet.getRange(row, columns['Джерело обкладинки']).getDisplayValue()).trim();
  if (!source) {
    sheet.getRange(row, columns['Підтвердити обкладинку']).setValue(false);
    setCoverStatus_(sheet, row, columns, COVER_AUTOMATION.statuses.unavailable);
    return;
  }
  const phase = String(sheet.getRange(row, columns['Фаза обкладинки']).getDisplayValue());
  if (phase !== 'preview_done') {
    sheet.getRange(row, columns['Підтвердити обкладинку']).setValue(false);
    setCoverStatus_(sheet, row, columns, 'Спочатку дочекайтеся попереднього перегляду');
    return;
  }
  submitCoverRequest(row, 'commit', false);
}


/** Submits a preview or commit request to GitHub Actions. */
function submitCoverRequest(row, mode, overwrite) {
  mode = mode || 'commit';
  overwrite = overwrite === true;
  if (mode !== 'preview' && mode !== 'commit') {
    throw new Error('Непідтримуваний режим обкладинки');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getCoverSheet_();
    const columns = findCoverColumns_(sheet);
    if (!columns || row < COVER_AUTOMATION.firstInputRow) return false;

    const source = String(sheet.getRange(row, columns['Джерело обкладинки']).getDisplayValue()).trim();
    if (!/^https?:\/\//i.test(source)) {
      setCoverStatus_(sheet, row, columns, COVER_AUTOMATION.statuses.unavailable);
      return false;
    }

    const activePhase = String(sheet.getRange(row, columns['Фаза обкладинки']).getDisplayValue());
    if (activePhase === mode + '_requested') return false;

    const catId = resolveCatId(row);
    if (mode === 'commit' && !catId) {
      setCoverStatus_(sheet, row, columns, COVER_AUTOMATION.statuses.waitingCatId);
      sheet.getRange(row, columns['Фаза обкладинки']).setValue('waiting_cat');
      sheet.getRange(row, columns['Оновлено обкладинку']).setValue(new Date());
      return false;
    }
    if (catId) sheet.getRange(row, columns['CAT-ID обкладинки']).setValue(catId);

    const requestId = Utilities.getUuid();
    sheet.getRange(row, columns['Request ID обкладинки']).setValue(requestId);
    sheet.getRange(row, columns['Фаза обкладинки']).setValue(mode + '_requested');
    sheet.getRange(row, columns['Оновлено обкладинку']).setValue(new Date());
    setCoverStatus_(sheet, row, columns, COVER_AUTOMATION.statuses.submitted);

    dispatchCoverRequest_({
      cat_id: catId || '',
      source_url: source,
      request_id: requestId,
      mode: mode,
      overwrite: overwrite,
      dry_run: false,
    });
    setCoverStatus_(sheet, row, columns, COVER_AUTOMATION.statuses.processing);
    return true;
  } catch (error) {
    const sheet = getCoverSheet_();
    const columns = findCoverColumns_(sheet);
    if (columns) {
      setCoverStatus_(sheet, row, columns, COVER_AUTOMATION.statuses.uploadError);
      sheet.getRange(row, columns['Фаза обкладинки']).setValue('error');
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}


/** Resolves the final CAT-ID by normalized ISBN in the master material table. */
function resolveCatId(row) {
  const sheet = getCoverSheet_();
  const inputHeaders = getHeaderMap_(sheet, COVER_AUTOMATION.headerRow);
  const isbnInputColumn = inputHeaders['ISBN нормалізований'];
  if (!isbnInputColumn) return '';
  const isbn = normalizeIsbn_(sheet.getRange(row, isbnInputColumn).getDisplayValue());
  if (!isbn) return '';

  const masterHeaders = getHeaderMap_(sheet, 1);
  const masterIsbnColumn = masterHeaders['ISBN нормалізований'];
  if (!masterIsbnColumn) return '';
  const match = sheet
    .getRange(2, masterIsbnColumn, Math.max(1, sheet.getMaxRows() - 1), 1)
    .createTextFinder(isbn)
    .matchEntireCell(true)
    .matchCase(false)
    .findNext();
  if (!match) return '';
  const catId = String(sheet.getRange(match.getRow(), 1).getDisplayValue()).trim();
  return /^CAT-\d{4,}$/.test(catId) ? catId : '';
}


/** Polls only rows that have a pending request or wait for CAT-ID creation. */
function checkPendingCoverRequests() {
  const sheet = getCoverSheet_();
  const columns = findCoverColumns_(sheet);
  if (!columns) return;
  const rowCount = sheet.getMaxRows() - COVER_AUTOMATION.firstInputRow + 1;
  const sources = sheet
    .getRange(COVER_AUTOMATION.firstInputRow, columns['Джерело обкладинки'], rowCount, 1)
    .getDisplayValues();
  let handled = 0;

  for (let offset = 0; offset < sources.length && handled < 20; offset += 1) {
    if (!sources[offset][0]) continue;
    const row = COVER_AUTOMATION.firstInputRow + offset;
    const phase = String(sheet.getRange(row, columns['Фаза обкладинки']).getDisplayValue());

    if (phase === 'waiting_cat') {
      if (sheet.getRange(row, columns['Підтвердити обкладинку']).isChecked() && resolveCatId(row)) {
        submitCoverRequest(row, 'commit', false);
        handled += 1;
      }
      continue;
    }

    if (phase !== 'preview_requested' && phase !== 'commit_requested') continue;
    const requestId = String(sheet.getRange(row, columns['Request ID обкладинки']).getDisplayValue()).trim();
    if (!requestId) continue;
    const result = fetchCoverResult_(requestId);
    if (!result) continue;
    updateCoverResult(row, result);
    handled += 1;
  }
}


/** Applies a GitHub result only when its request ID still matches the row. */
function updateCoverResult(row, result) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getCoverSheet_();
    const columns = findCoverColumns_(sheet);
    if (!columns) return false;
    const currentRequestId = String(
      sheet.getRange(row, columns['Request ID обкладинки']).getDisplayValue()
    ).trim();
    if (!shouldApplyCoverResult_(currentRequestId, result)) return false;

    const phase = String(sheet.getRange(row, columns['Фаза обкладинки']).getDisplayValue());
    if (result.success && result.status === 'preview_ready' && phase === 'preview_requested') {
      sheet.getRange(row, columns['Знайдене зображення']).setValue(result.image_source_url || '');
      sheet.getRange(row, columns['Фаза обкладинки']).setValue('preview_done');
      sheet.getRange(row, columns['Підтвердити обкладинку']).setValue(false);
      sheet.getRange(row, columns['Оновлено обкладинку']).setValue(new Date());
      setCoverStatus_(sheet, row, columns, COVER_AUTOMATION.statuses.waitingConfirmation);
      return true;
    }

    if (
      result.success &&
      (result.status === 'completed' || result.status === 'already_exists' || result.status === 'dry_run_completed') &&
      phase === 'commit_requested'
    ) {
      const expectedCatId = String(sheet.getRange(row, columns['CAT-ID обкладинки']).getDisplayValue()).trim();
      const expectedUrl = COVER_AUTOMATION.rawPrefix + expectedCatId + '.jpg';
      if (!/^CAT-\d{4,}$/.test(expectedCatId) || result.cat_id !== expectedCatId) return false;
      if (result.final_url !== expectedUrl) return false;
      const inputHeaders = getHeaderMap_(sheet, COVER_AUTOMATION.headerRow);
      const finalUrlColumn = inputHeaders['Обкладинка (URL)'];
      if (!finalUrlColumn) throw new Error('Не знайдено колонку «Обкладинка (URL)»');
      sheet.getRange(row, finalUrlColumn).setValue(result.final_url);
      sheet.getRange(row, columns['Знайдене зображення']).setValue(result.image_source_url || '');
      sheet.getRange(row, columns['Підтвердити обкладинку']).setValue(false);
      sheet.getRange(row, columns['Фаза обкладинки']).setValue('done');
      sheet.getRange(row, columns['Оновлено обкладинку']).setValue(new Date());
      setCoverStatus_(
        sheet,
        row,
        columns,
        result.status === 'already_exists'
          ? COVER_AUTOMATION.statuses.alreadyExists
          : COVER_AUTOMATION.statuses.completed
      );
      return true;
    }

    const mappedStatus = mapCoverErrorStatus_(result.status);
    setCoverStatus_(sheet, row, columns, mappedStatus);
    sheet.getRange(row, columns['Фаза обкладинки']).setValue('error');
    sheet.getRange(row, columns['Підтвердити обкладинку']).setValue(false);
    sheet.getRange(row, columns['Оновлено обкладинку']).setValue(new Date());
    return true;
  } finally {
    lock.releaseLock();
  }
}


/** Pure helper intentionally kept testable outside Apps Script. */
function shouldApplyCoverResult_(currentRequestId, result) {
  return Boolean(
    currentRequestId &&
      result &&
      typeof result.request_id === 'string' &&
      currentRequestId === result.request_id
  );
}


function dispatchCoverRequest_(clientPayload) {
  const config = getGitHubConfig_();
  const url = 'https://api.github.com/repos/' +
    encodeURIComponent(config.owner) + '/' +
    encodeURIComponent(config.repo) + '/dispatches';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + config.token,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({
      event_type: 'cover_ingest',
      client_payload: clientPayload,
    }),
  });
  if (response.getResponseCode() !== 204) {
    throw new Error('GitHub не прийняв запит. HTTP ' + response.getResponseCode());
  }
}


function fetchCoverResult_(requestId) {
  const config = getGitHubConfig_();
  const path = 'cover-status/requests/' + encodeURIComponent(requestId) + '.json';
  const url = 'https://api.github.com/repos/' +
    encodeURIComponent(config.owner) + '/' +
    encodeURIComponent(config.repo) + '/contents/' + path + '?ref=main';
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + config.token,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() !== 200) return null;
  try {
    const envelope = JSON.parse(response.getContentText());
    const decoded = Utilities.newBlob(Utilities.base64Decode(String(envelope.content || '').replace(/\s/g, '')))
      .getDataAsString('UTF-8');
    return JSON.parse(decoded);
  } catch (error) {
    return null;
  }
}


function getGitHubConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const token = properties.getProperty('GITHUB_TOKEN');
  const owner = properties.getProperty('GITHUB_OWNER') || COVER_AUTOMATION.defaultOwner;
  const repo = properties.getProperty('GITHUB_REPO') || COVER_AUTOMATION.defaultRepo;
  if (!token) throw new Error('У Script Properties відсутній GITHUB_TOKEN');
  return { token: token, owner: owner, repo: repo };
}


function ensureCoverColumns_(sheet) {
  let map = findCoverColumns_(sheet);
  if (map) return map;

  const rowValues = sheet.getRange(COVER_AUTOMATION.headerRow, 1, 1, sheet.getMaxColumns()).getDisplayValues()[0];
  const existingPositions = COVER_AUTOMATION.headers
    .map(function (header) { return rowValues.indexOf(header) + 1; })
    .filter(function (column) { return column > 0; });

  let startColumn;
  if (existingPositions.length) {
    startColumn = Math.min.apply(null, existingPositions);
  } else {
    let lastHeaderColumn = 0;
    rowValues.forEach(function (value, index) {
      if (String(value).trim()) lastHeaderColumn = index + 1;
    });
    startColumn = lastHeaderColumn + 1;
  }

  const requiredLastColumn = startColumn + COVER_AUTOMATION.headers.length - 1;
  if (sheet.getMaxColumns() < requiredLastColumn) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredLastColumn - sheet.getMaxColumns());
  }
  const target = sheet.getRange(
    COVER_AUTOMATION.headerRow,
    startColumn,
    1,
    COVER_AUTOMATION.headers.length
  );
  const current = target.getDisplayValues()[0];
  current.forEach(function (value, index) {
    if (value && value !== COVER_AUTOMATION.headers[index]) {
      throw new Error('Колонки праворуч від блоку вже зайняті: ' + value);
    }
  });
  const exemplarColumn = Math.max(1, startColumn - 1);
  sheet
    .getRange(COVER_AUTOMATION.headerRow, exemplarColumn)
    .copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  target.setValues([COVER_AUTOMATION.headers]);
  map = findCoverColumns_(sheet);
  if (!map) throw new Error('Не вдалося створити колонки автоматизації обкладинок');
  return map;
}


function findCoverColumns_(sheet) {
  const map = getHeaderMap_(sheet, COVER_AUTOMATION.headerRow);
  for (let i = 0; i < COVER_AUTOMATION.headers.length; i += 1) {
    if (!map[COVER_AUTOMATION.headers[i]]) return null;
  }
  return map;
}


function getHeaderMap_(sheet, headerRow) {
  const values = sheet.getRange(headerRow, 1, 1, sheet.getMaxColumns()).getDisplayValues()[0];
  const map = {};
  values.forEach(function (value, index) {
    const header = String(value || '').trim();
    if (header && !map[header]) map[header] = index + 1;
  });
  return map;
}


function getCoverSheet_() {
  const spreadsheet = SpreadsheetApp.openById(COVER_AUTOMATION.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(COVER_AUTOMATION.sheetName);
  if (!sheet) throw new Error('Не знайдено аркуш «' + COVER_AUTOMATION.sheetName + '»');
  return sheet;
}


function normalizeIsbn_(value) {
  return String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
}


function setCoverStatus_(sheet, row, columns, status) {
  sheet.getRange(row, columns['Статус обкладинки']).setValue(status || '');
}


function clearCoverCells_(sheet, row, columns, headers) {
  headers.forEach(function (header) {
    sheet.getRange(row, columns[header]).clearContent();
  });
}


function mapCoverErrorStatus_(status) {
  const statuses = COVER_AUTOMATION.statuses;
  const map = {
    image_not_found: statuses.imageNotFound,
    url_unavailable: statuses.unavailable,
    invalid_url: statuses.unavailable,
    unsafe_url: statuses.unavailable,
    too_many_redirects: statuses.unavailable,
    unsupported_format: statuses.unsupported,
    file_too_large: statuses.directPhoto,
    invalid_cat_id: statuses.waitingCatId,
  };
  return map[status] || statuses.uploadError;
}
