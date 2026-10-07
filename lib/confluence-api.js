/**
 * Работа с REST API Confluence из content script.
 *
 * Все запросы идут из контекста страницы Confluence (same-origin), поэтому
 * используется уже открытая сессия пользователя и не нужны host permissions.
 *
 * Экспортирует window.MDExporterApi.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.MDExporterApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUEST_TIMEOUT_MS = 60000;

  function normalizeContextPath(value) {
    const path = String(value == null ? '' : value).trim();
    if (!path || path === '/') return '';
    const withoutTrailing = path.replace(/\/+$/, '');
    return withoutTrailing.charAt(0) === '/' ? withoutTrailing : '/' + withoutTrailing;
  }

  function getContextPath() {
    try {
      const meta = document.querySelector('meta[name="ajs-context-path"]');
      if (meta && meta.getAttribute('content')) return normalizeContextPath(meta.getAttribute('content'));
    } catch (e) { /* ignore */ }
    try {
      const baseMeta = document.querySelector('meta[name="ajs-base-url"]');
      if (baseMeta && baseMeta.getAttribute('content')) {
        const parsed = new URL(baseMeta.getAttribute('content'));
        if (parsed.pathname && parsed.pathname !== '/') return normalizeContextPath(parsed.pathname);
      }
    } catch (e) { /* ignore */ }
    if (location.pathname === '/wiki' || location.pathname.indexOf('/wiki/') === 0) return '/wiki';
    return '';
  }

  function looksLikeConfluence() {
    try {
      if (document.querySelector('meta[name="ajs-context-path"]')) return true;
      if (document.querySelector('meta[name="ajs-version-number"]')) return true;
      if (document.getElementById('com-atlassian-confluence')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function apiUrl(path) {
    return location.origin + getContextPath() + '/rest/api' + path;
  }

  function absolutizeUrl(url) {
    const value = String(url == null ? '' : url).trim();
    if (!value) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
    const contextPath = getContextPath();
    if (value.charAt(0) === '/') {
      if (contextPath && value.indexOf(contextPath + '/') !== 0 && value !== contextPath) {
        return location.origin + contextPath + value;
      }
      return location.origin + value;
    }
    return location.origin + contextPath + '/' + value;
  }

  async function requestJson(url, options) {
    const opts = options || {};
    let response;
    let text;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    try {
      response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
        headers: {
          'Accept': 'application/json',
          'X-Atlassian-Token': 'no-check'
        }
      });
      text = await response.text();
    } catch (error) {
      throw new Error('Не удалось обратиться к Confluence: ' + (error && error.message ? error.message : String(error)));
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Доступ запрещен (HTTP ' + response.status + '). Проверьте, что вы авторизованы в Confluence и имеете доступ к странице.');
    }
    if (response.status === 404) {
      throw new Error('Страница или API не найдены (HTTP 404). Проверьте адрес Confluence и права доступа.');
    }
    if (!response.ok) {
      throw new Error('Confluence вернул HTTP ' + response.status + (opts.label ? ' (' + opts.label + ')' : ''));
    }

    if (/^\s*<(?:!doctype|html)/i.test(text)) {
      throw new Error('Confluence вернул HTML вместо JSON. Вероятно, сессия истекла - обновите страницу и войдите заново.');
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error('Не удалось разобрать ответ Confluence как JSON');
    }
  }

  async function getPage(pageId, expand, version) {
    const expands = (expand && expand.length ? expand : ['body.storage', 'version', 'space']).join(',');
    const params = ['expand=' + encodeURIComponent(expands)];
    if (version != null) params.push('version=' + encodeURIComponent(String(version)));
    const url = apiUrl('/content/' + encodeURIComponent(pageId) + '?' + params.join('&'));
    return requestJson(url, { label: 'страница ' + pageId });
  }

  function readApiErrorDetails(result, responseText) {
    const messages = [];
    function add(value) {
      if (typeof value === 'string' && value.trim()) messages.push(value.trim());
      else if (value && typeof value === 'object') {
        if (typeof value.translation === 'string') messages.push(value.translation.trim());
        else if (typeof value.message === 'string') messages.push(value.message.trim());
        else if (value.message && typeof value.message.translation === 'string') messages.push(value.message.translation.trim());
      }
    }
    function addErrors(errors) {
      if (Array.isArray(errors)) errors.forEach(add);
      else add(errors);
    }

    if (result) {
      add(result.message);
      add(result.data && result.data.message);
      addErrors(result.errors);
      addErrors(result.data && result.data.errors);
    }
    return (messages.length ? messages.join(' | ') : String(responseText || ''))
      .replace(/\s+/g, ' ').trim().slice(0, 400);
  }

  function readServerCurrentVersion(result, responseText) {
    const message = [result && result.message, responseText || ''].filter(Boolean).join(' ');
    const match = message.match(/current version is:\s*(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  async function updatePage(pageId, storageValue, mode) {
    const prepend = mode === 'prepend';
    const importedStorage = String(storageValue || '');
    let serverCurrentVersion = null;
    let previousConflictDetail = '';

    // После конфликта перечитываем именно версию, которую назвал сервер.
    // Так тело storage и номер версии относятся к одному снимку страницы.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const page = await getPage(pageId, ['body.storage', 'version', 'space'], serverCurrentVersion);
      const currentVersion = page && page.version ? Number(page.version.number) : 0;
      if (!Number.isInteger(currentVersion) || currentVersion < 1) {
        throw new Error('Не удалось определить версию страницы для сохранения');
      }
      if (serverCurrentVersion != null && currentVersion < serverCurrentVersion) {
        throw new Error('Confluence сообщает текущую версию ' + serverCurrentVersion
          + ', но API чтения страницы возвращает версию ' + currentVersion + '. Повторная запись остановлена, '
          + 'чтобы не затереть содержимое более новой версии. Ответ API: ' + previousConflictDetail);
      }

      const currentStorage = page.body && page.body.storage ? page.body.storage.value || '' : '';
      if (attempt > 0) {
        const alreadyApplied = prepend
          ? currentStorage === importedStorage || currentStorage.startsWith(importedStorage + '\n')
          : currentStorage === importedStorage || currentStorage.endsWith('\n' + importedStorage);
        if (alreadyApplied) {
          return {
            id: String(page.id),
            title: page.title || '',
            version: currentVersion
          };
        }
      }

      const nextStorage = prepend
        ? (currentStorage ? importedStorage + '\n' + currentStorage : importedStorage)
        : (currentStorage ? currentStorage + '\n' + importedStorage : importedStorage);
      const payload = {
        id: String(page.id),
        type: page.type || 'page',
        title: page.title || '',
        space: page.space && page.space.key ? { key: page.space.key } : undefined,
        body: { storage: { value: nextStorage, representation: 'storage' } },
        version: { number: currentVersion + 1 }
      };

      let response;
      try {
        response = await fetch(apiUrl('/content/' + encodeURIComponent(pageId)), {
          method: 'PUT',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-Atlassian-Token': 'no-check'
          },
          body: JSON.stringify(payload)
        });
      } catch (error) {
        throw new Error('Не удалось сохранить страницу в Confluence: '
          + (error && error.message ? error.message : String(error)));
      }

      const responseText = await response.text();
      let result = null;
      try {
        result = responseText ? JSON.parse(responseText) : null;
      } catch (e) { /* тело ошибки может быть не JSON */ }

      if (!response.ok) {
        if (response.status === 409) {
          const responseDetail = readApiErrorDetails(result, responseText);
          if (attempt === 0) {
            const reportedVersion = readServerCurrentVersion(result, responseText);
            if (reportedVersion != null) {
              serverCurrentVersion = reportedVersion;
              previousConflictDetail = responseDetail;
              continue;
            }
          }
          throw new Error('Confluence отклонил сохранение (HTTP 409). Передана версия страницы '
            + (currentVersion + 1) + ', прочитана версия ' + currentVersion + '.'
            + (responseDetail ? ' Ответ API: ' + responseDetail : ' В ответе API нет дополнительных сведений.')
            + ' Обновление не выполнено.');
        }
        const detail = result && (result.message || (result.errors && result.errors[0] && result.errors[0].message));
        if (/^\s*<(?:!doctype|html)/i.test(responseText)) {
          throw new Error('Confluence вернул страницу входа вместо ответа. Обновите вкладку и войдите заново.');
        }
        throw new Error('Confluence не сохранил страницу (HTTP ' + response.status + ')'
          + (detail ? ': ' + detail : '. Проверьте права на редактирование и доступность макросов.'));
      }
      return {
        id: String((result && result.id) || page.id),
        title: (result && result.title) || page.title || '',
        version: result && result.version ? result.version.number : currentVersion + 1
      };
    }

    throw new Error('Confluence не сохранил страницу после повторной попытки. Обновите страницу и повторите импорт.');
  }

  async function findPageIdByTitle(spaceKey, title) {
    let url = apiUrl('/content?type=page&limit=5&title=' + encodeURIComponent(title));
    if (spaceKey) url += '&spaceKey=' + encodeURIComponent(spaceKey);
    const data = await requestJson(url, { label: 'поиск страницы по названию' });
    const results = (data && data.results) || [];
    if (!results.length) return null;
    const exact = results.find(function (item) {
      return item.title === title;
    });
    return (exact || results[0]).id;
  }

  async function resolvePageIdFromUrl() {
    let parsed;
    try {
      parsed = new URL(location.href);
    } catch (e) {
      return null;
    }

    const fromQuery = parsed.searchParams.get('pageId');
    if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;

    const fromPath = parsed.pathname.match(/\/pages\/(\d+)/);
    if (fromPath) return fromPath[1];

    try {
      const meta = document.querySelector('meta[name="ajs-page-id"]');
      if (meta && /^\d+$/.test(meta.getAttribute('content') || '')) return meta.getAttribute('content');
      const holder = document.querySelector('[data-page-id]');
      if (holder && /^\d+$/.test(holder.getAttribute('data-page-id') || '')) return holder.getAttribute('data-page-id');
    } catch (e) { /* ignore */ }

    const display = parsed.pathname.match(/\/display\/([^/]+)\/(.+)$/);
    if (display) {
      return findPageIdByTitle(decodeURIComponent(display[1]), decodeURIComponent(display[2].replace(/\+/g, ' ')));
    }

    const title = parsed.searchParams.get('title');
    if (title) {
      return findPageIdByTitle(parsed.searchParams.get('spaceKey'), title.replace(/\+/g, ' '));
    }
    return null;
  }

  async function paginate(path, limit, offsetParam) {
    const out = [];
    let start = 0;
    for (;;) {
      const separator = path.indexOf('?') >= 0 ? '&' : '?';
      const page = await requestJson(apiUrl(path + separator + 'limit=' + limit + '&' + offsetParam + '=' + start));
      const results = (page && page.results) || [];
      for (const item of results) out.push(item);
      const hasNext = page && page._links && page._links.next;
      if (!hasNext || !results.length || out.length > 10000) break;
      start += limit;
    }
    return out;
  }

  async function getChildren(pageId) {
    const results = await paginate('/content/' + encodeURIComponent(pageId) + '/child/page?expand=version', 100, 'start');
    return results.map(function (item) {
      return { id: String(item.id), title: item.title || '' };
    });
  }

  async function getAttachments(pageId) {
    const results = await paginate('/content/' + encodeURIComponent(pageId) + '/child/attachment', 100, 'start');
    return results.map(function (item) {
      const links = item._links || {};
      return {
        id: String(item.id),
        name: item.title || '',
        size: item.extensions && item.extensions.fileSize ? Number(item.extensions.fileSize) : 0,
        mediaType: item.extensions && item.extensions.mediaType ? item.extensions.mediaType : '',
        download: links.download || ''
      };
    });
  }

  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function runner() {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }
    const runners = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(runner());
    await Promise.all(runners);
    return results;
  }

  /**
   * Обходит дерево дочерних страниц в ширину.
   * @returns {Promise<{root: object, total: number, truncated: boolean}>}
   */
  async function buildTree(rootPageId, options) {
    const opts = options || {};
    const maxPages = opts.maxPages || 2000;
    const root = { id: String(rootPageId), title: opts.rootTitle || '', children: [] };
    let queue = [root];
    let total = 1;
    let truncated = false;
    const errors = [];

    while (queue.length) {
      const level = queue;
      queue = [];
      const loaded = await mapLimit(level, 4, async function (node) {
        try {
          return { node: node, children: await getChildren(node.id) };
        } catch (error) {
          node.error = error && error.message ? error.message : String(error);
          errors.push({ id: node.id, title: node.title, message: node.error });
          return { node: node, children: [] };
        }
      });
      for (const entry of loaded) {
        for (const child of entry.children) {
          if (total >= maxPages) {
            truncated = true;
            break;
          }
          const childNode = { id: child.id, title: child.title, children: [] };
          entry.node.children.push(childNode);
          queue.push(childNode);
          total += 1;
        }
        if (truncated) break;
      }
      if (truncated) break;
    }

    return { root: root, total: total, truncated: truncated, errors: errors };
  }

  async function fetchAttachmentBytes(attachment) {
    const url = absolutizeUrl(attachment.download);
    if (!url) throw new Error('нет ссылки на скачивание');
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      throw new Error('некорректная ссылка на скачивание');
    }
    if (parsedUrl.origin !== location.origin) {
      throw new Error('ссылка на вложение ведет на другой сайт');
    }
    const response = await fetch(parsedUrl.href, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'X-Atlassian-Token': 'no-check' }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const buffer = await response.arrayBuffer();
    const mediaType = response.headers.get('content-type') || attachment.mediaType || '';
    const preview = new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, 512));
    if (/^\s*<(?:!doctype|html)/i.test(preview) && buffer.byteLength < 200000 && !/html/i.test(attachment.mediaType || '')) {
      throw new Error('вместо файла получена страница входа');
    }
    return { bytes: new Uint8Array(buffer), mediaType: mediaType };
  }

  function pageUrl(page, fallbackPageId) {
    const contextPath = getContextPath();
    const webui = page && page._links && page._links.webui ? page._links.webui : '';
    if (webui) return location.origin + contextPath + webui;
    const id = (page && page.id) || fallbackPageId;
    return location.origin + contextPath + '/pages/viewpage.action?pageId=' + encodeURIComponent(id);
  }

  function baseUrl() {
    return location.origin + getContextPath();
  }

  function attachmentUrlBase(pageId) {
    return baseUrl() + '/download/attachments/' + encodeURIComponent(pageId) + '/';
  }

  return {
    getContextPath: getContextPath,
    looksLikeConfluence: looksLikeConfluence,
    apiUrl: apiUrl,
    absolutizeUrl: absolutizeUrl,
    requestJson: requestJson,
    getPage: getPage,
    updatePage: updatePage,
    getChildren: getChildren,
    getAttachments: getAttachments,
    buildTree: buildTree,
    fetchAttachmentBytes: fetchAttachmentBytes,
    resolvePageIdFromUrl: resolvePageIdFromUrl,
    findPageIdByTitle: findPageIdByTitle,
    pageUrl: pageUrl,
    baseUrl: baseUrl,
    attachmentUrlBase: attachmentUrlBase
  };
});
