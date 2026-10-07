/**
 * Popup расширения: настройки выгрузки, дерево дочерних страниц, прогресс.
 */
(function () {
  'use strict';

  const CONTENT_FILES = [
    'lib/zip.js',
    'lib/converter.js',
    'lib/markdown-importer.js',
    'lib/confluence-api.js',
    'content/content.js'
  ];
  const SETTINGS_KEY = 'mdExporterSettings';

  const el = {};
  let tabId = null;
  let pageInfo = null;
  let treeNodes = [];
  let treeErrors = [];
  let treeLoaded = false;
  let treeLoading = false;
  let treeIndex = new Map();
  let checkboxEls = new Map();
  let running = false;
  let importing = false;

  function cacheElements() {
    [
      'refresh', 'exportTab', 'importTab', 'exportPanel', 'importPanel',
      'alert', 'settings', 'treeBlock', 'tree',
      'treeInfo', 'selectAll', 'selectNone', 'settingsAttachments', 'attachments',
      'outputHint', 'download', 'cancel', 'progressBlock', 'progressFill',
      'progressText', 'errorsToggle', 'errors', 'importCard', 'markdownFile',
      'importButton', 'importStatus',
      'importCodeMacro', 'importCodeTitle', 'importCodeLanguage', 'importExpandMacro',
      'importExpandTitle', 'importPlantUmlMacro'
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
  }

  function showAlert(text) {
    if (!text) {
      el.alert.classList.add('hidden');
      el.alert.textContent = '';
      return;
    }
    el.alert.textContent = text;
    el.alert.classList.remove('hidden');
  }

  function currentMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : 'page';
  }

  function currentImportMode() {
    const checked = document.querySelector('input[name="importMode"]:checked');
    return checked ? checked.value : 'append';
  }

  function getImportMacroOptions() {
    return {
      codeMacro: el.importCodeMacro.checked,
      codeMacroTitle: el.importCodeTitle.checked,
      codeLanguage: el.importCodeLanguage.checked,
      codeExpand: el.importExpandMacro.checked,
      codeExpandTitle: el.importExpandTitle.checked,
      plantUmlMacro: el.importPlantUmlMacro.checked
    };
  }

  function updateMacroOptionControls() {
    el.importCodeTitle.disabled = !el.importCodeMacro.checked;
    el.importCodeLanguage.disabled = !el.importCodeMacro.checked;
    el.importExpandTitle.disabled = !el.importExpandMacro.checked;
  }

  function selectView(name) {
    const isExport = name === 'export';
    el.exportTab.setAttribute('aria-selected', String(isExport));
    el.exportTab.tabIndex = isExport ? 0 : -1;
    el.importTab.setAttribute('aria-selected', String(!isExport));
    el.importTab.tabIndex = isExport ? -1 : 0;
    el.exportPanel.classList.toggle('hidden', !isExport);
    el.importPanel.classList.toggle('hidden', isExport);
    el.importPanel.hidden = isExport;
  }

  function setImportStatus(text, type) {
    el.importStatus.textContent = text || '';
    el.importStatus.className = 'import-status' + (type ? ' ' + type : '') + (text ? '' : ' hidden');
  }

  function updateImportControls() {
    if (!el.importButton) return;
    const file = el.markdownFile.files && el.markdownFile.files[0];
    el.importButton.disabled = !pageInfo || !file || importing || running;
    el.download.disabled = !pageInfo || running || importing;
  }

  function jobStorageKey() {
    return 'job:' + tabId;
  }

  function sendToTab(message) {
    return new Promise(function (resolve) {
      if (tabId == null) {
        resolve({ ok: false, error: 'Не удалось определить активную вкладку' });
        return;
      }
      try {
        chrome.tabs.sendMessage(tabId, message, function (response) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'Пустой ответ страницы' });
        });
      } catch (error) {
        resolve({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    });
  }

  async function ensureContentScript() {
    const ping = await sendToTab({ type: 'PING' });
    if (ping && ping.ok) return ping;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: CONTENT_FILES
      });
    } catch (error) {
      return {
        ok: false,
        error: 'Нет доступа к странице. Откройте страницу Confluence в текущей вкладке и нажмите на иконку расширения снова.'
      };
    }
    return await sendToTab({ type: 'PING' });
  }

  function loadSettings() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(SETTINGS_KEY, function (data) {
        const stored = data && data[SETTINGS_KEY] ? data[SETTINGS_KEY] : {};
        document.querySelector('input[name="mode"][value="' + (stored.mode === 'tree' ? 'tree' : 'page') + '"]').checked = true;
        el.attachments.checked = stored.includeAttachments !== false;
        const savedMacroOptions = stored.importMacroOptions || {};
        const macroOptionElements = {
          codeMacro: el.importCodeMacro,
          codeMacroTitle: el.importCodeTitle,
          codeLanguage: el.importCodeLanguage,
          codeExpand: el.importExpandMacro,
          codeExpandTitle: el.importExpandTitle,
          plantUmlMacro: el.importPlantUmlMacro
        };
        Object.keys(macroOptionElements).forEach(function (key) {
          if (typeof savedMacroOptions[key] === 'boolean') {
            macroOptionElements[key].checked = savedMacroOptions[key];
          }
        });
        updateMacroOptionControls();
        resolve();
      });
    });
  }

  function saveSettings() {
    const payload = {};
    payload[SETTINGS_KEY] = {
      mode: currentMode(),
      includeAttachments: el.attachments.checked,
      importMacroOptions: getImportMacroOptions()
    };
    chrome.storage.local.set(payload);
  }

  function markSelected(nodes) {
    return (nodes || []).map(function (node) {
      return {
        id: String(node.id),
        title: node.title || '',
        selected: true,
        children: markSelected(node.children)
      };
    });
  }

  function serializeTree(nodes) {
    return (nodes || []).map(function (node) {
      return {
        id: node.id,
        title: node.title,
        selected: node.selected !== false,
        children: serializeTree(node.children)
      };
    });
  }

  function setSubtreeState(node, selected) {
    node.selected = selected;
    const box = checkboxEls.get(node.id);
    if (box) box.checked = selected;
    for (const child of node.children || []) setSubtreeState(child, selected);
  }

  function countSelected(nodes) {
    let total = 0;
    for (const node of nodes || []) {
      if (node.selected !== false) total += 1;
      total += countSelected(node.children);
    }
    return total;
  }

  function updateOutputHint() {
    const mode = currentMode();
    const selectedChildren = mode === 'tree' ? countSelected(treeNodes) : 0;
    const pages = 1 + selectedChildren;
    const withAttachments = el.attachments.checked;
    let text = '';
    if (pages === 1) {
      text = 'Будет скачан один файл <b>' + escapeHtml(safeName(pageInfo ? pageInfo.title : 'Страница')) + '.md</b>';
      if (withAttachments) text += ' и архив <b>-attachments.zip</b> с папкой attachments, если вложения есть';
      text += '.';
      text += ' Если Chrome спросит про скачивание нескольких файлов, разрешите его.';
    } else {
      text = 'Будет скачан архив <b>' + escapeHtml(safeName(pageInfo ? pageInfo.title : 'Страница')) + '.zip</b>'
        + ' со структурой папок как в Confluence (' + pages + ' стр.).';
      if (!withAttachments) text += ' Вложения не выгружаются: ссылки на них ведут в Confluence.';
    }
    el.outputHint.innerHTML = text;
    el.outputHint.classList.remove('hidden');
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function safeName(value) {
    return String(value || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Страница';
  }

  function renderTree(response) {
    treeIndex = new Map();
    checkboxEls = new Map();
    const fragment = document.createDocumentFragment();

    (function walk(nodes, depth) {
      for (const node of nodes) {
        treeIndex.set(node.id, node);
        const row = document.createElement('label');
        row.className = 'tree-row';
        row.style.paddingLeft = (8 + depth * 14) + 'px';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = node.selected !== false;

        const title = document.createElement('span');
        title.textContent = node.title || ('page-' + node.id);
        title.title = title.textContent;

        checkbox.addEventListener('change', function () {
          setSubtreeState(node, checkbox.checked);
          updateTreeInfo();
          updateOutputHint();
        });

        row.appendChild(checkbox);
        row.appendChild(title);
        fragment.appendChild(row);
        checkboxEls.set(node.id, checkbox);

        if (node.children && node.children.length) walk(node.children, depth + 1);
      }
    })(treeNodes, 0);

    el.tree.innerHTML = '';
    el.tree.appendChild(fragment);
    updateTreeInfo(response);
  }

  function updateTreeInfo(response) {
    const selected = countSelected(treeNodes);
    const parts = ['Отмечено: ' + (selected + 1) + ' стр. (включая текущую)'];
    if (response && response.truncated) {
      parts.push('Структура показана частично: ' + response.total + ' стр.');
    }
    const errors = response && Array.isArray(response.errors) ? response.errors : treeErrors;
    if (errors.length) parts.push('Не удалось загрузить ветки: ' + errors.length);
    el.treeInfo.textContent = parts.join(' · ');
  }

  async function loadTree() {
    if (treeLoading || treeLoaded) return;
    treeLoading = true;
    el.tree.innerHTML = '<div class="muted">Загрузка структуры…</div>';
    const response = await sendToTab({ type: 'LOAD_TREE' });
    treeLoading = false;
    if (!response || !response.ok) {
      treeErrors = [];
      el.tree.innerHTML = '<div class="muted">Не удалось загрузить структуру страниц</div>';
      el.treeInfo.textContent = '';
      showAlert((response && response.error) || 'Не удалось загрузить структуру страниц');
      return;
    }
    showAlert(null);
    treeNodes = markSelected(response.tree);
    treeErrors = Array.isArray(response.errors) ? response.errors : [];
    treeLoaded = true;
    renderTree(response);
    updateOutputHint();
  }

  async function refreshPage() {
    showAlert(null);
    const response = await sendToTab({ type: 'PREPARE' });
    if (!response || !response.ok) {
      pageInfo = null;
      el.settings.classList.add('hidden');
      el.settingsAttachments.classList.add('hidden');
      el.importCard.classList.add('hidden');
      el.outputHint.classList.add('hidden');
      el.download.disabled = true;
      showAlert((response && response.error) || 'Не удалось прочитать страницу Confluence');
      return;
    }
    pageInfo = response.page;
    el.settings.classList.remove('hidden');
    el.settingsAttachments.classList.remove('hidden');
    el.importCard.classList.remove('hidden');
    updateImportControls();
    updateOutputHint();
    if (currentMode() === 'tree') await loadTree();
  }

  function setFill(percent) {
    el.progressFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  }

  function renderErrors(errors) {
    const list = errors || [];
    if (!list.length) {
      el.errorsToggle.classList.add('hidden');
      el.errors.classList.add('hidden');
      el.errors.innerHTML = '';
      return;
    }
    el.errorsToggle.classList.remove('hidden');
    el.errorsToggle.textContent = 'Показать замечания (' + list.length + ')';
    el.errors.innerHTML = '';
    for (const item of list) {
      const li = document.createElement('li');
      li.textContent = item;
      el.errors.appendChild(li);
    }
  }

  function applyJob(job) {
    if (!job) return;
    running = job.state === 'running';
    el.progressBlock.classList.remove('hidden');
    el.cancel.classList.toggle('hidden', !running);
    el.download.disabled = running;

    const total = job.total || 0;
    const current = job.current || 0;
    let percent = 8;
    if (job.state === 'done') percent = 100;
    else if (total > 0) percent = Math.round((current / total) * 100);
    setFill(percent);
    el.progressFill.classList.toggle('indeterminate', job.state === 'running' && total === 0);

    let text = job.message || '';
    if (job.state === 'running' && total > 0) text = (job.message ? job.message + ' · ' : '') + current + '/' + total;
    el.progressText.textContent = text;
    renderErrors(job.errors);
    updateImportControls();
  }

  function resetJobView() {
    el.progressBlock.classList.add('hidden');
    el.cancel.classList.add('hidden');
    el.progressFill.classList.remove('indeterminate');
    setFill(0);
    el.progressText.textContent = '';
    renderErrors([]);
    running = false;
    updateImportControls();
  }

  async function loadJobState() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(jobStorageKey(), function (data) {
        const job = data ? data[jobStorageKey()] : null;
        if (job && job.state === 'running' && Date.now() - (job.startedAt || 0) > 30 * 60 * 1000) {
          job.state = 'error';
          job.message = 'Экспорт был прерван (вкладка закрыта или страница перезагружена). Запустите выгрузку снова.';
        }
        if (job) applyJob(job);
        else resetJobView();
        resolve();
      });
    });
  }

  async function onDownload() {
    if (!pageInfo || importing) return;
    showAlert(null);
    saveSettings();
    const options = {
      includeAttachments: el.attachments.checked,
      tree: currentMode() === 'tree' ? serializeTree(treeNodes) : [],
      treeErrors: currentMode() === 'tree' ? treeErrors : []
    };
    running = true;
    updateImportControls();
    el.download.disabled = true;
    el.progressBlock.classList.remove('hidden');
    el.cancel.classList.remove('hidden');
    el.progressText.textContent = 'Запуск выгрузки…';
    setFill(8);
    el.progressFill.classList.add('indeterminate');

    const response = await sendToTab({ type: 'START', options: options });
    if (!response || !response.ok) {
      if (response && response.job) {
        applyJob(response.job);
        return;
      }
      running = false;
      el.cancel.classList.add('hidden');
      updateImportControls();
      el.progressBlock.classList.add('hidden');
      showAlert((response && response.error) || 'Не удалось запустить выгрузку');
      return;
    }
    if (response.job) applyJob(response.job);
  }

  async function onCancel() {
    await sendToTab({ type: 'CANCEL' });
    el.progressText.textContent = 'Отмена…';
  }

  async function onImportMarkdown() {
    if (importing || !pageInfo) return;
    const file = el.markdownFile.files && el.markdownFile.files[0];
    if (!file) {
      setImportStatus('Выберите Markdown-файл.', 'error');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setImportStatus('Файл слишком большой. Максимальный размер: 2 МБ.', 'error');
      return;
    }

    importing = true;
    updateImportControls();
    setImportStatus('Чтение файла и сохранение страницы…');
    try {
      const markdown = await file.text();
      const response = await sendToTab({
        type: 'IMPORT_MD',
        markdown: markdown,
        mode: currentImportMode(),
        macroOptions: getImportMacroOptions()
      });
      if (!response || !response.ok) {
        setImportStatus((response && response.error) || 'Не удалось импортировать Markdown.', 'error');
        return;
      }
      setImportStatus(response.message || 'Markdown импортирован в Confluence.', 'success');
    } catch (error) {
      setImportStatus(error && error.message ? error.message : String(error), 'error');
    } finally {
      importing = false;
      updateImportControls();
    }
  }

  function bindEvents() {
    const tabs = [el.exportTab, el.importTab];
    for (const tab of tabs) {
      tab.addEventListener('click', function () {
        selectView(tab.dataset.panel);
      });
      tab.addEventListener('keydown', function (event) {
        let nextIndex = -1;
        const currentIndex = tabs.indexOf(tab);
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex < 0) return;
        event.preventDefault();
        tabs[nextIndex].focus();
        selectView(tabs[nextIndex].dataset.panel);
      });
    }

    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener('change', function () {
        const mode = currentMode();
        el.treeBlock.classList.toggle('hidden', mode !== 'tree');
        saveSettings();
        updateOutputHint();
        if (mode === 'tree') loadTree();
      });
    }

    el.attachments.addEventListener('change', function () {
      saveSettings();
      updateOutputHint();
    });

    el.selectAll.addEventListener('click', function () {
      for (const node of treeNodes) setSubtreeState(node, true);
      updateTreeInfo();
      updateOutputHint();
    });

    el.selectNone.addEventListener('click', function () {
      for (const node of treeNodes) setSubtreeState(node, false);
      updateTreeInfo();
      updateOutputHint();
    });

    el.download.addEventListener('click', onDownload);
    el.cancel.addEventListener('click', onCancel);
    el.markdownFile.addEventListener('change', function () {
      setImportStatus('');
      updateImportControls();
    });
    for (const radio of document.querySelectorAll('input[name="importMode"]')) {
      radio.addEventListener('change', function () {
        updateImportControls();
      });
    }
    el.importButton.addEventListener('click', onImportMarkdown);
    [
      el.importCodeMacro, el.importCodeTitle, el.importCodeLanguage, el.importExpandMacro,
      el.importExpandTitle, el.importPlantUmlMacro
    ].forEach(function (input) {
      input.addEventListener('change', function () {
        updateMacroOptionControls();
        saveSettings();
      });
    });
    el.refresh.addEventListener('click', async function () {
      treeLoaded = false;
      treeNodes = [];
      treeErrors = [];
      await ensureContentScript();
      await refreshPage();
      await loadJobState();
    });
    el.errorsToggle.addEventListener('click', function () {
      const hidden = el.errors.classList.toggle('hidden');
      el.errorsToggle.textContent = el.errorsToggle.textContent.replace(/^(Показать|Скрыть)/, hidden ? 'Показать' : 'Скрыть');
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || tabId == null) return;
      const change = changes[jobStorageKey()];
      if (change && change.newValue) applyJob(change.newValue);
    });

    chrome.runtime.onMessage.addListener(function (message) {
      if (!message || message.type !== 'MD_EXPORT_JOB_UPDATE' || message.tabId !== tabId || !message.job) return;
      applyJob(message.job);
    });
  }

  async function init() {
    cacheElements();
    bindEvents();

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) {
      showAlert('Не удалось определить активную вкладку');
      return;
    }
    tabId = tab.id;

    await loadSettings();
    el.treeBlock.classList.toggle('hidden', currentMode() !== 'tree');

    const ping = await ensureContentScript();
    if (!ping || !ping.ok) {
      showAlert((ping && ping.error) || 'Нет доступа к странице. Откройте страницу Confluence и повторите попытку.');
      return;
    }
    await refreshPage();
    await loadJobState();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
