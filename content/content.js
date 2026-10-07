/**
 * Content script: экспортирует страницы Confluence в Markdown и импортирует
 * локальные Markdown-файлы обратно в storage format.
 *
 * Запускается из popup через chrome.scripting.executeScript (activeTab),
 * поэтому все запросы идут в контексте открытой страницы Confluence.
 */
(function () {
  'use strict';

  if (window.__mdExporterInjected) return;
  window.__mdExporterInjected = true;

  const Api = window.MDExporterApi;
  const Converter = window.MDExporterConverter;
  const Zip = window.MDExporterZip;
  const MarkdownImporter = window.MDExporterMarkdownImporter;

  let tabId = null;
  let running = false;
  let importing = false;
  let cancelRequested = false;
  let job = null;

  function jobKey() {
    return 'job:' + (tabId == null ? 'unknown' : tabId);
  }

  function errorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  function persist() {
    if (tabId == null || !job) return;
    const payload = {};
    payload[jobKey()] = job;
    try {
      chrome.storage.local.set(payload);
    } catch (e) { /* ignore */ }
  }

  function startJob(total, message) {
    job = {
      state: 'running',
      phase: 'prepare',
      message: message || 'Подготовка…',
      current: 0,
      total: total || 0,
      files: [],
      errors: [],
      startedAt: Date.now(),
      finishedAt: null
    };
    persist();
  }

  function report(patch) {
    if (!job) return;
    Object.assign(job, patch);
    persist();
  }

  function addError(text) {
    if (!job) return;
    if (job.errors.length < 100) job.errors.push(text);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function prepare() {
    const pageId = await Api.resolvePageIdFromUrl();
    if (!pageId) {
      return {
        ok: false,
        error: 'Не удалось определить страницу Confluence в активной вкладке. Откройте страницу Confluence и повторите попытку.'
      };
    }
    const page = await Api.getPage(pageId, ['version', 'space']);
    return {
      ok: true,
      page: {
        id: String(page.id),
        title: page.title || '',
        spaceKey: page.space && page.space.key ? page.space.key : '',
        version: page.version && page.version.number ? String(page.version.number) : '',
        url: Api.pageUrl(page, pageId)
      }
    };
  }

  async function loadTree() {
    const pageId = await Api.resolvePageIdFromUrl();
    if (!pageId) return { ok: false, error: 'Не удалось определить страницу Confluence в активной вкладке.' };
    const page = await Api.getPage(pageId, ['version']);
    const tree = await Api.buildTree(pageId, { rootTitle: page.title || '', maxPages: 3000 });
    return {
      ok: true,
      tree: tree.root.children,
      total: tree.total,
      truncated: tree.truncated,
      errors: tree.errors,
      root: { id: String(page.id), title: page.title || '' }
    };
  }

  function uniqueSegmentFactory() {
    const used = new Map();
    return function (parentKey, title, fallbackId) {
      let set = used.get(parentKey);
      if (!set) {
        set = new Set();
        used.set(parentKey, set);
      }
      const base = Converter.sanitizeFileName(title, 'page-' + fallbackId);
      let candidate = base;
      let index = 2;
      while (set.has(candidate.toLowerCase())) {
        candidate = base + ' (' + index + ')';
        index += 1;
      }
      set.add(candidate.toLowerCase());
      return candidate;
    };
  }

  function collectPages(root, tree) {
    const uniqueSegment = uniqueSegmentFactory();
    const pages = [];
    const rootPath = [uniqueSegment('#root', root.title, root.id)];
    pages.push({
      id: String(root.id),
      title: root.title || ('page-' + root.id),
      segments: rootPath,
      selected: true,
      isRoot: true
    });

    (function walk(children, parentPath) {
      const parentKey = parentPath.join('/');
      for (const child of children || []) {
        const segment = uniqueSegment(parentKey, child.title, child.id);
        const path = parentPath.concat(segment);
        pages.push({
          id: String(child.id),
          title: child.title || ('page-' + child.id),
          segments: path,
          selected: child.selected !== false,
          isRoot: false
        });
        if (child.children && child.children.length) walk(child.children, path);
      }
    })(tree, rootPath);

    return pages;
  }

  function relativeLink(fromSegments, target) {
    let common = 0;
    while (common < fromSegments.length && common < target.segments.length
      && fromSegments[common] === target.segments[common]) {
      common += 1;
    }
    const parts = [];
    for (let i = common; i < fromSegments.length; i++) parts.push('..');
    for (let i = common; i < target.segments.length; i++) parts.push(target.segments[i]);
    parts.push(target.fileName);
    return parts.map(function (part) {
      if (part === '..') return '..';
      return String(part).replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
    }).join('/');
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      link.remove();
      URL.revokeObjectURL(url);
    }, 120000);
  }

  async function importMarkdown(message) {
    if (running || importing) return { ok: false, error: 'Другая операция уже выполняется' };
    if (!MarkdownImporter) return { ok: false, error: 'Модуль импорта Markdown не загружен' };

    const mode = message && message.mode === 'replace' ? 'replace' : 'append';
    if (mode === 'replace' && message.confirmedReplace !== true) {
      return { ok: false, error: 'Для замены содержимого подтвердите действие в окне расширения' };
    }
    if (typeof (message && message.markdown) !== 'string') {
      return { ok: false, error: 'Не удалось прочитать содержимое Markdown-файла' };
    }

    importing = true;
    try {
      const pageId = await Api.resolvePageIdFromUrl();
      if (!pageId) throw new Error('Не удалось определить страницу Confluence в активной вкладке');
      const page = await Api.getPage(pageId, ['version', 'space']);
      const converted = MarkdownImporter.parseMarkdown(message.markdown, { pageTitle: page.title || '' });
      const saved = await Api.updatePage(pageId, converted.storage, mode);
      return {
        ok: true,
        page: saved,
        mode: mode,
        message: (mode === 'append' ? 'Содержимое добавлено в конец страницы «' : 'Содержимое страницы «')
          + (saved.title || page.title || pageId) + '» обновлено (версия ' + saved.version
          + '). Обновите вкладку, чтобы увидеть результат.'
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      importing = false;
    }
  }

  async function start(options) {
    if (running || importing) return { ok: false, error: 'Другая операция уже выполняется' };
    if (!Api || !Converter || !Zip) return { ok: false, error: 'Модули расширения не загружены' };

    running = true;
    cancelRequested = false;

    try {
      const pageId = await Api.resolvePageIdFromUrl();
      if (!pageId) throw new Error('Не удалось определить страницу Confluence в активной вкладке');

      startJob(0, 'Чтение страницы…');
      const rootPage = await Api.getPage(pageId, ['body.storage', 'version', 'space']);
      const rootTitle = rootPage.title || ('page-' + pageId);
      const spaceKey = rootPage.space && rootPage.space.key ? rootPage.space.key : '';

      const allPages = collectPages({ id: pageId, title: rootTitle }, Array.isArray(options.tree) ? options.tree : []);
      const pages = allPages.filter(function (page) { return page.selected; });
      if (!pages.length) throw new Error('Не выбрано ни одной страницы для экспорта');
      for (const treeError of (Array.isArray(options.treeErrors) ? options.treeErrors : [])) {
        const title = treeError && treeError.title ? ' «' + treeError.title + '»' : '';
        const detail = treeError && treeError.message ? ': ' + treeError.message : '';
        addError('Не удалось загрузить дочерние страницы' + title + detail);
      }

      const isMulti = pages.length > 1;
      const zip = isMulti ? new Zip.ZipWriter() : null;
      const attachmentZip = (!isMulti && options.includeAttachments) ? new Zip.ZipWriter() : null;

      const pageIndex = new Map();
      for (const page of pages) {
        pageIndex.set(page.id, {
          segments: page.segments,
          fileName: Converter.sanitizeFileName(page.title, 'page-' + page.id) + '.md',
          title: page.title
        });
      }

      report({
        total: pages.length,
        message: isMulti
          ? 'Страниц к выгрузке: ' + pages.length
          : 'Выгрузка одной страницы'
      });

      let singleMarkdown = null;
      let singleFileName = '';
      let attachmentsSaved = 0;

      for (let index = 0; index < pages.length; index++) {
        if (cancelRequested) {
          report({ state: 'cancelled', phase: 'cancelled', message: 'Экспорт отменен', finishedAt: Date.now() });
          return { ok: true, cancelled: true };
        }

        const item = pages[index];
        report({
          phase: 'page',
          current: index,
          message: 'Обработка: ' + item.title
        });

        const page = await Api.getPage(item.id, ['body.storage', 'version', 'space']);
        const storage = page.body && page.body.storage ? page.body.storage.value : '';
        const fileName = pageIndex.get(item.id).fileName;
        const currentSegments = item.segments;

        const attachmentLookup = new Map();
        const pendingAttachments = [];
        if (options.includeAttachments) {
          let attachments = [];
          try {
            attachments = await Api.getAttachments(item.id);
          } catch (error) {
            addError('Не удалось получить список вложений страницы «' + item.title + '»: ' + errorMessage(error));
          }
          const usedNames = new Set();
          for (const attachment of attachments) {
            if (cancelRequested) break;
            const base = Converter.sanitizeFileName(attachment.name, 'attachment');
            let safeName = base;
            let counter = 2;
            while (usedNames.has(safeName.toLowerCase())) {
              safeName = base + ' (' + counter + ')';
              counter += 1;
            }
            usedNames.add(safeName.toLowerCase());
            attachmentLookup.set(String(attachment.name).toLowerCase(), {
              name: attachment.name,
              safeName: safeName
            });
            pendingAttachments.push({ attachment: attachment, safeName: safeName });
          }
        }

        const converted = Converter.convert(storage, {
          pageTitle: item.title,
          pageUrl: Api.pageUrl(page, item.id),
          pageId: item.id,
          spaceKey: page.space && page.space.key ? page.space.key : spaceKey,
          version: page.version && page.version.number ? String(page.version.number) : '',
          baseUrl: Api.baseUrl(),
          absolutizeUrl: Api.absolutizeUrl,
          includeAttachments: !!options.includeAttachments,
          attachmentLookup: attachmentLookup,
          attachments: Array.from(attachmentLookup.values()),
          attachmentUrlBase: Api.attachmentUrlBase(item.id),
          frontMatter: true,
          resolvePageLink: function (ref) {
            const suffix = ref && ref.anchor ? '#' + ref.anchor : '';
            if (ref && ref.id) {
              const target = pageIndex.get(String(ref.id));
              if (target) return relativeLink(currentSegments, target) + suffix;
              return Api.baseUrl() + '/pages/viewpage.action?pageId=' + encodeURIComponent(ref.id) + suffix;
            }
            return null;
          }
        });

        if (converted.warnings && converted.warnings.length) {
          for (const warning of converted.warnings) {
            addError('Страница «' + item.title + '»: ' + warning);
          }
        }

        if (isMulti) {
          zip.add(currentSegments.join('/') + '/' + fileName, converted.markdown, { compress: true });
        } else {
          singleMarkdown = converted.markdown;
          singleFileName = fileName;
        }

        for (const entry of pendingAttachments) {
          if (cancelRequested) break;
          try {
            const file = await Api.fetchAttachmentBytes(entry.attachment);
            if (isMulti) {
              zip.add(currentSegments.join('/') + '/attachments/' + entry.safeName, file.bytes);
            } else {
              attachmentZip.add('attachments/' + entry.safeName, file.bytes);
            }
            attachmentsSaved += 1;
            report({ message: 'Обработка: ' + item.title + ' (вложения: ' + attachmentsSaved + ')' });
          } catch (error) {
            addError('Вложение «' + entry.attachment.name + '» на странице «' + item.title + '»: ' + errorMessage(error));
          }
        }

        report({ current: index + 1, message: 'Готово страниц: ' + (index + 1) + ' из ' + pages.length });
      }

      if (cancelRequested) {
        report({ state: 'cancelled', phase: 'cancelled', message: 'Экспорт отменен', finishedAt: Date.now() });
        return { ok: true, cancelled: true };
      }

      report({ phase: 'packing', message: 'Сборка файлов…' });

      if (isMulti) {
        const blob = await zip.buildBlob();
        const archiveName = Converter.sanitizeFileName(rootTitle, 'confluence-pages') + '.zip';
        downloadBlob(blob, archiveName);
        report({
          state: 'done',
          phase: 'done',
          current: pages.length,
          message: 'Готово: ' + pages.length + ' стр., архив ' + archiveName,
          files: [archiveName],
          finishedAt: Date.now()
        });
        return { ok: true, files: [archiveName], pages: pages.length };
      }

      const mdBlob = new Blob([singleMarkdown], { type: 'text/markdown;charset=utf-8' });
      downloadBlob(mdBlob, singleFileName);
      const files = [singleFileName];

      if (attachmentZip && attachmentZip.size > 0) {
        await sleep(400);
        const attachmentArchive = Converter.sanitizeFileName(rootTitle, 'attachments') + '-attachments.zip';
        downloadBlob(await attachmentZip.buildBlob(), attachmentArchive);
        files.push(attachmentArchive);
      }

      report({
        state: 'done',
        phase: 'done',
        current: 1,
        message: 'Готово: ' + files.join(', '),
        files: files,
        finishedAt: Date.now()
      });
      return { ok: true, files: files, pages: 1 };
    } catch (error) {
      const message = errorMessage(error);
      report({ state: 'error', phase: 'error', message: message, finishedAt: Date.now() });
      return { ok: false, error: message };
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (sender && sender.tab && sender.tab.id != null) tabId = sender.tab.id;
    if (!message || !message.type) return undefined;

    if (message.type === 'PING') {
      sendResponse({ ok: true, confluence: Api.looksLikeConfluence() });
      return undefined;
    }

    if (message.type === 'PREPARE') {
      prepare()
        .then(sendResponse)
        .catch(function (error) { sendResponse({ ok: false, error: errorMessage(error) }); });
      return true;
    }

    if (message.type === 'LOAD_TREE') {
      loadTree()
        .then(sendResponse)
        .catch(function (error) { sendResponse({ ok: false, error: errorMessage(error) }); });
      return true;
    }

    if (message.type === 'IMPORT_MD') {
      importMarkdown(message).then(sendResponse);
      return true;
    }

    if (message.type === 'START') {
      const options = message.options || {};
      if (running || importing) {
        sendResponse({ ok: false, error: 'Другая операция уже выполняется' });
        return undefined;
      }
      sendResponse({ ok: true, started: true });
      start(options);
      return undefined;
    }

    if (message.type === 'CANCEL') {
      cancelRequested = true;
      sendResponse({ ok: true });
      return undefined;
    }

    return undefined;
  });
})();
