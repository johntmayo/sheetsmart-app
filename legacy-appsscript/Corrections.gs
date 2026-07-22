// ============================================================
// Corrections.gs — UI & Entry Points for Sheet Smart
// ============================================================
// Container-bound script inside the "Sheet Smart Config"
// spreadsheet. Provides a compact custom menu that opens the guided
// sidebar dashboard and initializes the config tabs.
//
// Cell-fill operations automatically add any missing target columns
// before filling. Row-append operations never modify or remove
// existing rows. All heavy lifting is in MergeEngine.gs.
// ============================================================

/**
 * Adds the Sheet Smart menu to the spreadsheet menu bar.
 * Runs automatically when the spreadsheet is opened.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Sheet Smart')
    .addItem('Open Dashboard', 'openSheetSmartDashboard')
    .addSeparator()
    .addItem('Set Up Config Tabs', 'setupConfigTabs')
    .addToUi();
}

/**
 * Opens the guided Sheet Smart sidebar for running named workflows.
 */
function openSheetSmartDashboard() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Sheet Smart');
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Returns sidebar-ready workflow summaries.
 *
 * @return {{ workflows: Array }}
 */
function getSheetSmartDashboardModel() {
  var configSs = SpreadsheetApp.getActiveSpreadsheet();
  var presets = readWorkflowPresets_(configSs);
  var workflows = [];

  for (var i = 0; i < presets.length; i++) {
    if (!presets[i].enabled) continue;
    workflows.push(buildWorkflowSidebarModel_(configSs, presets[i], false));
  }

  return { workflows: workflows };
}

/**
 * Returns details and readiness checks for one workflow.
 *
 * @param {string} workflowId
 * @return {Object}
 */
function getWorkflowDetails(workflowId) {
  var configSs = SpreadsheetApp.getActiveSpreadsheet();
  var preset = getWorkflowPreset_(configSs, workflowId);
  if (!preset) throw new Error('Workflow "' + workflowId + '" was not found.');
  return buildWorkflowSidebarModel_(configSs, preset, true);
}

/**
 * Runs a workflow in dry-run mode from the sidebar.
 *
 * @param {string} workflowId
 * @return {Object}
 */
function runWorkflowDryRun(workflowId) {
  return runWorkflowFromSidebar_(workflowId, true);
}

/**
 * Runs a workflow live from the sidebar.
 *
 * @param {string} workflowId
 * @return {Object}
 */
function runWorkflowLive(workflowId) {
  return runWorkflowFromSidebar_(workflowId, false);
}

/**
 * Dispatches a named workflow to the matching backend operation.
 *
 * @param {string} workflowId
 * @param {boolean} dryRun
 * @return {Object}
 */
function runWorkflowFromSidebar_(workflowId, dryRun) {
  var configSs = SpreadsheetApp.getActiveSpreadsheet();
  var preset = getWorkflowPreset_(configSs, workflowId);
  if (!preset) throw new Error('Workflow "' + workflowId + '" was not found.');
  if (!preset.enabled) throw new Error('Workflow "' + preset.name + '" is disabled.');

  var settings = readMergeConfig_(configSs);
  var workflow = buildEffectiveWorkflowConfig_(preset, settings);
  workflow.pullColumnPolicies = resolvePullColumnPoliciesForRun_(configSs, preset.importColumnPolicies);
  var logTab = dryRun ? 'Dry Run - ' + preset.name : 'Last Run - ' + preset.name;
  var result;
  if (workflow.operation === 'import_to_master') {
    result = executeImportToMaster_(configSs, workflow, dryRun, logTab);
  } else if (workflow.operation === 'push_to_folder') {
    result = executePushToFolderWorkflow_(configSs, workflow, dryRun, logTab);
  } else if (workflow.operation === 'push_missing_rows_to_user_sheet') {
    result = executePushMissingRowsToUserSheetWorkflow_(configSs, workflow, dryRun, logTab, dryRun ? 'Dry Run - Flagged Sensitive Data' : 'Flagged - Sensitive Data');
  } else if (workflow.operation === 'push_missing_rows_to_folder') {
    result = executePushMissingRowsToFolderWorkflow_(configSs, workflow, dryRun, logTab, dryRun ? 'Dry Run - Flagged Sensitive Data' : 'Flagged - Sensitive Data');
  } else if (workflow.operation === 'pull_data_from_folder') {
    result = executePullDataFromFolderWorkflow_(configSs, workflow, dryRun, logTab);
  } else if (workflow.operation === 'pull_missing_rows_from_folder') {
    result = executePullMissingRowsFromFolderWorkflow_(configSs, workflow, dryRun, logTab);
  } else if (workflow.operation === 'add_columns_to_user_sheet') {
    result = executeAddColumnsToUserSheetWorkflow_(configSs, workflow, dryRun, logTab);
  } else if (workflow.operation === 'add_columns_to_folder') {
    result = executeAddColumnsToFolderWorkflow_(configSs, workflow, dryRun, logTab);
  } else if (workflow.operation === 'delete_columns_from_user_sheet') {
    result = executeDeleteColumnsFromUserSheetWorkflow_(configSs, workflow, dryRun, logTab);
  } else if (workflow.operation === 'delete_columns_from_folder') {
    result = executeDeleteColumnsFromFolderWorkflow_(configSs, workflow, dryRun, logTab);
  } else if (workflow.operation === 'rename_columns_in_folder') {
    result = executeRenameColumnsInFolderWorkflow_(configSs, workflow, dryRun, logTab);
  } else {
    throw new Error('Workflow operation "' + workflow.operation + '" is not supported by the sidebar yet.');
  }
  result.workflowId = preset.id;
  result.workflowName = preset.name;
  result.mode = dryRun ? 'Dry Run' : 'Live Run';
  return result;
}

/**
 * Builds a compact workflow model for the sidebar. When includeChecks is true,
 * spreadsheet/tab/header checks are performed so the UI can show readiness.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} preset
 * @param {boolean} includeChecks
 * @return {Object}
 */
function buildWorkflowSidebarModel_(configSs, preset, includeChecks) {
  var settings = readMergeConfig_(configSs);
  var workflow = buildEffectiveWorkflowConfig_(preset, settings);
  workflow.pullColumnPolicies = resolvePullColumnPoliciesForRun_(configSs, preset.importColumnPolicies);
  var checks = includeChecks ? validateWorkflow_(workflow) : [];
  var mappings = getWorkflowSidebarMappings_(workflow);
  return {
    id: preset.id,
    name: preset.name,
    operation: workflow.operation,
    sourceTabName: workflow.sourceTabName,
    sourceLabel: getWorkflowSourceLabel_(workflow),
    matchColumn: getWorkflowMatchLabel_(workflow),
    mappingCount: (workflow.operation === 'import_to_master' || workflow.operation === 'push_to_folder' || workflow.operation === 'add_columns_to_user_sheet' || workflow.operation === 'add_columns_to_folder' || workflow.operation === 'delete_columns_from_user_sheet' || workflow.operation === 'delete_columns_from_folder') ? mappings.length : 0,
    mappings: mappings,
    notes: getWorkflowNotes_(workflow),
    checks: checks,
    ready: checks.length === 0 || checks.every(function (check) { return check.status !== 'error'; })
  };
}

/**
 * Routes workflow validation to the operation-specific checker.
 *
 * @param {Object} workflow
 * @return {Array<{status: string, message: string}>}
 */
function validateWorkflow_(workflow) {
  if (workflow.operation === 'import_to_master') return validateImportWorkflow_(workflow);
  if (workflow.operation === 'push_to_folder') return validatePushToFolderWorkflow_(workflow);
  if (workflow.operation === 'push_missing_rows_to_user_sheet') return validatePushMissingRowsToUserSheetWorkflow_(workflow);
  if (workflow.operation === 'push_missing_rows_to_folder') return validatePushMissingRowsToFolderWorkflow_(workflow);
  if (workflow.operation === 'pull_data_from_folder') return validatePullDataFromFolderWorkflow_(workflow);
  if (workflow.operation === 'pull_missing_rows_from_folder') return validatePullMissingRowsFromFolderWorkflow_(workflow);
  if (workflow.operation === 'add_columns_to_user_sheet') return validateAddColumnsToUserSheetWorkflow_(workflow);
  if (workflow.operation === 'add_columns_to_folder') return validateAddColumnsToFolderWorkflow_(workflow);
  if (workflow.operation === 'delete_columns_from_user_sheet') return validateDeleteColumnsFromUserSheetWorkflow_(workflow);
  if (workflow.operation === 'delete_columns_from_folder') return validateDeleteColumnsFromFolderWorkflow_(workflow);
  if (workflow.operation === 'rename_columns_in_folder') return validateRenameColumnsInFolderWorkflow_(workflow);
  return [{ status: 'error', message: 'Unsupported workflow operation: ' + workflow.operation }];
}

/**
 * Combines workflow preset values with Settings tab fallbacks used by
 * folder-wide sidebar wrappers.
 *
 * @param {Object} preset
 * @param {Object} settings
 * @return {Object}
 */
function buildEffectiveWorkflowConfig_(preset, settings) {
  settings = settings || {};
  return {
    id: preset.id,
    name: preset.name,
    operation: preset.operation,
    enabled: preset.enabled,
    sourceId: preset.sourceId || settings.sourceId || '',
    sourceTabName: preset.sourceTabName || settings.sourceTabName || '',
    masterId: preset.masterId || settings.masterId || '',
    userSheetId: preset.userSheetId || settings.userSheetId || '',
    folderId: preset.folderId || settings.folderId || '',
    matchColumn: preset.matchColumn || settings.matchColumn || '',
    renameFrom: settings.renameFrom || '',
    renameTo: settings.renameTo || '',
    columnMap: preset.columnMap || [],
    importColumnPolicies: preset.importColumnPolicies || {},
    sensitiveColumns: settings.sensitiveColumns || [],
    pullColumnPolicies: mergeWorkflowPullPolicies_(settings.pullColumnPolicies, preset.importColumnPolicies),
    notes: preset.notes || ''
  };
}

/**
 * Combines tab/preset pull policies without re-reading the config spreadsheet.
 *
 * @param {Object=} tabPolicies
 * @param {Object=} presetPolicies
 * @return {Object}
 */
function mergeWorkflowPullPolicies_(tabPolicies, presetPolicies) {
  var merged = {};
  tabPolicies = tabPolicies || {};
  presetPolicies = presetPolicies || {};

  for (var presetKey in presetPolicies) {
    if (Object.prototype.hasOwnProperty.call(presetPolicies, presetKey)) {
      merged[presetKey] = presetPolicies[presetKey];
    }
  }
  for (var tabKey in tabPolicies) {
    if (Object.prototype.hasOwnProperty.call(tabPolicies, tabKey)) {
      merged[tabKey] = tabPolicies[tabKey];
    }
  }
  merged.resident_id = 'never';
  return merged;
}

/**
 * Returns a short source label for the sidebar details panel.
 *
 * @param {Object} workflow
 * @return {string}
 */
function getWorkflowSourceLabel_(workflow) {
  if (workflow.operation === 'push_missing_rows_to_user_sheet') {
    return 'Master spreadsheet -> one captain sheet';
  }
  if (workflow.operation === 'push_to_folder' || workflow.operation === 'push_missing_rows_to_folder') {
    return 'Master spreadsheet -> captain sheets folder';
  }
  if (workflow.operation === 'pull_data_from_folder' || workflow.operation === 'pull_missing_rows_from_folder') {
    return 'Captain sheets folder -> master spreadsheet';
  }
  if (workflow.operation === 'add_columns_to_user_sheet') {
    return 'Configured headers -> one captain sheet';
  }
  if (workflow.operation === 'add_columns_to_folder') {
    return 'Configured headers -> captain sheets folder';
  }
  if (workflow.operation === 'delete_columns_from_user_sheet') {
    return 'Configured headers -> one captain sheet';
  }
  if (workflow.operation === 'delete_columns_from_folder') {
    return 'Configured headers -> captain sheets folder';
  }
  if (workflow.operation === 'rename_columns_in_folder') {
    return 'Captain sheets folder headers';
  }
  return workflow.sourceTabName || '(first tab)';
}

/**
 * Returns the match/identity label shown in the sidebar.
 *
 * @param {Object} workflow
 * @return {string}
 */
function getWorkflowMatchLabel_(workflow) {
  if (workflow.operation === 'push_missing_rows_to_user_sheet' || workflow.operation === 'push_missing_rows_to_folder' || workflow.operation === 'pull_data_from_folder' || workflow.operation === 'pull_missing_rows_from_folder') {
    return 'resident_id';
  }
  if (workflow.operation === 'add_columns_to_user_sheet' || workflow.operation === 'add_columns_to_folder' || workflow.operation === 'delete_columns_from_user_sheet' || workflow.operation === 'delete_columns_from_folder') {
    return 'Header names only';
  }
  if (workflow.operation === 'rename_columns_in_folder') {
    return workflow.renameFrom && workflow.renameTo ? workflow.renameFrom + ' -> ' + workflow.renameTo : '(set Rename Column fields)';
  }
  return workflow.matchColumn;
}

/**
 * Returns sidebar rows for mappings/policies or operation-specific behavior.
 *
 * @param {Object} workflow
 * @return {Array<{source: string, target: string, policy: string}>}
 */
function getWorkflowSidebarMappings_(workflow) {
  if (workflow.operation === 'pull_data_from_folder') {
    return getPullPolicySummaryRows_(workflow.pullColumnPolicies);
  }
  if (workflow.operation === 'push_missing_rows_to_user_sheet' || workflow.operation === 'push_missing_rows_to_folder') {
    return [{ source: 'Master rows by ZoneName', target: 'Captain sheet rows', policy: 'append only; never edits existing rows' }];
  }
  if (workflow.operation === 'pull_missing_rows_from_folder') {
    return [{ source: 'Captain rows missing from master', target: 'Master rows', policy: 'append only; source-only headers are added first' }];
  }
  if (workflow.operation === 'add_columns_to_user_sheet' || workflow.operation === 'add_columns_to_folder') {
    return workflow.columnMap.map(function (mapping) {
      var columnName = mapping.target || mapping.source;
      return {
        source: columnName,
        target: columnName,
        policy: 'add if missing; existing columns unchanged'
      };
    });
  }
  if (workflow.operation === 'delete_columns_from_user_sheet' || workflow.operation === 'delete_columns_from_folder') {
    return workflow.columnMap.map(function (mapping) {
      var columnName = mapping.target || mapping.source;
      return {
        source: columnName,
        target: columnName,
        policy: 'delete entire column, including existing data'
      };
    });
  }
  if (workflow.operation === 'rename_columns_in_folder') {
    return [{ source: workflow.renameFrom || '(Rename Column - From)', target: workflow.renameTo || '(Rename Column - To)', policy: 'header row only; dry run strongly recommended' }];
  }
  return workflow.columnMap.map(function (mapping) {
    return {
      source: mapping.source,
      target: mapping.target,
      policy: workflow.importColumnPolicies[mapping.target] || workflow.importColumnPolicies[mapping.source] || 'fill_blank'
    };
  });
}

/**
 * @param {Object} policies
 * @return {Array<{source: string, target: string, policy: string}>}
 */
function getPullPolicySummaryRows_(policies) {
  var rows = [];
  var keys = Object.keys(policies || {}).sort();
  for (var i = 0; i < keys.length; i++) {
    rows.push({ source: keys[i], target: 'Master', policy: policies[keys[i]] });
  }
  rows.push({ source: 'Unlisted captain columns', target: 'Master', policy: 'conflict by default' });
  return rows;
}

/**
 * @param {Object} workflow
 * @return {string}
 */
function getWorkflowNotes_(workflow) {
  if (workflow.operation === 'rename_columns_in_folder') {
    return (workflow.notes ? workflow.notes + ' ' : '') +
      'Dry Run only previews header changes. Live Run changes row 1 across every captain sheet in the folder.';
  }
  if (workflow.operation === 'push_missing_rows_to_user_sheet') {
    return (workflow.notes ? workflow.notes + ' ' : '') +
      'This workflow only appends new resident rows to the configured User Sheet; existing captain rows are not modified or removed.';
  }
  if (workflow.operation === 'push_missing_rows_to_folder') {
    return (workflow.notes ? workflow.notes + ' ' : '') +
      'This workflow only appends new resident rows; existing captain rows are not modified or removed.';
  }
  if (workflow.operation === 'pull_missing_rows_from_folder') {
    return (workflow.notes ? workflow.notes + ' ' : '') +
      'This workflow only appends new master rows and adds source-only headers; existing master rows are not modified.';
  }
  if (workflow.operation === 'pull_data_from_folder') {
    return (workflow.notes ? workflow.notes + ' ' : '') +
      'Existing master values follow Pull Column Policy. Unlisted columns log conflicts; resident_id is never changed.';
  }
  if (workflow.operation === 'add_columns_to_user_sheet' || workflow.operation === 'add_columns_to_folder') {
    return (workflow.notes ? workflow.notes + ' ' : '') +
      'This workflow only appends missing row-1 headers. It does not fill cells, rename headers, append rows, or reorder columns.';
  }
  if (workflow.operation === 'delete_columns_from_user_sheet' || workflow.operation === 'delete_columns_from_folder') {
    return (workflow.notes ? workflow.notes + ' ' : '') +
      'Dry Run previews matching headers and counts non-blank data cells. Live Run deletes the entire column, including all data in that column.';
  }
  return workflow.notes;
}

/**
 * Validates the sidebar import workflow before it runs.
 *
 * @param {Object} preset
 * @return {Array<{status: string, message: string}>}
 */
function validateImportWorkflow_(preset) {
  var checks = [];

  if (!preset.sourceId) checks.push({ status: 'error', message: 'Source spreadsheet is not set.' });
  if (!preset.masterId) checks.push({ status: 'error', message: 'Master spreadsheet is not set.' });
  if (!preset.matchColumn) checks.push({ status: 'error', message: 'Match column is not set.' });
  if (preset.columnMap.length === 0) checks.push({ status: 'error', message: 'No column mappings are configured.' });
  if (checks.length > 0) return checks;

  try {
    var sourceSs = SpreadsheetApp.openById(preset.sourceId);
    var sourceSheet = getConfiguredSheet_(sourceSs, preset.sourceTabName);
    var sourceData = sourceSheet.getDataRange().getValues();
    var sourceHeaders = sourceData.length > 0 ? sourceData[0].map(function (h) { return String(h).trim(); }) : [];
    var sourceColumns = preset.columnMap.map(function (m) { return m.source; });
    sourceColumns.push(preset.matchColumn);
    var missingSource = findMissingHeaders_(sourceHeaders, sourceColumns);

    checks.push({ status: 'ok', message: 'Source tab found: ' + sourceSheet.getName() + ' (' + Math.max(sourceData.length - 1, 0) + ' data rows).' });
    if (missingSource.length > 0) {
      checks.push({ status: 'error', message: 'Source is missing: ' + missingSource.join(', ') + '.' });
    } else {
      checks.push({ status: 'ok', message: 'Source has the match column and mapped columns.' });
    }
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }

  try {
    var masterSs = SpreadsheetApp.openById(preset.masterId);
    var masterSheet = masterSs.getSheets()[0];
    var masterData = masterSheet.getDataRange().getValues();
    var masterHeaders = masterData.length > 0 ? masterData[0].map(function (h) { return String(h).trim(); }) : [];
    var missingMasterMatch = findMissingHeaders_(masterHeaders, [preset.matchColumn]);
    var targetColumns = preset.columnMap.map(function (m) { return m.target; });
    var missingTargets = findMissingHeaders_(masterHeaders, targetColumns);

    checks.push({ status: 'ok', message: 'Master found: ' + masterSs.getName() + ' (' + Math.max(masterData.length - 1, 0) + ' data rows).' });
    if (missingMasterMatch.length > 0) {
      checks.push({ status: 'error', message: 'Master is missing match column: ' + preset.matchColumn + '.' });
    }
    if (missingTargets.length > 0) {
      checks.push({ status: 'warning', message: 'These target columns will be added if you run live: ' + missingTargets.join(', ') + '.' });
    } else {
      checks.push({ status: 'ok', message: 'Master already has all mapped target columns.' });
    }
  } catch (e2) {
    checks.push({ status: 'error', message: e2.message });
  }

  return checks;
}

/**
 * Validates the sidebar Master -> folder push workflow before it runs.
 *
 * @param {Object} preset
 * @return {Array<{status: string, message: string}>}
 */
function validatePushToFolderWorkflow_(preset) {
  var checks = [];

  if (!preset.masterId) checks.push({ status: 'error', message: 'Master spreadsheet is not set.' });
  if (!preset.folderId) checks.push({ status: 'error', message: 'User sheets folder is not set.' });
  if (!preset.matchColumn) checks.push({ status: 'error', message: 'Match column is not set.' });
  if (preset.columnMap.length === 0) checks.push({ status: 'error', message: 'No column mappings are configured.' });
  if (checks.length > 0) return checks;

  var sourceColumns = preset.columnMap.map(function (m) { return m.source; });
  sourceColumns.push(preset.matchColumn);

  try {
    var masterSs = SpreadsheetApp.openById(preset.masterId);
    var masterSheet = masterSs.getSheets()[0];
    var masterData = masterSheet.getDataRange().getValues();
    var masterHeaders = masterData.length > 0 ? masterData[0].map(function (h) { return String(h).trim(); }) : [];
    var missingMaster = findMissingHeaders_(masterHeaders, sourceColumns);

    checks.push({ status: 'ok', message: 'Master found: ' + masterSs.getName() + ' (' + Math.max(masterData.length - 1, 0) + ' data rows).' });
    if (missingMaster.length > 0) {
      checks.push({ status: 'error', message: 'Master is missing: ' + missingMaster.join(', ') + '.' });
    } else {
      checks.push({ status: 'ok', message: 'Master has the match column and mapped source columns.' });
    }
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }

  try {
    var folder = DriveApp.getFolderById(preset.folderId);
    var iter = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
    var files = [];
    while (iter.hasNext()) files.push(iter.next());
    files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

    checks.push({ status: files.length > 0 ? 'ok' : 'warning', message: 'Folder found with ' + files.length + ' Google Sheets.' });
    if (files.length === 0) return checks;

    var targetColumns = preset.columnMap.map(function (m) { return m.target; });
    var missingMatchSheets = [];
    var sheetsMissingTargets = 0;
    for (var i = 0; i < files.length; i++) {
      var ss = SpreadsheetApp.openById(files[i].getId());
      var sheet = ss.getSheets()[0];
      var data = sheet.getDataRange().getValues();
      var headers = data.length > 0 ? data[0].map(function (h) { return String(h).trim(); }) : [];

      if (headers.indexOf(preset.matchColumn) === -1) {
        missingMatchSheets.push(files[i].getName());
      }
      if (findMissingHeaders_(headers, targetColumns).length > 0) {
        sheetsMissingTargets++;
      }
    }

    if (missingMatchSheets.length > 0) {
      checks.push({ status: 'error', message: missingMatchSheets.length + ' sheet(s) are missing match column ' + preset.matchColumn + '. First: ' + missingMatchSheets[0] + '.' });
    } else {
      checks.push({ status: 'ok', message: 'All folder sheets have the match column.' });
    }
    if (sheetsMissingTargets > 0) {
      checks.push({ status: 'warning', message: sheetsMissingTargets + ' sheet(s) are missing one or more target columns; live run will add them.' });
    } else {
      checks.push({ status: 'ok', message: 'All folder sheets already have the mapped target columns.' });
    }
  } catch (e2) {
    checks.push({ status: 'error', message: e2.message });
  }

  return checks;
}

/**
 * Validates the sidebar append-missing-residents folder workflow.
 *
 * @param {Object} workflow
 * @return {Array<{status: string, message: string}>}
 */
function validatePushMissingRowsToFolderWorkflow_(workflow) {
  var checks = [];
  if (!workflow.masterId) checks.push({ status: 'error', message: 'Master spreadsheet is not set.' });
  if (!workflow.folderId) checks.push({ status: 'error', message: 'User sheets folder is not set.' });
  if (checks.length > 0) return checks;

  try {
    var masterSs = SpreadsheetApp.openById(workflow.masterId);
    var masterSheet = masterSs.getSheets()[0];
    var masterData = masterSheet.getDataRange().getValues();
    var masterHeaders = masterData.length > 0 ? masterData[0].map(function (h) { return String(h).trim(); }) : [];
    var missingMaster = findMissingHeaders_(masterHeaders, ['resident_id', 'ZoneName']);
    checks.push({ status: 'ok', message: 'Master found: ' + masterSs.getName() + ' (' + Math.max(masterData.length - 1, 0) + ' data rows).' });
    if (missingMaster.length > 0) {
      checks.push({ status: 'error', message: 'Master is missing: ' + missingMaster.join(', ') + '.' });
    } else {
      checks.push({ status: 'ok', message: 'Master has resident_id and ZoneName.' });
    }

    if (workflow.sensitiveColumns.length > 0) {
      var missingSensitive = findMissingHeaders_(masterHeaders, workflow.sensitiveColumns);
      if (missingSensitive.length > 0) {
        checks.push({ status: 'warning', message: 'Configured sensitive columns not found in master and cannot be flagged: ' + missingSensitive.join(', ') + '.' });
      } else {
        checks.push({ status: 'ok', message: 'Sensitive columns are configured and present in master.' });
      }
    } else {
      checks.push({ status: 'warning', message: 'No Sensitive Columns are configured; appended rows will not be privacy-flagged.' });
    }
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }

  var folderCheck = validateFolderSheets_(workflow.folderId, ['resident_id', 'ZoneName'], true);
  return checks.concat(folderCheck);
}

/**
 * Validates the sidebar append-missing-residents single-sheet workflow.
 *
 * @param {Object} workflow
 * @return {Array<{status: string, message: string}>}
 */
function validatePushMissingRowsToUserSheetWorkflow_(workflow) {
  var checks = [];
  if (!workflow.masterId) checks.push({ status: 'error', message: 'Master spreadsheet is not set.' });
  if (!workflow.userSheetId) checks.push({ status: 'error', message: 'User Sheet is not set.' });
  if (checks.length > 0) return checks;

  try {
    var masterSs = SpreadsheetApp.openById(workflow.masterId);
    var masterSheet = masterSs.getSheets()[0];
    var masterData = masterSheet.getDataRange().getValues();
    var masterHeaders = masterData.length > 0 ? masterData[0].map(function (h) { return String(h).trim(); }) : [];
    var missingMaster = findMissingHeaders_(masterHeaders, ['resident_id', 'ZoneName']);
    checks.push({ status: 'ok', message: 'Master found: ' + masterSs.getName() + ' (' + Math.max(masterData.length - 1, 0) + ' data rows).' });
    if (missingMaster.length > 0) {
      checks.push({ status: 'error', message: 'Master is missing: ' + missingMaster.join(', ') + '.' });
    } else {
      checks.push({ status: 'ok', message: 'Master has resident_id and ZoneName.' });
    }

    if (workflow.sensitiveColumns.length > 0) {
      var missingSensitive = findMissingHeaders_(masterHeaders, workflow.sensitiveColumns);
      if (missingSensitive.length > 0) {
        checks.push({ status: 'warning', message: 'Configured sensitive columns not found in master and cannot be flagged: ' + missingSensitive.join(', ') + '.' });
      } else {
        checks.push({ status: 'ok', message: 'Sensitive columns are configured and present in master.' });
      }
    } else {
      checks.push({ status: 'warning', message: 'No Sensitive Columns are configured; appended rows will not be privacy-flagged.' });
    }
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }

  return checks.concat(validateUserSheet_(workflow.userSheetId, ['resident_id', 'ZoneName'], true));
}

/**
 * Validates the sidebar Pull Data folder workflow.
 *
 * @param {Object} workflow
 * @return {Array<{status: string, message: string}>}
 */
function validatePullDataFromFolderWorkflow_(workflow) {
  var checks = validateMasterResidentId_(workflow.masterId);
  checks = checks.concat(validateFolderSheets_(workflow.folderId, ['resident_id'], false));

  var policies = workflow.pullColumnPolicies || {};
  var policyKeys = Object.keys(policies).filter(function (key) { return key !== 'resident_id'; });
  checks.push({
    status: policyKeys.length > 0 ? 'ok' : 'error',
    message: policyKeys.length > 0
      ? 'Pull Column Policy has ' + policyKeys.length + ' editable column policy row(s). Unlisted columns default to conflict; resident_id is always never.'
      : 'Pull Column Policy has 0 editable rows loaded. Open the "Pull Column Policy" tab and add Column Name / Policy rows, then run debugPullColumnPolicies() from Apps Script to verify loading.'
  });
  return checks;
}

/**
 * Validates the sidebar Pull Missing Rows folder workflow.
 *
 * @param {Object} workflow
 * @return {Array<{status: string, message: string}>}
 */
function validatePullMissingRowsFromFolderWorkflow_(workflow) {
  return validateMasterResidentId_(workflow.masterId)
    .concat(validateFolderSheets_(workflow.folderId, ['resident_id'], false));
}

/**
 * Validates the sidebar Add Columns single-sheet workflow.
 *
 * @param {Object} workflow
 * @return {Array<{status: string, message: string}>}
 */
function validateAddColumnsToUserSheetWorkflow_(workflow) {
  var checks = [];
  var columnNames = getAddColumnNamesFromWorkflow_(workflow);
  if (!workflow.userSheetId) checks.push({ status: 'error', message: 'User Sheet is not set.' });
  if (columnNames.length === 0) checks.push({ status: 'error', message: 'No columns are configured to add.' });
  if (checks.length > 0) return checks;

  try {
    var ss = SpreadsheetApp.openById(workflow.userSheetId);
    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    var headers = data.length > 0 ? data[0].map(function (h) { return String(h).trim(); }) : [];
    var missing = findMissingHeaders_(headers, columnNames);
    checks.push({ status: 'ok', message: 'User sheet found: ' + ss.getName() + '.' });
    checks.push({
      status: missing.length > 0 ? 'warning' : 'ok',
      message: missing.length > 0
        ? 'Live run will add: ' + missing.join(', ') + '.'
        : 'The user sheet already has all configured columns.'
    });
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }

  return checks;
}

/**
 * Validates the sidebar Add Columns folder workflow.
 *
 * @param {Object} workflow
 * @return {Array<{status: string, message: string}>}
 */
function validateAddColumnsToFolderWorkflow_(workflow) {
  var checks = [];
  var columnNames = getAddColumnNamesFromWorkflow_(workflow);
  if (!workflow.folderId) checks.push({ status: 'error', message: 'User Sheets Folder is not set.' });
  if (columnNames.length === 0) checks.push({ status: 'error', message: 'No columns are configured to add.' });
  if (checks.length > 0) return checks;

  try {
    var files = getGoogleSheetFilesInFolder_(workflow.folderId);
    var sheetsMissingColumns = 0;
    for (var i = 0; i < files.length; i++) {
      var ss = SpreadsheetApp.openById(files[i].getId());
      var data = ss.getSheets()[0].getDataRange().getValues();
      var headers = data.length > 0 ? data[0].map(function (h) { return String(h).trim(); }) : [];
      if (findMissingHeaders_(headers, columnNames).length > 0) sheetsMissingColumns++;
    }

    checks.push({ status: files.length > 0 ? 'ok' : 'warning', message: 'Folder found with ' + files.length + ' Google Sheets.' });
    checks.push({
      status: sheetsMissingColumns > 0 ? 'warning' : 'ok',
      message: sheetsMissingColumns > 0
        ? sheetsMissingColumns + ' sheet(s) are missing one or more configured columns; live run will add them.'
        : 'All folder sheets already have the configured columns.'
    });
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }

  return checks;
}

/**
 * Validates the sidebar Delete Columns single-sheet workflow.
 *
 * @param {Object} workflow
 * @return {Array<{status: string, message: string}>}
 */
function validateDeleteColumnsFromUserSheetWorkflow_(workflow) {
  var checks = [];
  var columnNames = getSchemaColumnNamesFromWorkflow_(workflow);
  if (!workflow.userSheetId) checks.push({ status: 'error', message: 'User Sheet is not set.' });
  if (columnNames.length === 0) checks.push({ status: 'error', message: 'No columns are configured to delete.' });
  if (checks.length > 0) return checks;

  try {
    var ss = SpreadsheetApp.openById(workflow.userSheetId);
    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    var headers = data.length > 0 ? data[0].map(function (h) { return String(h).trim(); }) : [];
    var found = countPresentHeaders_(headers, columnNames);
    checks.push({ status: 'ok', message: 'User sheet found: ' + ss.getName() + '.' });
    checks.push({
      status: found > 0 ? 'warning' : 'ok',
      message: found > 0
        ? 'Live run will delete ' + found + ' configured column(s), including their data.'
        : 'None of the configured columns are present in this user sheet.'
    });
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }

  return checks;
}

/**
 * Validates the sidebar Delete Columns folder workflow.
 *
 * @param {Object} workflow
 * @return {Array<{status: string, message: string}>}
 */
function validateDeleteColumnsFromFolderWorkflow_(workflow) {
  var checks = [];
  var columnNames = getSchemaColumnNamesFromWorkflow_(workflow);
  if (!workflow.folderId) checks.push({ status: 'error', message: 'User Sheets Folder is not set.' });
  if (columnNames.length === 0) checks.push({ status: 'error', message: 'No columns are configured to delete.' });
  if (checks.length > 0) return checks;

  try {
    var files = getGoogleSheetFilesInFolder_(workflow.folderId);
    var sheetsWithColumns = 0;
    var totalMatches = 0;
    for (var i = 0; i < files.length; i++) {
      var ss = SpreadsheetApp.openById(files[i].getId());
      var data = ss.getSheets()[0].getDataRange().getValues();
      var headers = data.length > 0 ? data[0].map(function (h) { return String(h).trim(); }) : [];
      var found = countPresentHeaders_(headers, columnNames);
      if (found > 0) {
        sheetsWithColumns++;
        totalMatches += found;
      }
    }

    checks.push({ status: files.length > 0 ? 'ok' : 'warning', message: 'Folder found with ' + files.length + ' Google Sheets.' });
    checks.push({
      status: totalMatches > 0 ? 'warning' : 'ok',
      message: totalMatches > 0
        ? 'Live run will delete ' + totalMatches + ' configured column(s) across ' + sheetsWithColumns + ' sheet(s), including their data.'
        : 'None of the configured columns are present in the folder sheets.'
    });
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }

  return checks;
}

/**
 * Validates the sidebar Rename Columns folder workflow.
 *
 * @param {Object} workflow
 * @return {Array<{status: string, message: string}>}
 */
function validateRenameColumnsInFolderWorkflow_(workflow) {
  var checks = [];
  if (!workflow.folderId) checks.push({ status: 'error', message: 'User sheets folder is not set.' });
  if (!workflow.renameFrom) checks.push({ status: 'error', message: 'Rename Column - From is not set in Settings.' });
  if (!workflow.renameTo) checks.push({ status: 'error', message: 'Rename Column - To is not set in Settings.' });
  if (workflow.renameFrom && workflow.renameTo && workflow.renameFrom === workflow.renameTo) {
    checks.push({ status: 'error', message: 'Rename Column - From and Rename Column - To are identical.' });
  }
  if (checks.length > 0) return checks;

  try {
    var files = getGoogleSheetFilesInFolder_(workflow.folderId);
    checks.push({ status: files.length > 0 ? 'ok' : 'warning', message: 'Folder found with ' + files.length + ' Google Sheets.' });
    checks.push({ status: 'warning', message: 'Dry Run is the review step: live run changes row-1 headers across every sheet where the old header is found.' });
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }
  return checks;
}

/**
 * Returns the unique target header names configured for an Add Columns workflow.
 *
 * @param {Object} workflow
 * @return {Array<string>}
 */
function getAddColumnNamesFromWorkflow_(workflow) {
  return getSchemaColumnNamesFromWorkflow_(workflow);
}

/**
 * Returns the unique header names configured for schema-only workflows.
 *
 * @param {Object} workflow
 * @return {Array<string>}
 */
function getSchemaColumnNamesFromWorkflow_(workflow) {
  var names = [];
  var seen = {};
  var mappings = workflow.columnMap || [];
  for (var i = 0; i < mappings.length; i++) {
    var name = String(mappings[i].target || mappings[i].source || '').trim();
    if (name === '' || seen[name]) continue;
    names.push(name);
    seen[name] = true;
  }
  return names;
}

/**
 * Counts how many configured headers are present in a header row.
 *
 * @param {Array<string>} headers
 * @param {Array<string>} columnNames
 * @return {number}
 */
function countPresentHeaders_(headers, columnNames) {
  var count = 0;
  for (var i = 0; i < columnNames.length; i++) {
    if (headers.indexOf(columnNames[i]) !== -1) count++;
  }
  return count;
}

/**
 * @param {string} masterId
 * @return {Array<{status: string, message: string}>}
 */
function validateMasterResidentId_(masterId) {
  var checks = [];
  if (!masterId) return [{ status: 'error', message: 'Master spreadsheet is not set.' }];
  try {
    var masterSs = SpreadsheetApp.openById(masterId);
    var masterData = masterSs.getSheets()[0].getDataRange().getValues();
    var masterHeaders = masterData.length > 0 ? masterData[0].map(function (h) { return String(h).trim(); }) : [];
    checks.push({ status: 'ok', message: 'Master found: ' + masterSs.getName() + ' (' + Math.max(masterData.length - 1, 0) + ' data rows).' });
    if (masterHeaders.indexOf('resident_id') === -1) {
      checks.push({ status: 'error', message: 'Master is missing resident_id.' });
    } else {
      checks.push({ status: 'ok', message: 'Master has resident_id.' });
    }
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }
  return checks;
}

/**
 * @param {string} folderId
 * @param {Array<string>} requiredHeaders
 * @param {boolean} includeZones
 * @return {Array<{status: string, message: string}>}
 */
function validateFolderSheets_(folderId, requiredHeaders, includeZones) {
  var checks = [];
  if (!folderId) return [{ status: 'error', message: 'User sheets folder is not set.' }];
  try {
    var files = getGoogleSheetFilesInFolder_(folderId);
    checks.push({ status: files.length > 0 ? 'ok' : 'warning', message: 'Folder found with ' + files.length + ' Google Sheets.' });
    if (files.length === 0) return checks;

    var missingSheets = [];
    var zones = [];
    for (var i = 0; i < files.length; i++) {
      var ss = SpreadsheetApp.openById(files[i].getId());
      var sheet = ss.getSheets()[0];
      var data = sheet.getDataRange().getValues();
      var headers = data.length > 0 ? data[0].map(function (h) { return String(h).trim(); }) : [];
      var missing = findMissingHeaders_(headers, requiredHeaders);
      if (missing.length > 0) {
        missingSheets.push(files[i].getName() + ' missing ' + missing.join(', '));
      }
      if (includeZones && headers.indexOf('ZoneName') !== -1) {
        zones.push(files[i].getName() + ': ' + (detectZoneFromData_(data, headers) || '(no zone detected)'));
      }
    }

    if (missingSheets.length > 0) {
      checks.push({ status: 'error', message: missingSheets.length + ' sheet(s) are missing required headers. First: ' + missingSheets[0] + '.' });
    } else {
      checks.push({ status: 'ok', message: 'All folder sheets have required headers: ' + requiredHeaders.join(', ') + '.' });
    }
    if (includeZones && zones.length > 0) {
      checks.push({ status: 'ok', message: 'Detected zones: ' + zones.slice(0, 8).join('; ') + (zones.length > 8 ? '; ...' : '') });
    }
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }
  return checks;
}

/**
 * @param {string} userSheetId
 * @param {Array<string>} requiredHeaders
 * @param {boolean} includeZone
 * @return {Array<{status: string, message: string}>}
 */
function validateUserSheet_(userSheetId, requiredHeaders, includeZone) {
  var checks = [];
  if (!userSheetId) return [{ status: 'error', message: 'User Sheet is not set.' }];
  try {
    var ss = SpreadsheetApp.openById(userSheetId);
    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    var headers = data.length > 0 ? data[0].map(function (h) { return String(h).trim(); }) : [];
    var missing = findMissingHeaders_(headers, requiredHeaders);

    checks.push({ status: 'ok', message: 'User sheet found: ' + ss.getName() + ' (' + Math.max(data.length - 1, 0) + ' data rows).' });
    if (missing.length > 0) {
      checks.push({ status: 'error', message: 'User sheet is missing required headers: ' + missing.join(', ') + '.' });
    } else {
      checks.push({ status: 'ok', message: 'User sheet has required headers: ' + requiredHeaders.join(', ') + '.' });
    }
    if (includeZone && headers.indexOf('ZoneName') !== -1) {
      checks.push({ status: 'ok', message: 'Detected zone: ' + (detectZoneFromData_(data, headers) || '(no zone detected)') + '.' });
    }
  } catch (e) {
    checks.push({ status: 'error', message: e.message });
  }
  return checks;
}

/**
 * @param {Array<Array>} data
 * @param {Array<string>} headers
 * @return {string}
 */
function detectZoneFromData_(data, headers) {
  var zoneCol = headers.indexOf('ZoneName');
  if (zoneCol === -1) return '';
  var counts = {};
  for (var r = 1; r < data.length; r++) {
    var zone = String(data[r][zoneCol] || '').trim();
    if (zone !== '') counts[zone] = (counts[zone] || 0) + 1;
  }
  var detected = '';
  var max = 0;
  Object.keys(counts).forEach(function (zone) {
    if (counts[zone] > max) {
      detected = zone;
      max = counts[zone];
    }
  });
  return detected;
}

/**
 * @param {string} folderId
 * @return {Array<GoogleAppsScript.Drive.File>}
 */
function getGoogleSheetFilesInFolder_(folderId) {
  var folder = DriveApp.getFolderById(folderId);
  var iter = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  var files = [];
  while (iter.hasNext()) files.push(iter.next());
  files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });
  return files;
}

// -------  Import → Master  -------
//
// Reads data FROM the External Source spreadsheet and writes it
// INTO the Master. Use this when new data has arrived from an
// outside source (e.g. a sales feed, a contractor's sheet) and
// you want to bring it into the master.

function importToMaster()        { runImport_(false); }
function importToMasterDryRun()  { runImport_(true);  }

function runImport_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  try {
    var configSs = SpreadsheetApp.getActiveSpreadsheet();
    var config   = readMergeConfig_(configSs);

    if (!config.sourceId)    throw new Error('External Source is not set in the Settings tab.');
    if (!config.masterId)    throw new Error('Master Spreadsheet is not set in the Settings tab.');
    if (!config.matchColumn) throw new Error('Match Column is not set in the Settings tab.');
    if (config.columnMap.length === 0) throw new Error(
      'Column Mapping tab has no valid rows. Add at least one Source Column → Target Column pair.'
    );

    var logTab = dryRun ? 'Dry Run - Import' : 'Last Import';
    var summary = executeImportToMaster_(configSs, config, dryRun, logTab);

    var prefix = dryRun ? 'DRY RUN — Import → Master\n\n' : 'Import → Master complete.\n\n';
    ui.alert(
      prefix +
      'Source tab: '                  + summary.sourceTab + '\n' +
      'Columns added: '               + summary.columnsAdded + '\n' +
      'Cells filled: '                + summary.cellsFilled + '\n' +
      'Cells overwritten: '           + summary.cellsOverwritten + '\n' +
      'Conflicts (not overwritten): ' + summary.conflicts + '\n' +
      'Skipped: '                     + summary.skipped + '\n' +
      'Source rows not in master: '   + summary.unmatchedSourceRows + '\n' +
      'Errors: '                      + summary.errors + '\n\n' +
      'See the "' + logTab + '" tab for details.'
    );
  } catch (e) {
    ui.alert('Import → Master failed:\n\n' + e.message);
  }
}

/**
 * Shared Import -> Master implementation used by both the legacy menu and
 * the sidebar workflows.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} logTab
 * @return {Object}
 */
function executeImportToMaster_(configSs, config, dryRun, logTab) {
  var sourceSs     = SpreadsheetApp.openById(config.sourceId);
  var sourceSheet  = getConfiguredSheet_(sourceSs, config.sourceTabName);
  var sourceData   = sourceSheet.getDataRange().getValues();
  if (sourceData.length === 0) throw new Error('Source tab "' + sourceSheet.getName() + '" is empty.');
  var sourceHdrs   = sourceData[0].map(function (h) { return String(h).trim(); });
  var sourceLookup = buildSourceLookup_(sourceData, sourceHdrs, config.matchColumn);

  var masterSs    = SpreadsheetApp.openById(config.masterId);
  var masterSheet = masterSs.getSheets()[0];

  var targetCols  = config.columnMap.map(function (m) { return m.target; });
  var addResult   = addColumnsToTarget_(masterSheet, targetCols, dryRun);
  var virtualCols = addResult.added.map(function (a) { return a.column; });
  var hasImportPolicies = config.importColumnPolicies && Object.keys(config.importColumnPolicies).length > 0;
  var mergeResult = hasImportPolicies
    ? mergeIntoTargetWithPolicies_(masterSheet, sourceLookup, config.matchColumn, config.columnMap, config.importColumnPolicies, dryRun, virtualCols, true)
    : mergeIntoTarget_(masterSheet, sourceLookup, config.matchColumn, config.columnMap, dryRun, virtualCols, true);

  var old = configSs.getSheetByName(logTab);
  if (old) configSs.deleteSheet(old);
  appendToSyncLog_(configSs, logTab, masterSs.getName(), addResult, mergeResult);

  return {
    sourceSpreadsheet: sourceSs.getName(),
    sourceTab: sourceSheet.getName(),
    targetSpreadsheet: masterSs.getName(),
    logTab: logTab,
    columnsAdded: addResult.added.length,
    cellsFilled: mergeResult.filled.length,
    cellsOverwritten: mergeResult.overwritten ? mergeResult.overwritten.length : 0,
    conflicts: mergeResult.conflicts.length,
    skipped: mergeResult.skipped ? mergeResult.skipped.length : 0,
    unmatchedSourceRows: mergeResult.unmatchedSourceRows ? mergeResult.unmatchedSourceRows.length : 0,
    errors: addResult.errors.length + mergeResult.errors.length,
    metrics: [
      { label: 'Columns added', value: addResult.added.length },
      { label: 'Filled', value: mergeResult.filled.length },
      { label: 'Overwritten', value: mergeResult.overwritten ? mergeResult.overwritten.length : 0 },
      { label: 'Conflicts', value: mergeResult.conflicts.length },
      { label: 'Source rows not in master', value: mergeResult.unmatchedSourceRows ? mergeResult.unmatchedSourceRows.length : 0 },
      { label: 'Errors', value: addResult.errors.length + mergeResult.errors.length }
    ],
    summaryLines: ['Rows marked "Unmatched Source" are present in the source spreadsheet but have no matching ' + config.matchColumn + ' in the master.']
  };
}

/**
 * Shared workflow implementation for pushing selected master fields to every
 * captain sheet in a folder.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} logTab
 * @return {Object}
 */
function executePushToFolderWorkflow_(configSs, config, dryRun, logTab) {
  var masterSs     = SpreadsheetApp.openById(config.masterId);
  var masterSheet  = masterSs.getSheets()[0];
  var masterData   = masterSheet.getDataRange().getValues();
  if (masterData.length === 0) throw new Error('Master spreadsheet is empty.');
  var masterHdrs   = masterData[0].map(function (h) { return String(h).trim(); });
  var sourceLookup = buildSourceLookup_(masterData, masterHdrs, config.matchColumn);
  var targetCols   = config.columnMap.map(function (m) { return m.target; });

  var folder = DriveApp.getFolderById(config.folderId);
  var iter   = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  var files  = [];
  while (iter.hasNext()) files.push(iter.next());
  files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

  var old = configSs.getSheetByName(logTab);
  if (old) configSs.deleteSheet(old);

  var totals = {
    sheetsProcessed: files.length,
    columnsAdded: 0,
    cellsFilled: 0,
    cellsOverwritten: 0,
    conflicts: 0,
    skipped: 0,
    errors: 0
  };

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var fileName = file.getName();
    try {
      var ss = SpreadsheetApp.openById(file.getId());
      var sheet = ss.getSheets()[0];

      var addResult = addColumnsToTarget_(sheet, targetCols, dryRun);
      var virtualCols = addResult.added.map(function (a) { return a.column; });
      var mergeResult = mergeIntoTargetWithPolicies_(
        sheet,
        sourceLookup,
        config.matchColumn,
        config.columnMap,
        config.importColumnPolicies,
        dryRun,
        virtualCols
      );

      appendToSyncLog_(configSs, logTab, fileName, addResult, mergeResult);
      totals.columnsAdded     += addResult.added.length;
      totals.cellsFilled      += mergeResult.filled.length;
      totals.cellsOverwritten += mergeResult.overwritten.length;
      totals.conflicts        += mergeResult.conflicts.length;
      totals.skipped          += mergeResult.skipped.length;
      totals.errors           += addResult.errors.length + mergeResult.errors.length;
    } catch (e) {
      appendToSyncLog_(configSs, logTab, fileName,
        { added: [], skipped: [], errors: [] },
        { filled: [], overwritten: [], conflicts: [], skipped: [], errors: [{ row: 0, column: '', existingValue: '', newValue: e.message }] }
      );
      totals.errors++;
    }
  }

  return {
    sourceSpreadsheet: masterSs.getName(),
    sourceTab: masterSheet.getName(),
    targetSpreadsheet: 'User Sheets Folder',
    logTab: logTab,
    sheetsProcessed: totals.sheetsProcessed,
    columnsAdded: totals.columnsAdded,
    cellsFilled: totals.cellsFilled,
    cellsOverwritten: totals.cellsOverwritten,
    conflicts: totals.conflicts,
    skipped: totals.skipped,
    errors: totals.errors
  };
}

/**
 * Shared implementation for appending missing master residents into one
 * configured captain sheet.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} appendLogTab
 * @param {string} flagLogTab
 * @return {Object}
 */
function executePushMissingRowsToUserSheetWorkflow_(configSs, config, dryRun, appendLogTab, flagLogTab) {
  var masterSs = SpreadsheetApp.openById(config.masterId);
  var masterSheet = masterSs.getSheets()[0];
  var masterData = masterSheet.getDataRange().getValues();
  if (masterData.length === 0) throw new Error('Master spreadsheet is empty.');
  var masterHdrs = masterData[0].map(function (h) { return String(h).trim(); });

  var userSs = SpreadsheetApp.openById(config.userSheetId);
  var userSheet = userSs.getSheets()[0];

  var oldA = configSs.getSheetByName(appendLogTab); if (oldA) configSs.deleteSheet(oldA);
  var oldF = configSs.getSheetByName(flagLogTab);   if (oldF) configSs.deleteSheet(oldF);

  var result = appendMissingRowsToSheet_(userSheet, masterData, masterHdrs, config.sensitiveColumns, dryRun);
  appendToMissingRowsLog_(configSs, appendLogTab, userSs.getName(), result.detectedZone, result);
  if (result.flagged.length > 0) {
    appendToFlaggedSensitiveLog_(configSs, flagLogTab, userSs.getName(), result.detectedZone, result);
  }

  return {
    sourceSpreadsheet: masterSs.getName(),
    targetSpreadsheet: userSs.getName(),
    logTab: appendLogTab,
    secondaryLogTab: result.flagged.length > 0 ? flagLogTab : '',
    sheetsProcessed: 1,
    columnsAdded: 0,
    cellsFilled: 0,
    cellsOverwritten: 0,
    conflicts: 0,
    rowsAppended: result.appended.length,
    sensitiveFlags: result.flagged.length,
    skipped: result.skipped ? result.skipped.length : 0,
    errors: result.errors.length,
    detectedZones: [userSs.getName() + ': ' + (result.detectedZone || '(none)')],
    metrics: [
      { label: 'Sheets processed', value: 1 },
      { label: 'Rows appended', value: result.appended.length },
      { label: 'Sensitive flags', value: result.flagged.length },
      { label: 'Skipped rows', value: result.skipped ? result.skipped.length : 0 },
      { label: 'Errors', value: result.errors.length }
    ],
    summaryLines: ['Detected zone: ' + (result.detectedZone || '(none)')]
  };
}

/**
 * Shared implementation for appending missing master residents into every
 * captain sheet in a folder.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} appendLogTab
 * @param {string} flagLogTab
 * @return {Object}
 */
function executePushMissingRowsToFolderWorkflow_(configSs, config, dryRun, appendLogTab, flagLogTab) {
  var masterSs = SpreadsheetApp.openById(config.masterId);
  var masterSheet = masterSs.getSheets()[0];
  var masterData = masterSheet.getDataRange().getValues();
  if (masterData.length === 0) throw new Error('Master spreadsheet is empty.');
  var masterHdrs = masterData[0].map(function (h) { return String(h).trim(); });

  var files = getGoogleSheetFilesInFolder_(config.folderId);
  var oldA = configSs.getSheetByName(appendLogTab); if (oldA) configSs.deleteSheet(oldA);
  var oldF = configSs.getSheetByName(flagLogTab);   if (oldF) configSs.deleteSheet(oldF);

  var totals = {
    sheetsProcessed: files.length,
    rowsAppended: 0,
    sensitiveFlags: 0,
    skipped: 0,
    errors: 0,
    detectedZones: []
  };

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var fileName = file.getName();
    try {
      var ss = SpreadsheetApp.openById(file.getId());
      var sheet = ss.getSheets()[0];
      var result = appendMissingRowsToSheet_(sheet, masterData, masterHdrs, config.sensitiveColumns, dryRun);

      appendToMissingRowsLog_(configSs, appendLogTab, fileName, result.detectedZone, result);
      if (result.flagged.length > 0) {
        appendToFlaggedSensitiveLog_(configSs, flagLogTab, fileName, result.detectedZone, result);
      }

      totals.rowsAppended += result.appended.length;
      totals.sensitiveFlags += result.flagged.length;
      totals.skipped += result.skipped ? result.skipped.length : 0;
      totals.errors += result.errors.length;
      totals.detectedZones.push(fileName + ': ' + (result.detectedZone || '(none)'));
    } catch (e) {
      appendToMissingRowsLog_(configSs, appendLogTab, fileName, '', {
        appended: [], flagged: [], skipped: [], errors: [{ message: e.message }], detectedZone: ''
      });
      totals.errors++;
      totals.detectedZones.push(fileName + ': (error)');
    }
  }

  return {
    sourceSpreadsheet: masterSs.getName(),
    targetSpreadsheet: 'User Sheets Folder',
    logTab: appendLogTab,
    secondaryLogTab: totals.sensitiveFlags > 0 ? flagLogTab : '',
    sheetsProcessed: totals.sheetsProcessed,
    columnsAdded: 0,
    cellsFilled: 0,
    cellsOverwritten: 0,
    conflicts: 0,
    rowsAppended: totals.rowsAppended,
    sensitiveFlags: totals.sensitiveFlags,
    skipped: totals.skipped,
    errors: totals.errors,
    detectedZones: totals.detectedZones,
    metrics: [
      { label: 'Sheets processed', value: totals.sheetsProcessed },
      { label: 'Rows appended', value: totals.rowsAppended },
      { label: 'Sensitive flags', value: totals.sensitiveFlags },
      { label: 'Skipped rows', value: totals.skipped },
      { label: 'Errors', value: totals.errors }
    ],
    summaryLines: ['Detected zones: ' + totals.detectedZones.slice(0, 8).join('; ') + (totals.detectedZones.length > 8 ? '; ...' : '')]
  };
}

/**
 * Shared implementation for Pull Data <- folder.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} logTab
 * @return {Object}
 */
function executePullDataFromFolderWorkflow_(configSs, config, dryRun, logTab) {
  var masterSs = SpreadsheetApp.openById(config.masterId);
  var masterSheet = masterSs.getSheets()[0];
  var pullState = buildMasterPullDataState_(masterSheet);
  var files = getGoogleSheetFilesInFolder_(config.folderId);
  var pullPolicies = resolvePullColumnPoliciesForRun_(configSs, config.importColumnPolicies);
  assertPullColumnPoliciesLoaded_(pullPolicies);

  var old = configSs.getSheetByName(logTab);
  if (old) configSs.deleteSheet(old);

  var totals = { columnsAdded: 0, appended: 0, filled: 0, overwritten: 0, conflicts: 0, skipped: 0, errors: 0 };
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var fileName = file.getName();
    try {
      var ss = SpreadsheetApp.openById(file.getId());
      var sheet = ss.getSheets()[0];
      var result = pullDataIntoMaster_(masterSheet, sheet, fileName, pullPolicies, dryRun, pullState);
      appendToPullDataLog_(configSs, logTab, fileName, result);
      totals.columnsAdded += result.columnsAdded.length;
      totals.appended += result.appended.length;
      totals.filled += result.filled.length;
      totals.overwritten += result.overwritten.length;
      totals.conflicts += result.conflicts.length;
      totals.skipped += result.skipped.length;
      totals.errors += result.errors.length;
    } catch (e) {
      appendToPullDataLog_(configSs, logTab, fileName, {
        columnsAdded: [], appended: [], filled: [], overwritten: [], conflicts: [], skipped: [], errors: [{ message: e.message }]
      });
      totals.errors++;
    }
  }

  return {
    sourceSpreadsheet: 'User Sheets Folder',
    targetSpreadsheet: masterSs.getName(),
    logTab: logTab,
    sheetsProcessed: files.length,
    columnsAdded: totals.columnsAdded,
    cellsFilled: totals.filled,
    cellsOverwritten: totals.overwritten,
    conflicts: totals.conflicts,
    rowsAppended: totals.appended,
    skipped: totals.skipped,
    errors: totals.errors,
    metrics: [
      { label: 'Sheets processed', value: files.length },
      { label: 'Columns added', value: totals.columnsAdded },
      { label: 'Rows appended', value: totals.appended },
      { label: 'Filled', value: totals.filled },
      { label: 'Overwritten', value: totals.overwritten },
      { label: 'Conflicts', value: totals.conflicts },
      { label: 'Skipped', value: totals.skipped },
      { label: 'Errors', value: totals.errors }
    ],
    summaryLines: ['Policy effects: fill_blank fills only blank master cells; overwrite replaces non-blank master values; conflict logs differences without writing; never skips the column.']
  };
}

/**
 * Shared implementation for Pull Missing Rows <- folder.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} logTab
 * @return {Object}
 */
function executePullMissingRowsFromFolderWorkflow_(configSs, config, dryRun, logTab) {
  var masterSs = SpreadsheetApp.openById(config.masterId);
  var masterSheet = masterSs.getSheets()[0];
  var masterState = buildMasterPullState_(masterSheet);
  var files = getGoogleSheetFilesInFolder_(config.folderId);

  var old = configSs.getSheetByName(logTab);
  if (old) configSs.deleteSheet(old);

  var totals = { columnsAdded: 0, appended: 0, skipped: 0, errors: 0 };
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var fileName = file.getName();
    try {
      var ss = SpreadsheetApp.openById(file.getId());
      var sheet = ss.getSheets()[0];
      var result = appendMissingRowsToMaster_(masterSheet, sheet, fileName, dryRun, masterState);
      appendToPullMissingRowsLog_(configSs, logTab, fileName, result);
      totals.columnsAdded += result.columnsAdded.length;
      totals.appended += result.appended.length;
      totals.skipped += result.skipped.length;
      totals.errors += result.errors.length;
    } catch (e) {
      appendToPullMissingRowsLog_(configSs, logTab, fileName, {
        columnsAdded: [], appended: [], skipped: [], errors: [{ message: e.message }]
      });
      totals.errors++;
    }
  }

  return {
    sourceSpreadsheet: 'User Sheets Folder',
    targetSpreadsheet: masterSs.getName(),
    logTab: logTab,
    sheetsProcessed: files.length,
    columnsAdded: totals.columnsAdded,
    cellsFilled: 0,
    cellsOverwritten: 0,
    conflicts: 0,
    rowsAppended: totals.appended,
    skipped: totals.skipped,
    errors: totals.errors,
    metrics: [
      { label: 'Sheets processed', value: files.length },
      { label: 'Source-only columns added', value: totals.columnsAdded },
      { label: 'Rows appended to master', value: totals.appended },
      { label: 'Blank/duplicate ID skips', value: totals.skipped },
      { label: 'Errors', value: totals.errors }
    ],
    summaryLines: ['Skipped rows include blank resident_id values and duplicate resident_id values already in master or encountered earlier in this run.']
  };
}

/**
 * Shared implementation for Add Columns -> one user sheet.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} logTab
 * @return {Object}
 */
function executeAddColumnsToUserSheetWorkflow_(configSs, config, dryRun, logTab) {
  var columnNames = getAddColumnNamesFromWorkflow_(config);
  if (columnNames.length === 0) throw new Error('No columns are configured to add.');

  var userSs = SpreadsheetApp.openById(config.userSheetId);
  var userSheet = userSs.getSheets()[0];

  var old = configSs.getSheetByName(logTab);
  if (old) configSs.deleteSheet(old);

  var result = addColumnsToTarget_(userSheet, columnNames, dryRun);
  appendToAddColumnsLog_(configSs, logTab, userSs.getName(), result);

  return {
    sourceSpreadsheet: 'Configured headers',
    targetSpreadsheet: userSs.getName(),
    logTab: logTab,
    sheetsProcessed: 1,
    columnsAdded: result.added.length,
    skipped: result.skipped.length,
    errors: result.errors.length,
    metrics: [
      { label: 'Sheets processed', value: 1 },
      { label: dryRun ? 'Columns that would be added' : 'Columns added', value: result.added.length },
      { label: 'Already existed', value: result.skipped.length },
      { label: 'Errors', value: result.errors.length }
    ],
    summaryLines: ['This schema-only workflow changes row-1 headers only. It does not fill data cells or append rows.']
  };
}

/**
 * Shared implementation for Add Columns -> folder.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} logTab
 * @return {Object}
 */
function executeAddColumnsToFolderWorkflow_(configSs, config, dryRun, logTab) {
  var columnNames = getAddColumnNamesFromWorkflow_(config);
  if (columnNames.length === 0) throw new Error('No columns are configured to add.');

  var files = getGoogleSheetFilesInFolder_(config.folderId);
  var old = configSs.getSheetByName(logTab);
  if (old) configSs.deleteSheet(old);

  var totals = { columnsAdded: 0, skipped: 0, errors: 0 };
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var fileName = file.getName();
    try {
      var ss = SpreadsheetApp.openById(file.getId());
      var sheet = ss.getSheets()[0];
      var result = addColumnsToTarget_(sheet, columnNames, dryRun);
      appendToAddColumnsLog_(configSs, logTab, fileName, result);
      totals.columnsAdded += result.added.length;
      totals.skipped += result.skipped.length;
      totals.errors += result.errors.length;
    } catch (e) {
      appendToAddColumnsLog_(configSs, logTab, fileName, {
        added: [],
        skipped: [],
        errors: [{ column: '', message: e.message }]
      });
      totals.errors++;
    }
  }

  return {
    sourceSpreadsheet: 'Configured headers',
    targetSpreadsheet: 'User Sheets Folder',
    logTab: logTab,
    sheetsProcessed: files.length,
    columnsAdded: totals.columnsAdded,
    skipped: totals.skipped,
    errors: totals.errors,
    metrics: [
      { label: 'Sheets processed', value: files.length },
      { label: dryRun ? 'Columns that would be added' : 'Columns added', value: totals.columnsAdded },
      { label: 'Already existed', value: totals.skipped },
      { label: 'Errors', value: totals.errors }
    ],
    summaryLines: ['This schema-only workflow changes row-1 headers only. It does not fill data cells or append rows.']
  };
}

/**
 * Shared implementation for Delete Columns -> one user sheet.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} logTab
 * @return {Object}
 */
function executeDeleteColumnsFromUserSheetWorkflow_(configSs, config, dryRun, logTab) {
  var columnNames = getSchemaColumnNamesFromWorkflow_(config);
  if (columnNames.length === 0) throw new Error('No columns are configured to delete.');

  var userSs = SpreadsheetApp.openById(config.userSheetId);
  var userSheet = userSs.getSheets()[0];

  var old = configSs.getSheetByName(logTab);
  if (old) configSs.deleteSheet(old);

  var result = deleteColumnsFromTarget_(userSheet, columnNames, dryRun);
  appendToDeleteColumnsLog_(configSs, logTab, userSs.getName(), result, dryRun);

  return {
    sourceSpreadsheet: 'Configured headers',
    targetSpreadsheet: userSs.getName(),
    logTab: logTab,
    sheetsProcessed: 1,
    columnsDeleted: result.deleted.length,
    skipped: result.skipped.length,
    errors: result.errors.length,
    metrics: [
      { label: 'Sheets processed', value: 1 },
      { label: dryRun ? 'Columns that would be deleted' : 'Columns deleted', value: result.deleted.length },
      { label: 'Skipped', value: result.skipped.length },
      { label: 'Errors', value: result.errors.length }
    ],
    summaryLines: [
      dryRun
        ? 'Dry Run only previews column deletions. Review non-blank cell counts before running live.'
        : 'Live run deleted each matching column and all data in that column.'
    ]
  };
}

/**
 * Shared implementation for Delete Columns -> folder.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} logTab
 * @return {Object}
 */
function executeDeleteColumnsFromFolderWorkflow_(configSs, config, dryRun, logTab) {
  var columnNames = getSchemaColumnNamesFromWorkflow_(config);
  if (columnNames.length === 0) throw new Error('No columns are configured to delete.');

  var files = getGoogleSheetFilesInFolder_(config.folderId);
  var old = configSs.getSheetByName(logTab);
  if (old) configSs.deleteSheet(old);

  var totals = { columnsDeleted: 0, skipped: 0, errors: 0 };
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var fileName = file.getName();
    try {
      var ss = SpreadsheetApp.openById(file.getId());
      var sheet = ss.getSheets()[0];
      var result = deleteColumnsFromTarget_(sheet, columnNames, dryRun);
      appendToDeleteColumnsLog_(configSs, logTab, fileName, result, dryRun);
      totals.columnsDeleted += result.deleted.length;
      totals.skipped += result.skipped.length;
      totals.errors += result.errors.length;
    } catch (e) {
      appendToDeleteColumnsLog_(configSs, logTab, fileName, {
        deleted: [],
        skipped: [],
        errors: [{ column: '', message: e.message }]
      }, dryRun);
      totals.errors++;
    }
  }

  return {
    sourceSpreadsheet: 'Configured headers',
    targetSpreadsheet: 'User Sheets Folder',
    logTab: logTab,
    sheetsProcessed: files.length,
    columnsDeleted: totals.columnsDeleted,
    skipped: totals.skipped,
    errors: totals.errors,
    metrics: [
      { label: 'Sheets processed', value: files.length },
      { label: dryRun ? 'Columns that would be deleted' : 'Columns deleted', value: totals.columnsDeleted },
      { label: 'Skipped', value: totals.skipped },
      { label: 'Errors', value: totals.errors }
    ],
    summaryLines: [
      dryRun
        ? 'Dry Run only previews column deletions. Review non-blank cell counts before running live.'
        : 'Live run deleted each matching column and all data in that column.'
    ]
  };
}

/**
 * Shared implementation for Rename Columns -> folder.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSs
 * @param {Object} config
 * @param {boolean} dryRun
 * @param {string} logTab
 * @return {Object}
 */
function executeRenameColumnsInFolderWorkflow_(configSs, config, dryRun, logTab) {
  var files = getGoogleSheetFilesInFolder_(config.folderId);
  var old = configSs.getSheetByName(logTab);
  if (old) configSs.deleteSheet(old);

  var totalRenamed = 0, totalSkipped = 0, totalErrors = 0;
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var fileName = file.getName();
    try {
      var ss = SpreadsheetApp.openById(file.getId());
      var sheet = ss.getSheets()[0];
      var result = renameColumnInTarget_(sheet, config.renameFrom, config.renameTo, dryRun);
      appendToRenameLog_(configSs, logTab, fileName, config.renameFrom, config.renameTo, result);
      if (result.renamed) totalRenamed++;
      else if (result.skipped) totalSkipped++;
      else totalErrors++;
    } catch (e) {
      appendToRenameLog_(configSs, logTab, fileName, config.renameFrom, config.renameTo, {
        renamed: false,
        skipped: false,
        error: e.message,
        note: ''
      });
      totalErrors++;
    }
  }

  return {
    sourceSpreadsheet: 'User Sheets Folder',
    targetSpreadsheet: 'Captain sheet headers',
    logTab: logTab,
    sheetsProcessed: files.length,
    columnsAdded: 0,
    cellsFilled: 0,
    cellsOverwritten: 0,
    conflicts: 0,
    renamed: totalRenamed,
    skipped: totalSkipped,
    errors: totalErrors,
    metrics: [
      { label: 'Sheets processed', value: files.length },
      { label: dryRun ? 'Headers that would rename' : 'Headers renamed', value: totalRenamed },
      { label: 'Skipped sheets', value: totalSkipped },
      { label: 'Errors', value: totalErrors }
    ],
    summaryLines: [
      dryRun
        ? 'Dry Run only previews row-1 header changes across the folder. Review this log before running live.'
        : 'Live run changed only matching row-1 headers. Data rows were not edited.'
    ]
  };
}

// -------  Push → User Sheet  -------
//
// Reads data FROM the Master and writes it INTO a single user
// spreadsheet. Use this to push master data to one specific sheet
// without touching the rest of the folder.

function pushToUserSheet()       { runPushToSheet_(false); }
function pushToUserSheetDryRun() { runPushToSheet_(true);  }

function runPushToSheet_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  try {
    var configSs = SpreadsheetApp.getActiveSpreadsheet();
    var config   = readMergeConfig_(configSs);

    if (!config.masterId)     throw new Error('Master Spreadsheet is not set in the Settings tab.');
    if (!config.userSheetId)  throw new Error('User Sheet is not set in the Settings tab.');
    if (!config.matchColumn)  throw new Error('Match Column is not set in the Settings tab.');
    if (config.columnMap.length === 0) throw new Error(
      'Column Mapping tab has no valid rows. Add at least one Source Column → Target Column pair.'
    );

    var masterSs     = SpreadsheetApp.openById(config.masterId);
    var masterSheet  = masterSs.getSheets()[0];
    var masterData   = masterSheet.getDataRange().getValues();
    var masterHdrs   = masterData[0].map(function (h) { return String(h).trim(); });
    var sourceLookup = buildSourceLookup_(masterData, masterHdrs, config.matchColumn);

    var userSs    = SpreadsheetApp.openById(config.userSheetId);
    var userSheet = userSs.getSheets()[0];

    var targetCols  = config.columnMap.map(function (m) { return m.target; });
    var addResult   = addColumnsToTarget_(userSheet, targetCols, dryRun);
    var virtualCols = addResult.added.map(function (a) { return a.column; });
    var mergeResult = mergeIntoTarget_(userSheet, sourceLookup, config.matchColumn, config.columnMap, dryRun, virtualCols);

    var logTab = dryRun ? 'Dry Run - Push User Sheet' : 'Last Push - User Sheet';
    var old = configSs.getSheetByName(logTab);
    if (old) configSs.deleteSheet(old);
    appendToSyncLog_(configSs, logTab, userSs.getName(), addResult, mergeResult);

    var prefix = dryRun ? 'DRY RUN — Push → User Sheet\n\n' : 'Push → User Sheet complete.\n\n';
    ui.alert(
      prefix +
      'Columns added: '               + addResult.added.length + '\n' +
      'Cells filled: '                + mergeResult.filled.length + '\n' +
      'Conflicts (not overwritten): ' + mergeResult.conflicts.length + '\n' +
      'Errors: '                      + (addResult.errors.length + mergeResult.errors.length) + '\n\n' +
      'See the "' + logTab + '" tab for details.'
    );
  } catch (e) {
    ui.alert('Push → User Sheet failed:\n\n' + e.message);
  }
}

// -------  Push → User Sheets Folder  -------
//
// Reads data FROM the Master and writes it INTO every Google
// Sheet in the configured Drive folder. Use this to propagate
// master data out to all ~55 user sheets at once.

function pushToFolder()       { runPushToFolder_(false); }
function pushToFolderDryRun() { runPushToFolder_(true);  }

function runPushToFolder_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  try {
    var configSs = SpreadsheetApp.getActiveSpreadsheet();
    var config   = readMergeConfig_(configSs);

    if (!config.masterId)    throw new Error('Master Spreadsheet is not set in the Settings tab.');
    if (!config.folderId)    throw new Error('User Sheets Folder is not set in the Settings tab.');
    if (!config.matchColumn) throw new Error('Match Column is not set in the Settings tab.');
    if (config.columnMap.length === 0) throw new Error(
      'Column Mapping tab has no valid rows. Add at least one Source Column → Target Column pair.'
    );

    var masterSs     = SpreadsheetApp.openById(config.masterId);
    var masterSheet  = masterSs.getSheets()[0];
    var masterData   = masterSheet.getDataRange().getValues();
    var masterHdrs   = masterData[0].map(function (h) { return String(h).trim(); });
    var sourceLookup = buildSourceLookup_(masterData, masterHdrs, config.matchColumn);

    var targetCols = config.columnMap.map(function (m) { return m.target; });

    var folder = DriveApp.getFolderById(config.folderId);
    var iter   = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
    var files  = [];
    while (iter.hasNext()) files.push(iter.next());
    files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

    var logTab = dryRun ? 'Dry Run - Push Folder' : 'Last Push - Folder';
    var old = configSs.getSheetByName(logTab);
    if (old) configSs.deleteSheet(old);

    var totalCols = 0, totalFills = 0, totalConflicts = 0, totalErrors = 0;

    for (var i = 0; i < files.length; i++) {
      var file     = files[i];
      var fileName = file.getName();
      try {
        var ss    = SpreadsheetApp.openById(file.getId());
        var sheet = ss.getSheets()[0];

        var addResult   = addColumnsToTarget_(sheet, targetCols, dryRun);
        var virtualCols = addResult.added.map(function (a) { return a.column; });
        var mergeResult = mergeIntoTarget_(sheet, sourceLookup, config.matchColumn, config.columnMap, dryRun, virtualCols);

        appendToSyncLog_(configSs, logTab, fileName, addResult, mergeResult);
        totalCols      += addResult.added.length;
        totalFills     += mergeResult.filled.length;
        totalConflicts += mergeResult.conflicts.length;
        totalErrors    += addResult.errors.length + mergeResult.errors.length;
      } catch (e) {
        appendToSyncLog_(configSs, logTab, fileName,
          { added: [], skipped: [], errors: [] },
          { filled: [], conflicts: [], errors: [{ row: 0, column: '', existingValue: '', newValue: e.message }] }
        );
        totalErrors++;
      }
    }

    var prefix = dryRun ? 'DRY RUN — Push → Folder\n\n' : 'Push → Folder complete.\n\n';
    ui.alert(
      prefix +
      'Sheets processed: '            + files.length + '\n' +
      'Total columns added: '         + totalCols + '\n' +
      'Total cells filled: '          + totalFills + '\n' +
      'Conflicts (not overwritten): ' + totalConflicts + '\n' +
      'Total errors: '                + totalErrors + '\n\n' +
      'See the "' + logTab + '" tab for details.'
    );
  } catch (e) {
    ui.alert('Push → Folder failed:\n\n' + e.message);
  }
}

// -------  Push Missing Rows → User Sheet  -------
//
// For a single user sheet: detects its zone (mode of the ZoneName
// column), finds master rows whose ZoneName matches the detected
// zone, and appends the ones whose resident_id isn't already in the
// sheet. Columns are filled by header-name join from master.
//
// Rows whose master record has a non-blank value in any column listed
// under "Sensitive Columns" in Settings are still appended, but also
// recorded in the "Flagged - Sensitive Data" log tab for admin review.

function pushMissingRowsToUserSheet()       { runPushMissingRowsToSheet_(false); }
function pushMissingRowsToUserSheetDryRun() { runPushMissingRowsToSheet_(true);  }

function runPushMissingRowsToSheet_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  try {
    var configSs = SpreadsheetApp.getActiveSpreadsheet();
    var config   = readMergeConfig_(configSs);

    if (!config.masterId)    throw new Error('Master Spreadsheet is not set in the Settings tab.');
    if (!config.userSheetId) throw new Error('User Sheet is not set in the Settings tab.');

    var masterSs    = SpreadsheetApp.openById(config.masterId);
    var masterSheet = masterSs.getSheets()[0];
    var masterData  = masterSheet.getDataRange().getValues();
    var masterHdrs  = masterData[0].map(function (h) { return String(h).trim(); });

    var userSs    = SpreadsheetApp.openById(config.userSheetId);
    var userSheet = userSs.getSheets()[0];

    var appendLogTab = dryRun ? 'Dry Run - Push Missing Rows' : 'Last Push - Missing Rows';
    var flagLogTab   = dryRun ? 'Dry Run - Flagged Sensitive Data' : 'Flagged - Sensitive Data';
    var oldA = configSs.getSheetByName(appendLogTab); if (oldA) configSs.deleteSheet(oldA);
    var oldF = configSs.getSheetByName(flagLogTab);   if (oldF) configSs.deleteSheet(oldF);

    var result = appendMissingRowsToSheet_(userSheet, masterData, masterHdrs, config.sensitiveColumns, dryRun);
    appendToMissingRowsLog_(configSs, appendLogTab, userSs.getName(), result.detectedZone, result);
    if (result.flagged.length > 0) {
      appendToFlaggedSensitiveLog_(configSs, flagLogTab, userSs.getName(), result.detectedZone, result);
    }

    var prefix = dryRun ? 'DRY RUN — Push Missing Rows → User Sheet\n\n' : 'Push Missing Rows → User Sheet complete.\n\n';
    ui.alert(
      prefix +
      'Detected zone: '                      + (result.detectedZone || '(none)') + '\n' +
      'Rows appended: '                      + result.appended.length + '\n' +
      'Flagged (sensitive data present): '   + result.flagged.length + '\n' +
      'Errors: '                             + result.errors.length + '\n\n' +
      'See the "' + appendLogTab + '" tab' +
      (result.flagged.length > 0 ? ' and "' + flagLogTab + '" tab' : '') + '.'
    );
  } catch (e) {
    ui.alert('Push Missing Rows → User Sheet failed:\n\n' + e.message);
  }
}

// -------  Push Missing Rows → User Sheets Folder  -------
//
// Same as above but iterates every sheet in the configured folder.
// Each sheet's zone is detected independently. Results for all
// sheets accumulate into one "Last Push - Missing Rows" log tab
// and one "Flagged - Sensitive Data" log tab.

function pushMissingRowsToFolder()       { runPushMissingRowsToFolder_(false); }
function pushMissingRowsToFolderDryRun() { runPushMissingRowsToFolder_(true);  }

function runPushMissingRowsToFolder_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  try {
    var configSs = SpreadsheetApp.getActiveSpreadsheet();
    var config   = readMergeConfig_(configSs);

    if (!config.masterId) throw new Error('Master Spreadsheet is not set in the Settings tab.');
    if (!config.folderId) throw new Error('User Sheets Folder is not set in the Settings tab.');

    var masterSs    = SpreadsheetApp.openById(config.masterId);
    var masterSheet = masterSs.getSheets()[0];
    var masterData  = masterSheet.getDataRange().getValues();
    var masterHdrs  = masterData[0].map(function (h) { return String(h).trim(); });

    var folder = DriveApp.getFolderById(config.folderId);
    var iter   = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
    var files  = [];
    while (iter.hasNext()) files.push(iter.next());
    files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

    var appendLogTab = dryRun ? 'Dry Run - Push Missing Rows' : 'Last Push - Missing Rows';
    var flagLogTab   = dryRun ? 'Dry Run - Flagged Sensitive Data' : 'Flagged - Sensitive Data';
    var oldA = configSs.getSheetByName(appendLogTab); if (oldA) configSs.deleteSheet(oldA);
    var oldF = configSs.getSheetByName(flagLogTab);   if (oldF) configSs.deleteSheet(oldF);

    var totalAppended = 0, totalFlagged = 0, totalErrors = 0;

    for (var i = 0; i < files.length; i++) {
      var file     = files[i];
      var fileName = file.getName();
      try {
        var ss     = SpreadsheetApp.openById(file.getId());
        var sheet  = ss.getSheets()[0];
        var result = appendMissingRowsToSheet_(sheet, masterData, masterHdrs, config.sensitiveColumns, dryRun);

        appendToMissingRowsLog_(configSs, appendLogTab, fileName, result.detectedZone, result);
        if (result.flagged.length > 0) {
          appendToFlaggedSensitiveLog_(configSs, flagLogTab, fileName, result.detectedZone, result);
        }

        totalAppended += result.appended.length;
        totalFlagged  += result.flagged.length;
        totalErrors   += result.errors.length;
      } catch (e) {
        appendToMissingRowsLog_(configSs, appendLogTab, fileName, '', {
          appended: [], flagged: [], errors: [{ message: e.message }], detectedZone: ''
        });
        totalErrors++;
      }
    }

    var prefix = dryRun ? 'DRY RUN — Push Missing Rows → Folder\n\n' : 'Push Missing Rows → Folder complete.\n\n';
    ui.alert(
      prefix +
      'Sheets processed: '                   + files.length + '\n' +
      'Total rows appended: '                + totalAppended + '\n' +
      'Flagged (sensitive data present): '   + totalFlagged + '\n' +
      'Errors: '                             + totalErrors + '\n\n' +
      'See the "' + appendLogTab + '" tab' +
      (totalFlagged > 0 ? ' and "' + flagLogTab + '" tab' : '') + '.'
    );
  } catch (e) {
    ui.alert('Push Missing Rows → Folder failed:\n\n' + e.message);
  }
}

// -------  Pull Missing Rows ← User Sheet  -------
//
// For a single user sheet: finds rows whose resident_id does not already
// exist in the master and appends them to the master. Any user-sheet
// columns missing from the master are added first so captain-created
// fields are preserved.

function pullMissingRowsFromUserSheet()       { runPullMissingRowsFromSheet_(false); }
function pullMissingRowsFromUserSheetDryRun() { runPullMissingRowsFromSheet_(true);  }

function runPullMissingRowsFromSheet_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  try {
    var configSs = SpreadsheetApp.getActiveSpreadsheet();
    var config   = readMergeConfig_(configSs);

    if (!config.masterId)    throw new Error('Master Spreadsheet is not set in the Settings tab.');
    if (!config.userSheetId) throw new Error('User Sheet is not set in the Settings tab.');

    var masterSs    = SpreadsheetApp.openById(config.masterId);
    var masterSheet = masterSs.getSheets()[0];
    var masterState = buildMasterPullState_(masterSheet);

    var userSs    = SpreadsheetApp.openById(config.userSheetId);
    var userSheet = userSs.getSheets()[0];

    var logTab = dryRun ? 'Dry Run - Pull Missing Rows' : 'Last Pull - Missing Rows';
    var old = configSs.getSheetByName(logTab);
    if (old) configSs.deleteSheet(old);

    var result = appendMissingRowsToMaster_(masterSheet, userSheet, userSs.getName(), dryRun, masterState);
    appendToPullMissingRowsLog_(configSs, logTab, userSs.getName(), result);

    var prefix = dryRun ? 'DRY RUN — Pull Missing Rows ← User Sheet\n\n' : 'Pull Missing Rows ← User Sheet complete.\n\n';
    ui.alert(
      prefix +
      'Columns added to master: ' + result.columnsAdded.length + '\n' +
      'Rows appended to master: ' + result.appended.length + '\n' +
      'Skipped: '                + result.skipped.length + '\n' +
      'Errors: '                 + result.errors.length + '\n\n' +
      'See the "' + logTab + '" tab for details.'
    );
  } catch (e) {
    ui.alert('Pull Missing Rows ← User Sheet failed:\n\n' + e.message);
  }
}

// -------  Pull Missing Rows ← User Sheets Folder  -------
//
// Same as above but iterates every sheet in the configured folder.
// Results for all sheets accumulate into one "Last Pull - Missing Rows"
// log tab.

function pullMissingRowsFromFolder()       { runPullMissingRowsFromFolder_(false); }
function pullMissingRowsFromFolderDryRun() { runPullMissingRowsFromFolder_(true);  }

function runPullMissingRowsFromFolder_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  try {
    var configSs = SpreadsheetApp.getActiveSpreadsheet();
    var config   = readMergeConfig_(configSs);

    if (!config.masterId) throw new Error('Master Spreadsheet is not set in the Settings tab.');
    if (!config.folderId) throw new Error('User Sheets Folder is not set in the Settings tab.');

    var masterSs    = SpreadsheetApp.openById(config.masterId);
    var masterSheet = masterSs.getSheets()[0];
    var masterState = buildMasterPullState_(masterSheet);

    var folder = DriveApp.getFolderById(config.folderId);
    var iter   = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
    var files  = [];
    while (iter.hasNext()) files.push(iter.next());
    files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

    var logTab = dryRun ? 'Dry Run - Pull Missing Rows' : 'Last Pull - Missing Rows';
    var old = configSs.getSheetByName(logTab);
    if (old) configSs.deleteSheet(old);

    var totalColumnsAdded = 0, totalAppended = 0, totalSkipped = 0, totalErrors = 0;

    for (var i = 0; i < files.length; i++) {
      var file     = files[i];
      var fileName = file.getName();
      try {
        var ss     = SpreadsheetApp.openById(file.getId());
        var sheet  = ss.getSheets()[0];
        var result = appendMissingRowsToMaster_(masterSheet, sheet, fileName, dryRun, masterState);

        appendToPullMissingRowsLog_(configSs, logTab, fileName, result);

        totalColumnsAdded += result.columnsAdded.length;
        totalAppended     += result.appended.length;
        totalSkipped      += result.skipped.length;
        totalErrors       += result.errors.length;
      } catch (e) {
        appendToPullMissingRowsLog_(configSs, logTab, fileName, {
          columnsAdded: [],
          appended: [],
          skipped: [],
          errors: [{ message: e.message }]
        });
        totalErrors++;
      }
    }

    var prefix = dryRun ? 'DRY RUN — Pull Missing Rows ← Folder\n\n' : 'Pull Missing Rows ← Folder complete.\n\n';
    ui.alert(
      prefix +
      'Sheets processed: '          + files.length + '\n' +
      'Total columns added: '       + totalColumnsAdded + '\n' +
      'Total rows appended: '       + totalAppended + '\n' +
      'Skipped: '                   + totalSkipped + '\n' +
      'Errors: '                    + totalErrors + '\n\n' +
      'See the "' + logTab + '" tab for details.'
    );
  } catch (e) {
    ui.alert('Pull Missing Rows ← User Sheets Folder failed:\n\n' + e.message);
  }
}

// -------  Pull Data ← User Sheet  -------
//
// Pulls captain-entered values from one user sheet into the master.
// Existing master rows are updated according to Pull Column Policy;
// rows missing from master are appended.

function pullDataFromUserSheet()       { runPullDataFromSheet_(false); }
function pullDataFromUserSheetDryRun() { runPullDataFromSheet_(true);  }

function runPullDataFromSheet_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  try {
    var configSs = SpreadsheetApp.getActiveSpreadsheet();
    var config   = readMergeConfig_(configSs);

    if (!config.masterId)    throw new Error('Master Spreadsheet is not set in the Settings tab.');
    if (!config.userSheetId) throw new Error('User Sheet is not set in the Settings tab.');

    var masterSs    = SpreadsheetApp.openById(config.masterId);
    var masterSheet = masterSs.getSheets()[0];
    var pullState   = buildMasterPullDataState_(masterSheet);

    var userSs    = SpreadsheetApp.openById(config.userSheetId);
    var userSheet = userSs.getSheets()[0];

    var logTab = dryRun ? 'Dry Run - Pull Data' : 'Last Pull Data';
    var old = configSs.getSheetByName(logTab);
    if (old) configSs.deleteSheet(old);

    var pullPolicies = resolvePullColumnPoliciesForRun_(configSs, config.importColumnPolicies);
    assertPullColumnPoliciesLoaded_(pullPolicies);
    var result = pullDataIntoMaster_(masterSheet, userSheet, userSs.getName(), pullPolicies, dryRun, pullState);
    appendToPullDataLog_(configSs, logTab, userSs.getName(), result);

    var prefix = dryRun ? 'DRY RUN — Pull Data ← User Sheet\n\n' : 'Pull Data ← User Sheet complete.\n\n';
    ui.alert(
      prefix +
      'Columns added to master: ' + result.columnsAdded.length + '\n' +
      'Rows appended to master: ' + result.appended.length + '\n' +
      'Cells filled: '           + result.filled.length + '\n' +
      'Cells overwritten: '      + result.overwritten.length + '\n' +
      'Conflicts logged: '       + result.conflicts.length + '\n' +
      'Skipped: '                + result.skipped.length + '\n' +
      'Errors: '                 + result.errors.length + '\n\n' +
      'See the "' + logTab + '" tab for details.'
    );
  } catch (e) {
    ui.alert('Pull Data ← User Sheet failed:\n\n' + e.message);
  }
}

// -------  Pull Data ← User Sheets Folder  -------
//
// Same as above but iterates every sheet in the configured folder.

function pullDataFromFolder()       { runPullDataFromFolder_(false); }
function pullDataFromFolderDryRun() { runPullDataFromFolder_(true);  }

function runPullDataFromFolder_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  try {
    var configSs = SpreadsheetApp.getActiveSpreadsheet();
    var config   = readMergeConfig_(configSs);

    if (!config.masterId) throw new Error('Master Spreadsheet is not set in the Settings tab.');
    if (!config.folderId) throw new Error('User Sheets Folder is not set in the Settings tab.');

    var masterSs    = SpreadsheetApp.openById(config.masterId);
    var masterSheet = masterSs.getSheets()[0];
    var pullState   = buildMasterPullDataState_(masterSheet);

    var folder = DriveApp.getFolderById(config.folderId);
    var iter   = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
    var files  = [];
    while (iter.hasNext()) files.push(iter.next());
    files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

    var logTab = dryRun ? 'Dry Run - Pull Data' : 'Last Pull Data';
    var old = configSs.getSheetByName(logTab);
    if (old) configSs.deleteSheet(old);

    var pullPolicies = resolvePullColumnPoliciesForRun_(configSs, config.importColumnPolicies);
    assertPullColumnPoliciesLoaded_(pullPolicies);

    var totalColumnsAdded = 0, totalAppended = 0, totalFilled = 0, totalOverwritten = 0;
    var totalConflicts = 0, totalSkipped = 0, totalErrors = 0;

    for (var i = 0; i < files.length; i++) {
      var file     = files[i];
      var fileName = file.getName();
      try {
        var ss     = SpreadsheetApp.openById(file.getId());
        var sheet  = ss.getSheets()[0];
        var result = pullDataIntoMaster_(masterSheet, sheet, fileName, pullPolicies, dryRun, pullState);

        appendToPullDataLog_(configSs, logTab, fileName, result);

        totalColumnsAdded += result.columnsAdded.length;
        totalAppended     += result.appended.length;
        totalFilled       += result.filled.length;
        totalOverwritten  += result.overwritten.length;
        totalConflicts    += result.conflicts.length;
        totalSkipped      += result.skipped.length;
        totalErrors       += result.errors.length;
      } catch (e) {
        appendToPullDataLog_(configSs, logTab, fileName, {
          columnsAdded: [],
          appended: [],
          filled: [],
          overwritten: [],
          conflicts: [],
          skipped: [],
          errors: [{ message: e.message }]
        });
        totalErrors++;
      }
    }

    var prefix = dryRun ? 'DRY RUN — Pull Data ← Folder\n\n' : 'Pull Data ← Folder complete.\n\n';
    ui.alert(
      prefix +
      'Sheets processed: '          + files.length + '\n' +
      'Total columns added: '       + totalColumnsAdded + '\n' +
      'Total rows appended: '       + totalAppended + '\n' +
      'Total cells filled: '        + totalFilled + '\n' +
      'Total cells overwritten: '   + totalOverwritten + '\n' +
      'Conflicts logged: '          + totalConflicts + '\n' +
      'Skipped: '                   + totalSkipped + '\n' +
      'Errors: '                    + totalErrors + '\n\n' +
      'See the "' + logTab + '" tab for details.'
    );
  } catch (e) {
    ui.alert('Pull Data ← User Sheets Folder failed:\n\n' + e.message);
  }
}

// -------  Rename Columns → User Sheets Folder  -------
//
// Renames a single header across every Google Sheet in the
// configured user folder. Only row-1 header cells are changed.
// Data rows are never edited by this operation.

function renameColumnsInFolder()       { runRenameColumnsInFolder_(false); }
function renameColumnsInFolderDryRun() { runRenameColumnsInFolder_(true);  }

function runRenameColumnsInFolder_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  try {
    var configSs = SpreadsheetApp.getActiveSpreadsheet();
    var config = readMergeConfig_(configSs);

    if (!config.folderId)   throw new Error('User Sheets Folder is not set in the Settings tab.');
    if (!config.renameFrom) throw new Error('Rename Column - From is not set in the Settings tab.');
    if (!config.renameTo)   throw new Error('Rename Column - To is not set in the Settings tab.');

    var folder = DriveApp.getFolderById(config.folderId);
    var iter = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
    var files = [];
    while (iter.hasNext()) files.push(iter.next());
    files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

    var logTab = dryRun ? 'Dry Run - Rename Folder' : 'Last Rename - Folder';
    var old = configSs.getSheetByName(logTab);
    if (old) configSs.deleteSheet(old);

    var totalRenamed = 0, totalSkipped = 0, totalErrors = 0;

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var fileName = file.getName();
      try {
        var ss = SpreadsheetApp.openById(file.getId());
        var sheet = ss.getSheets()[0];
        var result = renameColumnInTarget_(sheet, config.renameFrom, config.renameTo, dryRun);

        appendToRenameLog_(configSs, logTab, fileName, config.renameFrom, config.renameTo, result);

        if (result.renamed) totalRenamed++;
        else if (result.skipped) totalSkipped++;
        else totalErrors++;
      } catch (e) {
        appendToRenameLog_(configSs, logTab, fileName, config.renameFrom, config.renameTo, {
          renamed: false,
          skipped: false,
          error: e.message,
          note: ''
        });
        totalErrors++;
      }
    }

    var prefix = dryRun ? 'DRY RUN — Rename Columns → Folder\n\n' : 'Rename Columns → Folder complete.\n\n';
    ui.alert(
      prefix +
      'Sheets processed: ' + files.length + '\n' +
      'Headers renamed: ' + totalRenamed + '\n' +
      'Skipped: ' + totalSkipped + '\n' +
      'Errors: ' + totalErrors + '\n\n' +
      'See the "' + logTab + '" tab for details.'
    );
  } catch (e) {
    ui.alert('Rename Columns → User Sheets Folder failed:\n\n' + e.message);
  }
}

// -------  Set Up Config Tabs  -------
//
// Formats the Settings, Column Mapping, and Pull Column Policy tabs
// with labels, column headers, and plain-English instructions. Run
// this once when setting up a new Sheet Smart Config spreadsheet, or
// any time you want to restore the correct structure.

function setupConfigTabs() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    'Set Up Config Tabs',
    'This will format the Settings, Column Mapping, and Pull Column Policy tabs with labels and instructions.\n\n' +
    '• Existing values in the Settings tab (column B) will be preserved.\n' +
    '• The Column Mapping tab header row will be updated; existing mapping rows will not change.\n\n' +
    'Continue?',
    ui.ButtonSet.OK_CANCEL
  );
  if (response !== ui.Button.OK) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  setupSettingsTab_(ss);
  setupColumnMappingTab_(ss);
  setupPullColumnPolicyTab_(ss);
  setupWorkflowPresetsTab_(ss);

  ui.alert(
    'Config tabs are ready.\n\n' +
    'Next steps:\n' +
    '1. Fill in the Value column in the Settings tab.\n' +
    '2. Add your column pairs to the Column Mapping tab.\n' +
    '3. Add pull policies for captain-entered columns in the Pull Column Policy tab.\n' +
    '4. Review or edit task presets in the Workflow Presets tab.\n' +
    '5. Run a Dry Run first to preview results before a live operation.'
  );
}

/**
 * Writes (or rewrites) the Settings tab with labeled rows,
 * descriptions, and proper formatting. Preserves any values
 * already in column B.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss
 */
function setupSettingsTab_(ss) {
  var tab = ss.getSheetByName('Settings');
  if (!tab) tab = ss.insertSheet('Settings');

  // Preserve existing values before clearing
  var existingValues = {};
  var existingData = tab.getDataRange().getValues();
  for (var i = 0; i < existingData.length; i++) {
    var key = String(existingData[i][0]).trim();
    var val = existingData[i].length > 1 ? existingData[i][1] : '';
    if (key !== '') existingValues[key] = val;
  }

  tab.clear();

  var rows = [
    ['Setting', 'Value', 'What to put here'],
    [
      'Master Spreadsheet',
      existingValues['Master Spreadsheet'] || '',
      'Your master spreadsheet ID. This is the DESTINATION for "Import → Master" ' +
      'and "Pull Missing Rows", and the SOURCE for "Push" operations. ' +
      'Find it in the URL: docs.google.com/spreadsheets/d/[COPY THIS]/edit'
    ],
    [
      'External Source',
      existingValues['External Source'] || existingValues['Source Spreadsheet'] || '',
      'ID of a spreadsheet to import data FROM into the master. ' +
      'Only used by "Import → Master". ' +
      'Find it in the URL: docs.google.com/spreadsheets/d/[COPY THIS]/edit'
    ],
    [
      'Source Tab Name',
      existingValues['Source Tab Name'] || '',
      'Optional tab name inside the External Source spreadsheet. If blank, ' +
      '"Import → Master" uses the first tab. For sales imports, use "Sales Rollup by APN".'
    ],
    [
      'User Sheet',
      existingValues['User Sheet'] || '',
      'ID of a single user spreadsheet to push master data TO or pull missing rows FROM. ' +
      'Used by single-sheet Push, Pull, and Add Columns operations. ' +
      'Find it in the URL: docs.google.com/spreadsheets/d/[COPY THIS]/edit'
    ],
    [
      'User Sheets Folder',
      existingValues['User Sheets Folder'] || existingValues['Target Folder'] || '',
      'ID of the Drive folder containing all user sheets. ' +
      'Used by folder-wide Push, Pull, Add Columns, and Rename operations. ' +
      'Find it at the end of the folder URL: drive.google.com/drive/folders/[COPY THIS]'
    ],
    [
      'Match Column',
      existingValues['Match Column'] || '',
      'The column header that exists in both master and user sheets and uniquely ' +
      'identifies each row (e.g. APN). Must match exactly — same spelling and capitalization.'
    ],
    [
      'Rename Column - From',
      existingValues['Rename Column - From'] || '',
      'For "Rename Columns → User Sheets Folder": the existing header name to rename ' +
      '(exact match, including spelling and capitalization).'
    ],
    [
      'Rename Column - To',
      existingValues['Rename Column - To'] || '',
      'For "Rename Columns → User Sheets Folder": the new header name to write. ' +
      'If this header already exists in a sheet, that sheet is skipped and logged.'
    ],
    [
      'Sensitive Columns',
      existingValues['Sensitive Columns'] || '',
      'Comma-separated list of column headers whose values are considered privacy-sensitive ' +
      '(e.g. "Person Notes, Contact Notes, Address Notes"). Only used by the "Push Missing Rows" ' +
      'operations. When a missing row is appended to a user sheet and any of these columns has ' +
      'a value in master, the row is listed in the "Flagged - Sensitive Data" log tab for you ' +
      'to review. The row is still appended — this flag is informational.'
    ]
  ];

  tab.getRange(1, 1, rows.length, 3).setValues(rows);

  // Header row
  var headerRange = tab.getRange(1, 1, 1, 3);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#e8eaf6');
  tab.setFrozenRows(1);

  // Setting name column: bold
  tab.getRange(2, 1, rows.length - 1, 1).setFontWeight('bold');

  // Description column: grey italic wrapped
  tab.getRange(2, 3, rows.length - 1, 1)
    .setFontStyle('italic')
    .setFontColor('#757575')
    .setWrap(true);

  tab.setColumnWidth(1, 210);
  tab.setColumnWidth(2, 340);
  tab.setColumnWidth(3, 520);
}

/**
 * Writes (or updates) the Column Mapping tab header row with
 * formatting and an instructional cell note. Existing mapping
 * rows (row 2 onward) are never modified.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss
 */
function setupColumnMappingTab_(ss) {
  var tab = ss.getSheetByName('Column Mapping');
  if (!tab) tab = ss.insertSheet('Column Mapping');

  tab.getRange(1, 1, 1, 2).setValues([['Source Column', 'Target Column']]);

  var headerRange = tab.getRange(1, 1, 1, 2);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#e8eaf6');
  tab.setFrozenRows(1);

  tab.getRange(1, 1).setNote(
    'One row per column to sync.\n\n' +
    '• Source Column: the header name in the source spreadsheet (master for Push, ' +
    'external sheet for Import).\n' +
    '• Target Column: the header name in the destination spreadsheet.\n\n' +
    'If both use the same column name, put that name in both columns.\n\n' +
    'Rows with a blank cell in either column are automatically skipped.'
  );

  tab.setColumnWidth(1, 240);
  tab.setColumnWidth(2, 240);
}

/**
 * Writes (or updates) the Pull Column Policy tab header row with
 * formatting and examples. Existing policy rows are preserved.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss
 */
function setupPullColumnPolicyTab_(ss) {
  var tab = ss.getSheetByName('Pull Column Policy');
  if (!tab) tab = ss.insertSheet('Pull Column Policy');

  var existingData = tab.getDataRange().getValues();
  var hasExistingRows = existingData.length > 1;

  tab.getRange(1, 1, 1, 3).setValues([['Column Name', 'Policy', 'Notes']]);

  var headerRange = tab.getRange(1, 1, 1, 3);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#e8eaf6');
  tab.setFrozenRows(1);

  tab.getRange(1, 1).setNote(
    'Controls Pull Data operations into the master.\n\n' +
    'Policy values:\n' +
    '• fill_blank: write captain value only when master is blank\n' +
    '• overwrite: replace master value when captain has a non-blank value\n' +
    '• conflict: log differences without writing\n' +
    '• never: never pull this column\n\n' +
    'Unlisted columns default to conflict. resident_id is always protected.'
  );

  if (!hasExistingRows) {
    var examples = [
      ['resident_id', 'never', 'Protected identity column; always forced to never.'],
      ['ZoneName', 'conflict', 'Review zone differences instead of changing master automatically.'],
      ['Resident Name', 'fill_blank', 'Fill missing master names but do not replace existing values.'],
      ['Damage', 'overwrite', 'Example captain-owned field; change to match your real policy.'],
      ['Person Notes', 'overwrite', 'Example notes field entered by captains.']
    ];
    tab.getRange(2, 1, examples.length, 3).setValues(examples);
  }

  tab.setColumnWidth(1, 240);
  tab.setColumnWidth(2, 140);
  tab.setColumnWidth(3, 520);
  tab.getRange(2, 3, Math.max(tab.getMaxRows() - 1, 1), 1).setWrap(true);
}

/**
 * Creates the Workflow Presets tab used by the guided sidebar. Existing
 * workflow rows are preserved; a sales import preset is added only when the
 * tab has no presets yet.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss
 */
function setupWorkflowPresetsTab_(ss) {
  var tab = ss.getSheetByName('Workflow Presets');
  if (!tab) tab = ss.insertSheet('Workflow Presets');

  var headers = [
    'Workflow ID',
    'Workflow Name',
    'Operation',
    'Enabled',
    'Source Spreadsheet',
    'Source Tab',
    'Master Spreadsheet',
    'Match Column',
    'Column Mappings',
    'Notes',
    'Column Policies',
    'User Sheets Folder',
    'User Sheet'
  ];

  var existingData = tab.getDataRange().getValues();
  var hasExistingRows = existingData.length > 1 && String(existingData[1][0] || existingData[1][1] || '').trim() !== '';

  tab.getRange(1, 1, 1, headers.length).setValues([headers]);
  var headerRange = tab.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#e8eaf6');
  tab.setFrozenRows(1);

  tab.getRange(1, 9).setNote(
    'One mapping per line. Use either:\n\n' +
    'Header To Add\n' +
    'or\n' +
    'Source Header -> Target Header\n' +
    'or\n' +
    'Source Header | Target Header\n\n' +
    'For Add Columns and Delete Columns workflows, a single header name is enough.'
  );
  tab.getRange(1, 11).setNote(
    'One policy per line. Use:\n\n' +
    'Column Header -> policy\n\n' +
    'Supported policies:\n' +
    'fill_blank: write only when target is blank\n' +
    'overwrite: replace differing non-blank target values\n' +
    'conflict: log differences without writing\n' +
    'never: skip the column\n\n' +
    'Dry Run shows proposed overwrites before a live run writes them.'
  );

  if (!hasExistingRows) {
    var settings = readMergeConfig_(ss);
    var salesMappings = [
      'Address - Sold Since Fire -> Address - Sold Since Fire',
      'Sales History -> Sales History',
      'Latest Sale Date -> Latest Sale Date',
      'Latest Sale Price -> Latest Sale Price',
      'Latest New Owner -> Latest New Owner'
    ].join('\n');
    var salesPolicies = [
      'Address - Sold Since Fire -> overwrite',
      'Sales History -> overwrite',
      'Latest Sale Date -> overwrite',
      'Latest Sale Price -> overwrite',
      'Latest New Owner -> overwrite'
    ].join('\n');
    var dashboardMappings = [
      'Address - Sold Since Fire -> Address - Sold Since Fire',
      'Sales History -> Sales History'
    ].join('\n');
    var dashboardPolicies = [
      'Address - Sold Since Fire -> overwrite',
      'Sales History -> overwrite'
    ].join('\n');

    tab.getRange(2, 1, 11, headers.length).setValues([
      [
        'sales-import',
        'Update Master From Sales Tracker',
        'import_to_master',
        'Yes',
        settings.sourceId || '',
        settings.sourceTabName || 'Sales Rollup by APN',
        settings.masterId || '',
        settings.matchColumn || 'APN',
        salesMappings,
        'Imports the one-row-per-APN sales rollup into the master. Start with Dry Run.',
        salesPolicies,
        '',
        ''
      ],
      [
        'push-dashboard-fields',
        'Push Dashboard Fields to Captain Sheets',
        'push_to_folder',
        'Yes',
        '',
        '',
        settings.masterId || '',
        settings.matchColumn || 'APN',
        dashboardMappings,
        'Pushes dashboard-facing fields from master to every captain sheet in the folder. Start with Dry Run.',
        dashboardPolicies,
        settings.folderId || '',
        ''
      ],
      [
        'push-missing-residents',
        'Push Missing Residents to Captain Sheets',
        'push_missing_rows_to_folder',
        'Yes',
        '',
        '',
        settings.masterId || '',
        'resident_id',
        '',
        'Appends master residents missing from each captain sheet by detected ZoneName. Existing captain rows are never modified.',
        '',
        settings.folderId || '',
        ''
      ],
      [
        'push-missing-residents-one-sheet',
        'Push Missing Residents to One Captain Sheet',
        'push_missing_rows_to_user_sheet',
        'Yes',
        '',
        '',
        settings.masterId || '',
        'resident_id',
        '',
        'Appends master residents missing from the configured User Sheet by detected ZoneName. Existing captain rows are never modified.',
        '',
        '',
        settings.userSheetId || ''
      ],
      [
        'pull-captain-data',
        'Pull Captain Data Into Master',
        'pull_data_from_folder',
        'Yes',
        '',
        '',
        settings.masterId || '',
        'resident_id',
        '',
        'Pulls captain-entered values into master using the Pull Column Policy tab. Start with Dry Run.',
        '',
        settings.folderId || '',
        ''
      ],
      [
        'pull-missing-captain-rows',
        'Pull Missing Captain Rows Into Master',
        'pull_missing_rows_from_folder',
        'Yes',
        '',
        '',
        settings.masterId || '',
        'resident_id',
        '',
        'Appends captain-created resident rows that do not already exist in master. Existing master rows are never modified.',
        '',
        settings.folderId || '',
        ''
      ],
      [
        'add-columns-user-sheet',
        'Add Columns to One Captain Sheet',
        'add_columns_to_user_sheet',
        'Yes',
        '',
        '',
        '',
        '',
        '',
        'Adds configured row-1 headers to the single User Sheet setting. Fill Column Mappings with one header per line, then start with Dry Run.',
        '',
        '',
        settings.userSheetId || ''
      ],
      [
        'add-columns-folder',
        'Add Columns to Captain Sheets Folder',
        'add_columns_to_folder',
        'Yes',
        '',
        '',
        '',
        '',
        '',
        'Adds configured row-1 headers across every captain sheet in the folder. Fill Column Mappings with one header per line, then start with Dry Run.',
        '',
        settings.folderId || '',
        ''
      ],
      [
        'delete-columns-user-sheet',
        'Delete Columns from One Captain Sheet',
        'delete_columns_from_user_sheet',
        'Yes',
        '',
        '',
        '',
        '',
        '',
        'Deletes configured columns from the single User Sheet setting, including all data in those columns. Fill Column Mappings with one header per line, then start with Dry Run.',
        '',
        '',
        settings.userSheetId || ''
      ],
      [
        'delete-columns-folder',
        'Delete Columns from Captain Sheets Folder',
        'delete_columns_from_folder',
        'Yes',
        '',
        '',
        '',
        '',
        '',
        'Deletes configured columns across every captain sheet in the folder, including all data in those columns. Fill Column Mappings with one header per line, then start with Dry Run.',
        '',
        settings.folderId || '',
        ''
      ],
      [
        'rename-captain-column',
        'Rename Column Across Captain Sheets',
        'rename_columns_in_folder',
        'Yes',
        '',
        '',
        '',
        '',
        '',
        'Renames one row-1 header across every captain sheet using Settings values. Dry Run is required for review before live changes.',
        '',
        settings.folderId || '',
        ''
      ]
    ]);
  } else {
    seedDefaultSalesImportPolicies_(tab);
    seedDefaultDashboardPushWorkflow_(tab, ss);
    seedDefaultAdditionalSidebarWorkflows_(tab, ss);
  }

  tab.setColumnWidth(1, 150);
  tab.setColumnWidth(2, 260);
  tab.setColumnWidth(3, 160);
  tab.setColumnWidth(4, 90);
  tab.setColumnWidth(5, 280);
  tab.setColumnWidth(6, 190);
  tab.setColumnWidth(7, 280);
  tab.setColumnWidth(8, 130);
  tab.setColumnWidth(9, 360);
  tab.setColumnWidth(10, 360);
  tab.setColumnWidth(11, 320);
  tab.setColumnWidth(12, 280);
  tab.setColumnWidth(13, 280);
  tab.getRange(2, 9, Math.max(tab.getMaxRows() - 1, 1), 5).setWrap(true);
}

/**
 * Adds default overwrite policies to an existing sales-import preset when the
 * new Column Policies column is blank.
 *
 * @param {SpreadsheetApp.Sheet} tab
 */
function seedDefaultSalesImportPolicies_(tab) {
  var data = tab.getDataRange().getValues();
  if (data.length < 2) return;

  var headers = data[0].map(function (h) { return String(h).trim(); });
  var idCol = headers.indexOf('Workflow ID');
  var nameCol = headers.indexOf('Workflow Name');
  var policyCol = headers.indexOf('Column Policies');
  if (policyCol === -1) return;

  var defaultPolicies = [
    'Address - Sold Since Fire -> overwrite',
    'Sales History -> overwrite',
    'Latest Sale Date -> overwrite',
    'Latest Sale Price -> overwrite',
    'Latest New Owner -> overwrite'
  ].join('\n');

  for (var r = 1; r < data.length; r++) {
    var id = idCol === -1 ? '' : String(data[r][idCol] || '').trim();
    var name = nameCol === -1 ? '' : String(data[r][nameCol] || '').trim();
    var policies = String(data[r][policyCol] || '').trim();
    if (policies === '' && (id === 'sales-import' || name === 'Update Master From Sales Tracker')) {
      tab.getRange(r + 1, policyCol + 1).setValue(defaultPolicies);
    }
  }
}

/**
 * Adds the dashboard push workflow to existing preset tabs if it is missing.
 *
 * @param {SpreadsheetApp.Sheet} tab
 * @param {SpreadsheetApp.Spreadsheet} ss
 */
function seedDefaultDashboardPushWorkflow_(tab, ss) {
  var data = tab.getDataRange().getValues();
  var headers = data[0].map(function (h) { return String(h).trim(); });
  var idCol = headers.indexOf('Workflow ID');
  if (idCol === -1) return;

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol] || '').trim() === 'push-dashboard-fields') return;
  }

  var settings = readMergeConfig_(ss);
  var dashboardMappings = [
    'Address - Sold Since Fire -> Address - Sold Since Fire',
    'Sales History -> Sales History'
  ].join('\n');
  var dashboardPolicies = [
    'Address - Sold Since Fire -> overwrite',
    'Sales History -> overwrite'
  ].join('\n');

  var rowByHeader = {
    'Workflow ID': 'push-dashboard-fields',
    'Workflow Name': 'Push Dashboard Fields to Captain Sheets',
    'Operation': 'push_to_folder',
    'Enabled': 'Yes',
    'Master Spreadsheet': settings.masterId || '',
    'Match Column': settings.matchColumn || 'APN',
    'Column Mappings': dashboardMappings,
    'Notes': 'Pushes dashboard-facing fields from master to every captain sheet in the folder. Start with Dry Run.',
    'Column Policies': dashboardPolicies,
    'User Sheets Folder': settings.folderId || ''
  };

  var row = [];
  for (var c = 0; c < headers.length; c++) {
    row.push(rowByHeader[headers[c]] || '');
  }
  tab.getRange(tab.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
}

/**
 * Adds the remaining guided sidebar workflows to existing preset tabs if they
 * are missing.
 *
 * @param {SpreadsheetApp.Sheet} tab
 * @param {SpreadsheetApp.Spreadsheet} ss
 */
function seedDefaultAdditionalSidebarWorkflows_(tab, ss) {
  var settings = readMergeConfig_(ss);
  appendWorkflowPresetIfMissing_(tab, {
    'Workflow ID': 'push-missing-residents',
    'Workflow Name': 'Push Missing Residents to Captain Sheets',
    'Operation': 'push_missing_rows_to_folder',
    'Enabled': 'Yes',
    'Master Spreadsheet': settings.masterId || '',
    'Match Column': 'resident_id',
    'Notes': 'Appends master residents missing from each captain sheet by detected ZoneName. Existing captain rows are never modified.',
    'User Sheets Folder': settings.folderId || ''
  });
  appendWorkflowPresetIfMissing_(tab, {
    'Workflow ID': 'push-missing-residents-one-sheet',
    'Workflow Name': 'Push Missing Residents to One Captain Sheet',
    'Operation': 'push_missing_rows_to_user_sheet',
    'Enabled': 'Yes',
    'Master Spreadsheet': settings.masterId || '',
    'Match Column': 'resident_id',
    'Notes': 'Appends master residents missing from the configured User Sheet by detected ZoneName. Existing captain rows are never modified.',
    'User Sheet': settings.userSheetId || ''
  });
  appendWorkflowPresetIfMissing_(tab, {
    'Workflow ID': 'pull-captain-data',
    'Workflow Name': 'Pull Captain Data Into Master',
    'Operation': 'pull_data_from_folder',
    'Enabled': 'Yes',
    'Master Spreadsheet': settings.masterId || '',
    'Match Column': 'resident_id',
    'Notes': 'Pulls captain-entered values into master using the Pull Column Policy tab. Start with Dry Run.',
    'User Sheets Folder': settings.folderId || ''
  });
  appendWorkflowPresetIfMissing_(tab, {
    'Workflow ID': 'pull-missing-captain-rows',
    'Workflow Name': 'Pull Missing Captain Rows Into Master',
    'Operation': 'pull_missing_rows_from_folder',
    'Enabled': 'Yes',
    'Master Spreadsheet': settings.masterId || '',
    'Match Column': 'resident_id',
    'Notes': 'Appends captain-created resident rows that do not already exist in master. Existing master rows are never modified.',
    'User Sheets Folder': settings.folderId || ''
  });
  appendWorkflowPresetIfMissing_(tab, {
    'Workflow ID': 'add-columns-user-sheet',
    'Workflow Name': 'Add Columns to One Captain Sheet',
    'Operation': 'add_columns_to_user_sheet',
    'Enabled': 'Yes',
    'Notes': 'Adds configured row-1 headers to the single User Sheet setting. Fill Column Mappings with one header per line, then start with Dry Run.',
    'User Sheet': settings.userSheetId || ''
  });
  appendWorkflowPresetIfMissing_(tab, {
    'Workflow ID': 'add-columns-folder',
    'Workflow Name': 'Add Columns to Captain Sheets Folder',
    'Operation': 'add_columns_to_folder',
    'Enabled': 'Yes',
    'Notes': 'Adds configured row-1 headers across every captain sheet in the folder. Fill Column Mappings with one header per line, then start with Dry Run.',
    'User Sheets Folder': settings.folderId || ''
  });
  appendWorkflowPresetIfMissing_(tab, {
    'Workflow ID': 'delete-columns-user-sheet',
    'Workflow Name': 'Delete Columns from One Captain Sheet',
    'Operation': 'delete_columns_from_user_sheet',
    'Enabled': 'Yes',
    'Notes': 'Deletes configured columns from the single User Sheet setting, including all data in those columns. Fill Column Mappings with one header per line, then start with Dry Run.',
    'User Sheet': settings.userSheetId || ''
  });
  appendWorkflowPresetIfMissing_(tab, {
    'Workflow ID': 'delete-columns-folder',
    'Workflow Name': 'Delete Columns from Captain Sheets Folder',
    'Operation': 'delete_columns_from_folder',
    'Enabled': 'Yes',
    'Notes': 'Deletes configured columns across every captain sheet in the folder, including all data in those columns. Fill Column Mappings with one header per line, then start with Dry Run.',
    'User Sheets Folder': settings.folderId || ''
  });
  appendWorkflowPresetIfMissing_(tab, {
    'Workflow ID': 'rename-captain-column',
    'Workflow Name': 'Rename Column Across Captain Sheets',
    'Operation': 'rename_columns_in_folder',
    'Enabled': 'Yes',
    'Notes': 'Renames one row-1 header across every captain sheet using Settings values. Dry Run is required for review before live changes.',
    'User Sheets Folder': settings.folderId || ''
  });
}

/**
 * @param {SpreadsheetApp.Sheet} tab
 * @param {Object} rowByHeader
 */
function appendWorkflowPresetIfMissing_(tab, rowByHeader) {
  var data = tab.getDataRange().getValues();
  if (data.length === 0) return;
  var headers = data[0].map(function (h) { return String(h).trim(); });
  var idCol = headers.indexOf('Workflow ID');
  if (idCol === -1) return;

  var wantedId = String(rowByHeader['Workflow ID'] || '').trim();
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol] || '').trim() === wantedId) return;
  }

  var row = [];
  for (var c = 0; c < headers.length; c++) {
    row.push(rowByHeader[headers[c]] || '');
  }
  tab.getRange(tab.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
}
