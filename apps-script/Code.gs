/**
 * Google Sheets orchestration for the library cover ingestion workflow.
 * No secret values are stored in this source file.
 */

const COVER_AUTOMATION = Object.freeze({
  spreadsheetId: '18SEyo-tAJ8uHoAFMrYbiaGMtmXjhiscQGcYTpJrNtEI',
  sheetName: 'Матеріали',
  coverSheetName: 'Обкладинки',
  masterHeaderRow: 1,
  headerRow: 3,
  firstInputRow: 4,
  newBookLastInputRow: 20,
  maxSelectedBatchSize: 5,
  defaultProcessingMode: 'direct',
  maxRedirects: 5,
  maxHtmlBytes: 1500000,
  maxImageBytes: 8000000,
  requestTimeoutSeconds: 20,
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
      COVER_PROCESSING_MODE: COVER_AUTOMATION.defaultProcessingMode,
    },
    false
  );
}


/** Installs exactly one owned trigger of each required type. */
function installCoverAutomationTriggers() {
  removeCoverAutomationTriggers();
  ScriptApp.newTrigger('onOpenCoverAutomation')
    .forSpreadsheet(COVER_AUTOMATION.spreadsheetId)
    .onOpen()
    .create();
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
  const handlers = new Set([
    'onOpenCoverAutomation',
    'onEditCoverAutomation',
    'checkPendingCoverRequests',
  ]);
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers.has(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}


/** Adds a separate menu without replacing any existing onOpen function. */
function onOpenCoverAutomation() {
  addCoverAutomationMenu_();
}


function addCoverAutomationMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('Обкладинки')
    .addItem('Знайти для виділених матеріалів', 'queueSelectedExistingCoverPreviews')
    .addItem('Зберегти виділені обкладинки', 'commitSelectedExistingCovers')
    .addToUi();
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


/**
 * Sends preview requests for selected existing material rows.
 * The visible source field wins; otherwise the current "Електронна версія"
 * URL is used as the publication-page source. At most five rows are accepted.
 */
function queueSelectedExistingCoverPreviews() {
  const sheet = getCoverSheet_();
  const columns = findCoverColumns_(sheet);
  const rows = getSelectedExistingMaterialRows_(sheet);
  const masterHeaders = getHeaderMap_(sheet, COVER_AUTOMATION.masterHeaderRow);
  const catColumn = masterHeaders['ID матеріалу'];
  const fallbackSourceColumn = masterHeaders['Електронна версія'];
  const coverFlagColumn = masterHeaders['Обкладинка'];
  if (!catColumn || !fallbackSourceColumn || !coverFlagColumn) {
    throw new Error('Не знайдено службові колонки основної таблиці матеріалів');
  }

  const summary = { submitted: 0, skipped: 0, messages: [] };
  rows.forEach(function (row) {
    const catId = String(sheet.getRange(row, catColumn).getDisplayValue()).trim();
    const coverFlag = String(sheet.getRange(row, coverFlagColumn).getDisplayValue()).trim();
    const visibleSource = String(
      sheet.getRange(row, columns['Джерело обкладинки']).getDisplayValue()
    ).trim();
    const fallbackSource = String(
      sheet.getRange(row, fallbackSourceColumn).getDisplayValue()
    ).trim();
    const source = chooseExistingCoverSource_(visibleSource, fallbackSource);

    if (!isValidCatId_(catId)) {
      summary.skipped += 1;
      summary.messages.push('Рядок ' + row + ': неправильний CAT-ID');
      return;
    }
    if (coverFlag === 'Так') {
      summary.skipped += 1;
      summary.messages.push(catId + ': обкладинка вже позначена як наявна');
      return;
    }
    if (!source) {
      summary.skipped += 1;
      summary.messages.push(catId + ': немає доступного URL');
      return;
    }

    prepareExistingCoverRow_(sheet, row, columns, catId, source);
    if (submitCoverRequest(row, 'preview', false)) {
      summary.submitted += 1;
    } else {
      summary.skipped += 1;
      summary.messages.push(
        catId + ': ' + String(sheet.getRange(row, columns['Статус обкладинки']).getDisplayValue())
      );
    }
  });
  showExistingCoverBatchSummary_('Пошук обкладинок', summary);
  return summary;
}


/** Commits only selected rows whose preview has already completed. */
function commitSelectedExistingCovers() {
  const sheet = getCoverSheet_();
  const columns = findCoverColumns_(sheet);
  const rows = getSelectedExistingMaterialRows_(sheet);
  const summary = { submitted: 0, skipped: 0, messages: [] };

  rows.forEach(function (row) {
    const catId = String(sheet.getRange(row, columns['CAT-ID обкладинки']).getDisplayValue()).trim();
    const phase = String(sheet.getRange(row, columns['Фаза обкладинки']).getDisplayValue()).trim();
    if (!isValidCatId_(catId) || phase !== 'preview_done') {
      summary.skipped += 1;
      summary.messages.push('Рядок ' + row + ': preview ще не готовий');
      return;
    }
    if (submitCoverRequest(row, 'commit', false)) {
      summary.submitted += 1;
    } else {
      summary.skipped += 1;
      summary.messages.push(
        catId + ': ' + String(sheet.getRange(row, columns['Статус обкладинки']).getDisplayValue())
      );
    }
  });
  showExistingCoverBatchSummary_('Збереження обкладинок', summary);
  return summary;
}


function getSelectedExistingMaterialRows_(sheet) {
  const activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = activeSpreadsheet && activeSpreadsheet.getActiveSheet();
  const range = activeSheet && activeSheet.getActiveRange();
  if (!range || activeSheet.getSheetId() !== sheet.getSheetId()) {
    throw new Error('Спочатку виділіть рядки на аркуші «Матеріали»');
  }
  const startRow = Math.max(range.getRow(), COVER_AUTOMATION.firstInputRow);
  const endRow = range.getLastRow();
  if (endRow < startRow) throw new Error('У виділенні немає рядків матеріалів');
  const count = endRow - startRow + 1;
  if (count > COVER_AUTOMATION.maxSelectedBatchSize) {
    throw new Error('За один запуск можна обробити не більше 5 рядків');
  }
  return Array.from({ length: count }, function (_, index) { return startRow + index; });
}


function prepareExistingCoverRow_(sheet, row, columns, catId, source) {
  sheet.getRange(row, columns['Джерело обкладинки']).setValue(source);
  sheet.getRange(row, columns['Підтвердити обкладинку']).setValue(false);
  clearCoverCells_(sheet, row, columns, [
    'Статус обкладинки',
    'CAT-ID обкладинки',
    'Request ID обкладинки',
    'Знайдене зображення',
    'Фаза обкладинки',
    'Оновлено обкладинку',
  ]);
  sheet.getRange(row, columns['CAT-ID обкладинки']).setValue(catId);
}


function showExistingCoverBatchSummary_(title, summary) {
  const details = summary.messages.slice(0, 5);
  const suffix = summary.messages.length > details.length
    ? '\n…ще ' + (summary.messages.length - details.length)
    : '';
  SpreadsheetApp.getUi().alert(
    title + ': надіслано ' + summary.submitted + ', пропущено ' + summary.skipped +
    (details.length ? '\n\n' + details.join('\n') + suffix : '')
  );
}


/** Processes a request directly or submits it to GitHub Actions in reserve mode. */
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

    const processingMode = getCoverProcessingMode_();
    const activePhase = String(sheet.getRange(row, columns['Фаза обкладинки']).getDisplayValue());
    if (processingMode === 'actions' && activePhase === mode + '_requested') return false;
    if (processingMode === 'direct' && activePhase === mode + '_processing') return false;

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
    sheet.getRange(row, columns['Фаза обкладинки']).setValue(
      mode + (processingMode === 'direct' ? '_processing' : '_requested')
    );
    sheet.getRange(row, columns['Оновлено обкладинку']).setValue(new Date());
    setCoverStatus_(
      sheet,
      row,
      columns,
      processingMode === 'direct'
        ? COVER_AUTOMATION.statuses.processing
        : COVER_AUTOMATION.statuses.submitted
    );

    if (processingMode === 'direct') {
      return processCoverDirect_(sheet, row, columns, {
        catId: catId || '',
        sourceUrl: source,
        requestId: requestId,
        mode: mode,
        overwrite: overwrite,
      });
    }

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
      setCoverStatus_(sheet, row, columns, mapDirectCoverError_(error));
      sheet.getRange(row, columns['Фаза обкладинки']).setValue('error');
      sheet.getRange(row, columns['Підтвердити обкладинку']).setValue(false);
      sheet.getRange(row, columns['Оновлено обкладинку']).setValue(new Date());
    }
    if (getCoverProcessingMode_() === 'direct') return false;
    throw error;
  } finally {
    lock.releaseLock();
  }
}


/** Direct fallback that does not depend on GitHub Actions runners. */
function processCoverDirect_(sheet, row, columns, request) {
  const imageSourceUrl = request.mode === 'commit'
    ? chooseExistingCoverSource_(
      String(sheet.getRange(row, columns['Знайдене зображення']).getDisplayValue()).trim(),
      request.sourceUrl
    )
    : resolveImageSourceDirect_(request.sourceUrl);

  if (!imageSourceUrl) throw createCoverError_('image_not_found', 'Не знайдено зображення');

  if (request.mode === 'preview') {
    sheet.getRange(row, columns['Знайдене зображення']).setValue(imageSourceUrl);
    sheet.getRange(row, columns['Фаза обкладинки']).setValue('preview_done');
    sheet.getRange(row, columns['Підтвердити обкладинку']).setValue(false);
    sheet.getRange(row, columns['Оновлено обкладинку']).setValue(new Date());
    setCoverStatus_(sheet, row, columns, COVER_AUTOMATION.statuses.waitingConfirmation);
    return true;
  }

  if (!isValidCatId_(request.catId)) {
    throw createCoverError_('invalid_cat_id', 'Неправильний CAT-ID');
  }
  const jpegBlob = downloadImageAsJpegDirect_(imageSourceUrl, request.catId);
  const upload = uploadCoverToGitHubDirect_(request.catId, jpegBlob, request.overwrite);
  const finalUrl = COVER_AUTOMATION.rawPrefix + request.catId + '.jpg';

  const inputHeaders = getHeaderMap_(sheet, COVER_AUTOMATION.headerRow);
  const finalUrlColumn = inputHeaders['Обкладинка (URL)'];
  if (!finalUrlColumn) throw new Error('Не знайдено колонку «Обкладинка (URL)»');
  sheet.getRange(row, finalUrlColumn).setValue(finalUrl);
  sheet.getRange(row, columns['Знайдене зображення']).setValue(imageSourceUrl);
  applyFinalCoverToCatalog_(request.catId, finalUrl);
  sheet.getRange(row, columns['Підтвердити обкладинку']).setValue(false);
  sheet.getRange(row, columns['Фаза обкладинки']).setValue('done');
  sheet.getRange(row, columns['Оновлено обкладинку']).setValue(new Date());
  setCoverStatus_(
    sheet,
    row,
    columns,
    upload.alreadyExists
      ? COVER_AUTOMATION.statuses.alreadyExists
      : COVER_AUTOMATION.statuses.completed
  );
  return true;
}


function getCoverProcessingMode_() {
  const value = String(
    PropertiesService.getScriptProperties().getProperty('COVER_PROCESSING_MODE') ||
    COVER_AUTOMATION.defaultProcessingMode
  ).toLowerCase();
  return value === 'actions' ? 'actions' : 'direct';
}


function resolveImageSourceDirect_(sourceUrl) {
  const page = fetchDirectResource_(sourceUrl, COVER_AUTOMATION.maxImageBytes…2136 tokens truncated…  ) || [];
  for (let jsonIndex = 0; jsonIndex < jsonLdBlocks.length; jsonIndex += 1) {
    const jsonText = jsonLdBlocks[jsonIndex]
      .replace(/^<script\b[^>]*>/i, '')
      .replace(/<\/script>$/i, '')
      .trim();
    try {
      const imageValue = findJsonLdImage_(JSON.parse(jsonText), 0);
      const candidate = Array.isArray(imageValue) ? imageValue[0] : imageValue;
      const resolved = resolveRelativeUrl_(candidate || '', baseUrl);
      if (isSafePublicUrlCandidate_(resolved)) return resolved;
    } catch (error) {
      // Ignore malformed JSON-LD and continue to the next block.
    }
  }
  return '';
}


function parseHtmlAttributes_(tag) {
  const result = {};
  const attributePattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = attributePattern.exec(String(tag || ''))) !== null) {
    result[String(match[1]).toLowerCase()] = decodeHtmlEntities_(match[2] || match[3] || match[4] || '');
  }
  return result;
}


function findJsonLdImage_(value, depth) {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findJsonLdImage_(value[index], depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const direct = value.image || value.thumbnailUrl;
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && direct.length) return direct;
  if (direct && typeof direct === 'object' && typeof direct.url === 'string') return direct.url;
  const keys = Object.keys(value);
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const found = findJsonLdImage_(value[keys[keyIndex]], depth + 1);
    if (found) return found;
  }
  return '';
}


function decodeHtmlEntities_(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, function (_, code) { return String.fromCharCode(Number(code)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, code) { return String.fromCharCode(parseInt(code, 16)); });
}


function resolveRelativeUrl_(value, baseUrl) {
  const candidate = decodeHtmlEntities_(value).trim();
  if (!candidate) return '';
  if (/^https?:\/\//i.test(candidate)) return candidate;
  const baseMatch = String(baseUrl || '').match(/^(https?):\/\/([^\/?#]+)(\/[^?#]*)?/i);
  if (!baseMatch) return '';
  const origin = baseMatch[1] + '://' + baseMatch[2];
  if (/^\/\//.test(candidate)) return baseMatch[1] + ':' + candidate;
  if (/^\//.test(candidate)) return origin + candidate;

  const suffixMatch = candidate.match(/^([^?#]*)([?#][\s\S]*)?$/);
  const relativePath = suffixMatch ? suffixMatch[1] : candidate;
  const suffix = suffixMatch && suffixMatch[2] ? suffixMatch[2] : '';
  const basePath = baseMatch[3] || '/';
  const directory = /\/$/.test(basePath) ? basePath : basePath.replace(/\/[^\/]*$/, '/');
  const parts = (directory + relativePath).split('/');
  const normalized = [];
  parts.forEach(function (part) {
    if (!part || part === '.') return;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  });
  return origin + '/' + normalized.join('/') + suffix;
}


function isSafePublicUrlCandidate_(value) {
  const match = String(value || '').trim().match(/^(https?):\/\/([^\/?#]+)(?:[\/?#]|$)/i);
  if (!match || match[2].indexOf('@') !== -1) return false;
  let authority = match[2].toLowerCase();
  let host;
  if (authority[0] === '[') {
    const bracketEnd = authority.indexOf(']');
    if (bracketEnd === -1) return false;
    host = authority.slice(1, bracketEnd);
  } else {
    host = authority.split(':')[0];
  }
  if (!host || host === 'localhost' || /\.(localhost|local)$/.test(host)) return false;
  if (host === 'metadata.google.internal') return false;
  if (host.indexOf(':') !== -1) {
    const compact = host.replace(/^0+/, '');
    if (compact === '' || compact === '::' || compact === '::1') return false;
    if (/^(fc|fd)/i.test(compact) || /^fe[89ab]/i.test(compact)) return false;
    if (/^::ffff:(127\.|10\.|192\.168\.|169\.254\.)/i.test(compact)) return false;
    return true;
  }
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return true;
  const octets = host.split('.').map(Number);
  if (octets.some(function (part) { return part < 0 || part > 255; })) return false;
  const first = octets[0];
  const second = octets[1];
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  return true;
}


function createCoverError_(status, message) {
  const error = new Error(message || status);
  error.coverStatus = status;
  return error;
}


function mapDirectCoverError_(error) {
  const status = error && error.coverStatus ? error.coverStatus : 'upload_error';
  return mapCoverErrorStatus_(status);
}


/** Resolves the final CAT-ID by normalized ISBN in the master material table. */
function resolveCatId(row) {
  const sheet = getCoverSheet_();
  const columns = findCoverColumns_(sheet);
  const explicitCatId = columns
    ? String(sheet.getRange(row, columns['CAT-ID обкладинки']).getDisplayValue()).trim()
    : '';
  const masterHeaders = getHeaderMap_(sheet, COVER_AUTOMATION.masterHeaderRow);
  const masterCatColumn = masterHeaders['ID матеріалу'];
  const directCatId = row > COVER_AUTOMATION.newBookLastInputRow && masterCatColumn
    ? String(sheet.getRange(row, masterCatColumn).getDisplayValue()).trim()
    : '';
  const earlyCatId = chooseResolvedCatId_(explicitCatId, directCatId, '', true);
  if (earlyCatId) return earlyCatId;

  const inputHeaders = getHeaderMap_(sheet, COVER_AUTOMATION.headerRow);
  const isbnInputColumn = inputHeaders['ISBN нормалізований'];
  if (!isbnInputColumn) return '';
  const isbn = normalizeIsbn_(sheet.getRange(row, isbnInputColumn).getDisplayValue());
  if (!isbn) return '';

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
  return chooseResolvedCatId_('', '', catId, false);
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
      applyFinalCoverToCatalog_(expectedCatId, result.final_url);
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


function isValidCatId_(value) {
  return /^CAT-\d{4,}$/.test(String(value || '').trim());
}


/** Pure helper used by both the existing-row and ISBN workflows. */
function chooseResolvedCatId_(explicitCatId, directCatId, isbnCatId, allowDirect) {
  if (isValidCatId_(explicitCatId)) return String(explicitCatId).trim();
  if (allowDirect && isValidCatId_(directCatId)) return String(directCatId).trim();
  return isValidCatId_(isbnCatId) ? String(isbnCatId).trim() : '';
}


function chooseExistingCoverSource_(visibleSource, fallbackSource) {
  const preferred = String(visibleSource || '').trim();
  const fallback = String(fallbackSource || '').trim();
  if (/^https?:\/\//i.test(preferred)) return preferred;
  return /^https?:\/\//i.test(fallback) ? fallback : '';
}


/** Updates the master flag and the exact row used by every catalog/revision image lookup. */
function applyFinalCoverToCatalog_(catId, finalUrl) {
  if (!isValidCatId_(catId)) return false;
  if (finalUrl !== COVER_AUTOMATION.rawPrefix + catId + '.jpg') return false;

  const spreadsheet = SpreadsheetApp.openById(COVER_AUTOMATION.spreadsheetId);
  const materialSheet = spreadsheet.getSheetByName(COVER_AUTOMATION.sheetName);
  const masterHeaders = getHeaderMap_(materialSheet, COVER_AUTOMATION.masterHeaderRow);
  const catColumn = masterHeaders['ID матеріалу'];
  const coverFlagColumn = masterHeaders['Обкладинка'];
  if (catColumn && coverFlagColumn) {
    const materialMatch = materialSheet
      .getRange(2, catColumn, Math.max(1, materialSheet.getMaxRows() - 1), 1)
      .createTextFinder(catId)
      .matchEntireCell(true)
      .matchCase(true)
      .findNext();
    if (materialMatch) materialSheet.getRange(materialMatch.getRow(), coverFlagColumn).setValue('Так');
  }

  const coverSheet = spreadsheet.getSheetByName(COVER_AUTOMATION.coverSheetName);
  if (!coverSheet) return false;
  const coverMatch = coverSheet
    .getRange(2, 1, Math.max(1, coverSheet.getMaxRows() - 1), 1)
    .createTextFinder(catId)
    .matchEntireCell(true)
    .matchCase(true)
    .findNext();
  if (!coverMatch) return false;

  const coverRow = coverMatch.getRow();
  coverSheet.getRange(coverRow, 2).setFormula(
    '=IF(A' + coverRow + '="";"";IFERROR(IMAGE("' + finalUrl + '");"Фото відсутнє"))'
  );
  coverSheet.getRange(coverRow, 3).setValue(finalUrl);
  return true;
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

