/**
 * Конвертация Confluence storage format (XHTML) в Markdown без внешних зависимостей.
 *
 * Модуль работает с DOM: в браузере использует DOMParser, в тестах - любой
 * совместимый DOMParser (например, из jsdom), переданный через setDomParser().
 *
 * Экспортирует:
 *   convert(storageValue, context) -> { markdown, warnings }
 *   sanitizeFileName(name) -> безопасное имя файла или папки
 *   setDomParser(parser) -> подмена DOMParser для тестов
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.MDExporterConverter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  let domParserOverride = null;

  function setDomParser(parser) {
    domParserOverride = parser;
  }

  function getDomParser() {
    if (domParserOverride) return domParserOverride;
    if (typeof DOMParser === 'function') return new DOMParser();
    throw new Error('DOMParser недоступен');
  }

  // Именованные сущности Confluence/HTML, которых нет в XML.
  // Заменяются на числовые ссылки, чтобы документ остался валидным XML.
  const NAMED_ENTITIES = {
    amp: 38, lt: 60, gt: 62, quot: 34, apos: 39,
    nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165,
    brvbar: 166, sect: 167, uml: 168, copy: 169, ordf: 170, laquo: 171,
    not: 172, shy: 173, reg: 174, macr: 175, deg: 176, plusmn: 177,
    sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182, middot: 183,
    cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188, frac12: 189,
    frac34: 190, iquest: 191, times: 215, divide: 247,
    Agrave: 192, Aacute: 193, Auml: 196, Aring: 197, AElig: 198, Ccedil: 199,
    Egrave: 200, Eacute: 201, Euml: 203, Igrave: 204, Iacute: 205, Iuml: 207,
    Ntilde: 209, Ograve: 210, Oacute: 211, Ouml: 214, Oslash: 216, Ugrave: 217,
    Uacute: 218, Uuml: 220, Yacute: 221, agrave: 224, aacute: 225, auml: 228,
    aring: 229, aelig: 230, ccedil: 231, egrave: 232, eacute: 233, euml: 235,
    igrave: 236, iacute: 237, iuml: 239, ntilde: 241, ograve: 242, oacute: 243,
    ouml: 246, oslash: 248, ugrave: 249, uacute: 250, uuml: 252, yacute: 253,
    yuml: 255, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376,
    fnof: 402, circ: 710, tilde: 732,
    Alpha: 913, Beta: 914, Gamma: 915, Delta: 916, Epsilon: 917, Zeta: 918,
    Eta: 919, Theta: 920, Iota: 921, Kappa: 922, Lambda: 923, Mu: 924,
    Nu: 925, Xi: 926, Omicron: 927, Pi: 928, Rho: 929, Sigma: 931,
    Tau: 932, Upsilon: 933, Phi: 934, Chi: 935, Psi: 936, Omega: 937,
    alpha: 945, beta: 946, gamma: 947, delta: 948, epsilon: 949, zeta: 950,
    eta: 951, theta: 952, iota: 953, kappa: 954, lambda: 955, mu: 956,
    nu: 957, xi: 958, omicron: 959, pi: 960, rho: 961, sigmaf: 962,
    sigma: 963, tau: 964, upsilon: 965, phi: 966, chi: 967, psi: 968,
    omega: 969, thetasym: 977, upsih: 978, piv: 982,
    ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206,
    rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218,
    ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225,
    bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
    lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364,
    image: 8465, weierp: 8472, real: 8476, trade: 8482, alefsym: 8501,
    larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629,
    lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660,
    forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711,
    isin: 8712, notin: 8713, ni: 8715, prod: 8719, sum: 8721, minus: 8722,
    lowast: 8727, radic: 8730, prop: 8733, infin: 8734, ang: 8736, and: 8743,
    or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764,
    cong: 8773, asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805,
    sub: 8834, sup: 8835, nsub: 8836, sube: 8838, supe: 8839, oplus: 8853,
    otimes: 8855, perp: 8869, sdot: 8901, lceil: 8968, rceil: 8969,
    lfloor: 8970, rfloor: 8971, lang: 9001, rang: 9002, loz: 9674,
    spades: 9824, clubs: 9827, hearts: 9829, diams: 9830
  };

  const EMOJI = {
    smile: '🙂', sad: '🙁', 'big-grin': '😁', wink: '😉', laugh: '😆',
    tongue: '😛', cheeky: '😜', blush: '😊', surprised: '😮', angry: '😠',
    cry: '😢', evil: '😈', cool: '😎', 'thumbs-up': '👍', 'thumbs-down': '👎',
    tick: '✅', cross: '❌', warning: '⚠️', information: 'ℹ️', question: '❓',
    'light-on': '💡', 'light-off': '🔌', 'yellow-star': '⭐', 'blue-star': '⭐',
    'red-star': '⭐', heart: '❤️', 'broken-heart': '💔', plus: '➕', minus: '➖',
    'check-mark': '✔️', flag: '🚩', 'smile-big': '😃', 'wink-wink': '😉'
  };

  const MACRO_LABELS = {
    info: 'Информация',
    note: 'Заметка',
    tip: 'Совет',
    warning: 'Внимание'
  };

  const BLOCK_LEVEL_TAGS = new Set([
    'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead',
    'tbody', 'tfoot', 'tr', 'td', 'th', 'blockquote', 'pre', 'hr', 'figure',
    'figcaption', 'dl', 'dt', 'dd', 'address', 'center',
    'ac:layout', 'ac:layout-section', 'ac:layout-cell', 'ac:rich-text-body',
    'ac:task-list', 'ac:task', 'ac:structured-macro'
  ]);

  function isElement(node) {
    return !!node && node.nodeType === 1;
  }

  function tagName(node) {
    return (node && node.nodeName ? String(node.nodeName) : '').toLowerCase();
  }

  function childElements(node) {
    const out = [];
    if (!node || !node.childNodes) return out;
    for (let i = 0; i < node.childNodes.length; i++) {
      if (isElement(node.childNodes[i])) out.push(node.childNodes[i]);
    }
    return out;
  }

  function findDescendant(node, names) {
    if (!node || !node.childNodes) return null;
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (isElement(child) && names.indexOf(tagName(child)) >= 0) return child;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const found = findDescendant(node.childNodes[i], names);
      if (found) return found;
    }
    return null;
  }

  function textOf(node) {
    if (!node) return '';
    if (typeof node.textContent === 'string') return node.textContent;
    return '';
  }

  function attr(node, name) {
    if (!node || typeof node.getAttribute !== 'function') return null;
    const value = node.getAttribute(name);
    return value == null ? null : value;
  }

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Приводит storage к валидному XML-фрагменту (CDATA, сущности, одиночные &). */
  function normalizeStorage(input) {
    let text = String(input == null ? '' : input);
    text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, function (match, body) {
      return escapeXml(body);
    });
    text = text.replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, '&amp;');
    text = text.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (match, name) {
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)) {
        return '&#' + NAMED_ENTITIES[name] + ';';
      }
      return '&amp;' + name + ';';
    });
    return text;
  }

  function isParserError(doc) {
    if (!doc) return true;
    const errors = doc.getElementsByTagName ? doc.getElementsByTagName('parsererror') : null;
    return !!(errors && errors.length);
  }

  /** @returns {Element|null} корневой элемент разобранного storage */
  function parseStorage(storageValue) {
    const parser = getDomParser();
    const xml = '<root xmlns:ac="http://atlassian.com/content" '
      + 'xmlns:ri="http://atlassian.com/resource/identifier" '
      + 'xmlns:atlassian="http://atlassian.com/content">'
      + normalizeStorage(storageValue)
      + '</root>';
    let doc = parser.parseFromString(xml, 'application/xhtml+xml');
    if (!isParserError(doc) && doc.documentElement) return doc.documentElement;
    doc = parser.parseFromString(xml, 'text/html');
    if (!isParserError(doc) && doc.body) return doc.body;
    return null;
  }

  function sanitizeFileName(name, fallback) {
    let result = String(name == null ? '' : name)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.\s]+$/, '');
    if (result.length > 120) result = result.slice(0, 120).trim();
    if (!result) result = fallback || 'page';
    return result;
  }

  function collapseInlineWhitespace(value) {
    return String(value).replace(/\s+/g, ' ');
  }

  function escapeInlineText(value) {
    return String(value)
      .replace(/`/g, '\\`')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function cleanup(markdown) {
    let text = String(markdown).replace(/\r\n?/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/^\s+|\s+$/g, '');
    return text ? text + '\n' : '';
  }

  function joinBlocks(parts) {
    return parts.filter(function (part) {
      return String(part).trim() !== '';
    }).join('\n\n');
  }

  function indentLines(text, prefix) {
    if (!text) return '';
    return text.split('\n').map(function (line) {
      return line ? prefix + line : prefix.replace(/\s+$/, '');
    }).join('\n');
  }

  function formatUrl(url) {
    const value = String(url == null ? '' : url).trim();
    if (!value) return '';
    if (/[\s()<>]/.test(value)) return '<' + value.replace(/[<>]/g, '') + '>';
    return value;
  }

  /** Экранирует символы, которые ломают ссылку в Markdown (остальное оставляем читаемым). */
  function encodeLinkPath(path) {
    return String(path == null ? '' : path)
      .replace(/%/g, '%25')
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F');
  }

  function normalizeLanguage(value) {
    const lang = String(value == null ? '' : value).trim().toLowerCase();
    if (!lang) return '';
    if (!/^[a-z0-9+#._-]{1,20}$/.test(lang)) return '';
    return lang;
  }

  function renderCodeBlock(code, language) {
    const text = String(code == null ? '' : code).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    let fence = '```';
    while (text.indexOf(fence) >= 0) fence += '`';
    const lang = normalizeLanguage(language);
    return fence + lang + '\n' + text + '\n' + fence;
  }

  function renderInlineCode(value) {
    const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    let longest = 0;
    let current = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '`') {
        current += 1;
        if (current > longest) longest = current;
      } else {
        current = 0;
      }
    }
    const ticks = '`'.repeat(longest + 1);
    const pad = (text[0] === '`' || text[text.length - 1] === '`') ? ' ' : '';
    return ticks + pad + text + pad + ticks;
  }

  function renderQuote(text) {
    const value = String(text == null ? '' : text).replace(/\n+$/, '');
    if (!value.trim()) return '';
    return value.split('\n').map(function (line) {
      return line ? '> ' + line : '>';
    }).join('\n');
  }

  function readMacroParams(node) {
    const params = {};
    for (const child of childElements(node)) {
      if (tagName(child) !== 'ac:parameter') continue;
      const name = attr(child, 'ac:name');
      if (!name) continue;
      params[name.toLowerCase()] = textOf(child).trim();
    }
    return params;
  }

  function attachmentLink(ctx, filename) {
    const raw = String(filename || '').split('|')[0].split('?')[0].trim();
    if (!raw) return '';
    const lookup = ctx.attachmentLookup;
    const record = lookup && lookup.get ? lookup.get(raw.toLowerCase()) : null;
    if (ctx.includeAttachments) {
      const safe = record ? record.safeName : sanitizeFileName(raw, 'attachment');
      return 'attachments/' + encodeLinkPath(safe);
    }
    const name = record ? record.name : raw;
    const base = ctx.attachmentUrlBase || '';
    return base ? base + encodeURIComponent(name) : name;
  }

  function resolvePageRef(ctx, ref) {
    if (!ctx.resolvePageLink) return null;
    try {
      return ctx.resolvePageLink(ref) || null;
    } catch (e) {
      return null;
    }
  }

  function renderAnchor(ctx, node, label, ref) {
    const url = resolvePageRef(ctx, {
      id: ref.id ? String(ref.id) : null,
      title: ref.title || null,
      anchor: ref.anchor || null
    });
    const text = label && label.trim() ? label.trim() : (ref.title || '');
    if (!url) return text;
    return '[' + text.replace(/[[\]]/g, '\\$&') + '](' + formatUrl(url) + ')';
  }

  function pageAbsoluteUrl(ctx, pageId) {
    const base = ctx.baseUrl || '';
    if (!base || !pageId) return null;
    return base.replace(/\/+$/, '') + '/pages/viewpage.action?pageId=' + encodeURIComponent(pageId);
  }

  // ---------------------------------------------------------------------------
  // Рендеринг узлов
  // ---------------------------------------------------------------------------

  function isInlineNode(node) {
    if (!node) return false;
    if (node.nodeType === 3) return true;
    if (node.nodeType !== 1) return false;
    return !BLOCK_LEVEL_TAGS.has(tagName(node));
  }

  function renderChildren(node, state, mode) {
    if (!node || !node.childNodes) return '';
    if (mode === 'inline') {
      const parts = [];
      for (let i = 0; i < node.childNodes.length; i++) {
        const rendered = renderNode(node.childNodes[i], state, 'inline');
        if (rendered !== '' && rendered != null) parts.push(rendered);
      }
      return parts.join('');
    }
    // Блочный режим: идущие подряд inline-узлы собираются в один абзац.
    const blocks = [];
    let buffer = [];
    const flush = function () {
      if (!buffer.length) return;
      const text = buffer.join('').replace(/^\s+|\s+$/g, '');
      buffer = [];
      if (text) blocks.push(text);
    };
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (isInlineNode(child)) {
        const rendered = renderNode(child, state, 'inline');
        if (rendered) buffer.push(rendered);
        continue;
      }
      flush();
      const rendered = renderNode(child, state, 'block');
      if (rendered != null && String(rendered).trim() !== '') blocks.push(rendered);
    }
    flush();
    return joinBlocks(blocks);
  }

  function renderNode(node, state, mode) {
    if (!node) return '';
    if (node.nodeType === 3) return renderTextNode(node, mode);
    if (node.nodeType !== 1) return '';
    const ctx = state.ctx;
    const name = tagName(node);

    switch (name) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = Number(name[1]);
        const content = collapseInlineWhitespace(renderChildren(node, state, 'inline')).trim();
        if (!content) return '';
        return '#'.repeat(level) + ' ' + content.replace(/^#+\s*/, '');
      }
      case 'p': {
        const inline = renderChildren(node, state, 'inline');
        return mode === 'inline' ? inline : inline.replace(/^\s+|\s+$/g, '');
      }
      case 'div': case 'section': case 'article': case 'header':
      case 'footer': case 'main': case 'aside': case 'figure': case 'figcaption':
      case 'address': case 'center': case 'ac:layout': case 'ac:layout-section':
      case 'ac:layout-cell': {
        if (mode === 'inline') return renderChildren(node, state, 'inline');
        return renderChildren(node, state, 'block');
      }
      case 'ul': case 'ol':
        return renderList(node, state, 0);
      case 'li': {
        if (mode === 'inline') return renderChildren(node, state, 'inline');
        return renderListItem(node, state, null);
      }
      case 'table':
        return renderTable(node, state);
      case 'blockquote': {
        const inner = renderChildren(node, state, 'block');
        return renderQuote(inner);
      }
      case 'pre': {
        const language = detectLanguageFromClass(node);
        return renderCodeBlock(textOf(node), language);
      }
      case 'hr':
        return mode === 'inline' ? '' : '---';
      case 'br':
        return mode === 'inline' ? '  \n' : '';
      case 'a':
        return renderHtmlLink(node, state);
      case 'strong': case 'b': {
        const inner = collapseInlineWhitespace(renderChildren(node, state, 'inline'));
        if (!inner.trim()) return '';
        return '**' + inner.trim() + '**';
      }
      case 'em': case 'i': case 'cite': case 'var': {
        const inner = collapseInlineWhitespace(renderChildren(node, state, 'inline'));
        if (!inner.trim()) return '';
        return '*' + inner.trim() + '*';
      }
      case 's': case 'del': case 'strike': {
        const inner = collapseInlineWhitespace(renderChildren(node, state, 'inline'));
        if (!inner.trim()) return '';
        return '~~' + inner.trim() + '~~';
      }
      case 'u': case 'ins': case 'mark': case 'small': case 'big': case 'tt':
      case 'kbd': case 'q': case 'abbr': case 'time': case 'span':
      case 'ac:inline-comment-marker':
        return renderChildren(node, state, 'inline');
      case 'code':
        return renderInlineCode(textOf(node));
      case 'sub': {
        const inner = collapseInlineWhitespace(renderChildren(node, state, 'inline'));
        return inner.trim() ? '<sub>' + inner.trim() + '</sub>' : '';
      }
      case 'sup': {
        const inner = collapseInlineWhitespace(renderChildren(node, state, 'inline'));
        return inner.trim() ? '<sup>' + inner.trim() + '</sup>' : '';
      }
      case 'img':
        return renderHtmlImage(node, ctx);
      case 'ac:image':
        return renderAcImage(node, state);
      case 'ac:link':
        return renderAcLink(node, state);
      case 'ri:page': {
        return renderAnchor(ctx, node, null, {
          id: attr(node, 'ri:content-id'),
          title: attr(node, 'ri:content-title') || '',
          anchor: attr(node, 'ri:anchor')
        });
      }
      case 'ri:user': {
        const user = attr(node, 'ri:username') || attr(node, 'ri:userkey') || attr(node, 'ri:account-id') || '';
        return user ? '@' + user : '';
      }
      case 'ri:attachment':
        return attachmentLink(ctx, attr(node, 'ri:filename'));
      case 'ri:url':
        return attr(node, 'ri:value') || '';
      case 'ac:emoticon':
        return renderEmoticon(node);
      case 'ac:structured-macro':
        return renderMacro(node, state, mode);
      case 'ac:task-list':
        return renderTaskList(node, state);
      case 'ac:task': {
        const status = textOf(findDescendant(node, ['ac:task-status'])).trim().toLowerCase();
        const body = findDescendant(node, ['ac:task-body']);
        const text = body ? collapseInlineWhitespace(renderChildren(body, state, 'inline')).trim() : '';
        return (status === 'complete' ? '- [x] ' : '- [ ] ') + text;
      }
      case 'ac:plain-text-body':
        return renderChildren(node, state, 'inline');
      case 'ac:parameter':
      case 'ac:placeholder':
      case 'ac:anchor':
        return '';
      default:
        return renderChildren(node, state, mode === 'inline' ? 'inline' : 'block');
    }
  }

  function renderTextNode(node, mode) {
    const raw = String(node.nodeValue == null ? '' : node.nodeValue);
    if (!raw) return '';
    if (mode === 'inline') return escapeInlineText(collapseInlineWhitespace(raw));
    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (!trimmed) return '';
    return escapeInlineText(trimmed);
  }

  function detectLanguageFromClass(node) {
    const className = attr(node, 'class') || '';
    const match = className.match(/language-([a-z0-9+#._-]+)/i) || className.match(/syntaxhighlighter-source/i);
    if (match && match[1]) return match[1];
    return '';
  }

  function renderHtmlLink(node, state) {
    const ctx = state.ctx;
    const href = attr(node, 'href') || '';
    let label = collapseInlineWhitespace(renderChildren(node, state, 'inline')).trim();
    if (!href) return label;
    const hashIndex = href.indexOf('#');
    const anchor = hashIndex >= 0 ? href.slice(hashIndex + 1) : null;
    const absolute = absolutize(ctx, href);
    const pageMatch = absolute ? absolute.match(/\/pages\/(\d+)/) : null;
    let url = absolute || href;
    if (pageMatch) {
      const resolved = resolvePageRef(ctx, { id: pageMatch[1], title: label || null, anchor: anchor });
      if (resolved) url = resolved;
    }
    if (anchor && url.indexOf('#') < 0) url += '#' + anchor;
    if (!label) label = url;
    return '[' + label.replace(/[[\]]/g, '\\$&') + '](' + formatUrl(url) + ')';
  }

  function absolutize(ctx, url) {
    if (!url) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;
    if (typeof ctx.absolutizeUrl === 'function') {
      try {
        const resolved = ctx.absolutizeUrl(url);
        if (resolved) return resolved;
      } catch (e) { /* ignore */ }
    }
    const base = ctx.baseUrl || '';
    if (!base) return url;
    try {
      return new URL(url, base).toString();
    } catch (e) {
      return url;
    }
  }

  function renderHtmlImage(node, ctx) {
    const src = absolutize(ctx, attr(node, 'src') || '');
    if (!src) return '';
    const alt = attr(node, 'alt') || '';
    return '![' + alt.replace(/[[\]]/g, '\\$&') + '](' + formatUrl(src) + ')';
  }

  function renderAcImage(node, state) {
    const ctx = state.ctx;
    const attachment = findDescendant(node, ['ri:attachment']);
    const url = findDescendant(node, ['ri:url']);
    let src = '';
    let alt = attr(node, 'ac:alt') || '';
    if (attachment) {
      const filename = attr(attachment, 'ri:filename') || '';
      src = attachmentLink(ctx, filename);
      if (!alt) alt = String(filename).split('|')[0].split('?')[0];
    } else if (url) {
      src = attr(url, 'ri:value') || '';
    }
    if (!src) return '';
    const label = String(alt || '').replace(/[[\]]/g, '\\$&').replace(/"/g, '');
    const title = label ? ' "' + label + '"' : '';
    return '![' + label + '](' + formatUrl(src) + title + ')';
  }

  function renderAcLink(node, state) {
    const ctx = state.ctx;
    const page = findDescendant(node, ['ri:page']);
    const attachment = findDescendant(node, ['ri:attachment']);
    const user = findDescendant(node, ['ri:user']);
    const urlNode = findDescendant(node, ['ri:url']);
    const bodyNode = findDescendant(node, ['ac:link-body', 'ac:plain-text-link-body']);
    const label = bodyNode ? collapseInlineWhitespace(renderChildren(bodyNode, state, 'inline')).trim() : '';

    if (page) {
      const title = attr(page, 'ri:content-title') || '';
      return renderAnchor(ctx, node, label, {
        id: attr(page, 'ri:content-id'),
        title: title,
        anchor: attr(page, 'ri:anchor')
      });
    }
    if (urlNode) {
      const href = attr(urlNode, 'ri:value') || '';
      const text = label || href;
      if (!href) return text;
      return '[' + text.replace(/[[\]]/g, '\\$&') + '](' + formatUrl(href) + ')';
    }
    if (attachment) {
      const href = attachmentLink(ctx, attr(attachment, 'ri:filename') || '');
      const text = label || String(attr(attachment, 'ri:filename') || '');
      if (!href) return text;
      return '[' + text.replace(/[[\]]/g, '\\$&') + '](' + formatUrl(href) + ')';
    }
    if (user) {
      const name = attr(user, 'ri:username') || attr(user, 'ri:userkey') || attr(user, 'ri:account-id') || '';
      return label || (name ? '@' + name : '');
    }
    return label || collapseInlineWhitespace(renderChildren(node, state, 'inline')).trim();
  }

  function renderEmoticon(node) {
    const name = (attr(node, 'ac:name') || '').toLowerCase();
    const shortname = attr(node, 'ac:emoji-shortname') || '';
    if (shortname) {
      const clean = shortname.replace(/^:|:$/g, '');
      return ':' + clean + ':';
    }
    if (name && EMOJI[name]) return EMOJI[name];
    if (name && /^atlassian-/.test(name)) return ':' + name + ':';
    return name ? ':' + name + ':' : '';
  }

  function renderList(node, state, depth) {
    const ordered = tagName(node) === 'ol';
    const items = childElements(node).filter(function (child) {
      return tagName(child) === 'li';
    });
    const lines = items.map(function (item, index) {
      return renderListItem(item, state, ordered ? (index + 1) : null, depth);
    });
    return lines.filter(Boolean).join('\n');
  }

  function renderListItem(item, state, number, depth) {
    const parts = [];
    const nestedLists = [];
    for (let i = 0; i < item.childNodes.length; i++) {
      const child = item.childNodes[i];
      if (child.nodeType === 3) {
        parts.push(renderTextNode(child, 'inline'));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const childName = tagName(child);
      if (childName === 'ul' || childName === 'ol') {
        nestedLists.push(renderList(child, state, (depth || 0) + 1));
        continue;
      }
      const rendered = renderNode(child, state, 'inline');
      if (rendered) parts.push(rendered);
    }
    const text = parts.join('').replace(/^\s+|\s+$/g, '');
    const marker = number ? number + '. ' : '- ';
    let result = text ? marker + text : marker.trim();
    const indent = ' '.repeat(marker.length);
    for (const nested of nestedLists) {
      if (!nested) continue;
      result += '\n' + nested.split('\n').map(function (line) {
        return line ? indent + line : line;
      }).join('\n');
    }
    return result;
  }

  function collectTableRows(node) {
    const rows = [];
    for (const child of childElements(node)) {
      const name = tagName(child);
      if (name === 'tr') {
        rows.push(child);
      } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
        for (const inner of childElements(child)) {
          if (tagName(inner) === 'tr') rows.push(inner);
        }
      }
    }
    return rows;
  }

  function renderTable(node, state) {
    const rows = collectTableRows(node);
    if (!rows.length) return '';
    const matrix = rows.map(function (row) {
      const cells = childElements(row).filter(function (cell) {
        const name = tagName(cell);
        return name === 'td' || name === 'th';
      });
      const isHeaderRow = childElements(row).some(function (cell) {
        return tagName(cell) === 'th';
      });
      return {
        header: isHeaderRow,
        cells: cells.map(function (cell) {
          return collapseInlineWhitespace(renderChildren(cell, state, 'inline'))
            .replace(/\|/g, '\\|')
            .replace(/^\s+|\s+$/g, '');
        })
      };
    });

    const width = matrix.reduce(function (max, row) {
      return Math.max(max, row.cells.length);
    }, 0);
    if (!width) return '';

    const headerRow = matrix.find(function (row) { return row.header; }) || matrix[0];
    const bodyRows = matrix.filter(function (row) { return row !== headerRow; });

    function formatRow(cells) {
      const padded = cells.slice();
      while (padded.length < width) padded.push('');
      return '| ' + padded.join(' | ') + ' |';
    }

    const headerCells = headerRow.cells.slice();
    while (headerCells.length < width) headerCells.push('');
    for (let i = 0; i < headerCells.length; i++) {
      if (!headerCells[i]) headerCells[i] = ' ';
    }

    const lines = [formatRow(headerCells), '| ' + new Array(width).fill('---').join(' | ') + ' |'];
    for (const row of bodyRows) {
      if (!row.cells.length) continue;
      lines.push(formatRow(row.cells));
    }
    return lines.join('\n');
  }

  function renderTaskList(node, state) {
    const tasks = childElements(node).filter(function (child) {
      return tagName(child) === 'ac:task';
    });
    return tasks.map(function (task) {
      return renderNode(task, state, 'block');
    }).filter(Boolean).join('\n');
  }

  function renderMacro(node, state, mode) {
    const ctx = state.ctx;
    const name = (attr(node, 'ac:name') || '').toLowerCase();
    const params = readMacroParams(node);
    const plain = findDescendant(node, ['ac:plain-text-body']);
    const rich = findDescendant(node, ['ac:rich-text-body']);
    const title = params.title || params.title_text || params.titletext || '';

    function renderRich() {
      if (rich) return renderChildren(rich, state, 'block');
      if (plain) return '```\n' + textOf(plain).replace(/\n+$/, '') + '\n```';
      return '';
    }

    switch (name) {
      case 'code':
      case 'noformat': {
        const language = params.language || params.lang || params.language_ || '';
        const code = plain ? textOf(plain) : (rich ? textOf(rich) : '');
        const block = renderCodeBlock(code, name === 'noformat' ? '' : language);
        return title ? '**' + escapeInlineText(title) + '**\n\n' + block : block;
      }
      case 'plantuml':
      case 'mermaid':
        return renderCodeBlock(plain ? textOf(plain) : textOf(rich), name);
      case 'info':
      case 'note':
      case 'tip':
      case 'warning': {
        const inner = renderRich();
        if (!inner) return '';
        const label = MACRO_LABELS[name];
        return renderQuote(label ? '**' + label + '**\n\n' + inner : inner);
      }
      case 'panel': {
        const inner = renderRich();
        if (!inner) return '';
        return renderQuote(title ? '**' + escapeInlineText(title) + '**\n\n' + inner : inner);
      }
      case 'expand': {
        const inner = renderRich();
        const summary = title || params['expand-title'] || 'Подробнее';
        if (!inner) return '';
        return '<details>\n<summary>' + escapeInlineText(summary) + '</summary>\n\n'
          + inner + '\n\n</details>';
      }
      case 'excerpt':
      case 'section':
      case 'column':
      case 'multiexcerpt':
        return renderRich();
      case 'excerpt-include':
      case 'multiexcerpt-include':
      case 'include': {
        const pageRef = findDescendant(node, ['ri:page']);
        const pageTitle = (pageRef ? attr(pageRef, 'ri:content-title') : null) || params.page || '';
        const label = 'Включение содержимого со страницы: ' + (pageTitle || 'страница');
        const rendered = renderAnchor(ctx, node, label, {
          id: pageRef ? attr(pageRef, 'ri:content-id') : null,
          title: pageTitle,
          anchor: null
        });
        return '> ' + rendered;
      }
      case 'status': {
        const text = collapseInlineWhitespace(textOf(rich || node)).trim();
        return text ? '**' + escapeInlineText(text) + '**' : '';
      }
      case 'jira': {
        const key = params.key || params.jql || '';
        return key ? '`' + key.replace(/`/g, '') + '`' : '';
      }
      case 'attachments': {
        const list = ctx.attachments || [];
        if (!list.length) return '';
        return list.map(function (item) {
          const target = attachmentLink(ctx, item.name);
          return '- [' + item.name + '](' + formatUrl(target) + ')';
        }).join('\n');
      }
      case 'toc': {
        const inner = renderRich();
        const note = '<!-- Макрос "Оглавление" (TOC) не экспортируется -->';
        return inner ? inner + '\n\n' + note : note;
      }
      case 'drawio': {
        const diagram = params.diagramname || params.diagramname_ || params['diagram-name'] || '';
        if (diagram) {
          const target = attachmentLink(ctx, diagram + '.png');
          return '![' + diagram + '](' + formatUrl(target) + ')';
        }
        return '<!-- Макрос drawio: диаграмма доступна только в Confluence -->';
      }
      case 'children':
      case 'pagetree':
      case 'livesearch':
      case 'recently-updated':
      case 'recently-updated-dashboard':
        return '<!-- Макрос "' + name + '": динамический список страниц не экспортируется -->';
      case 'anchor':
        return '';
      case 'view-file':
      case 'viewpdf':
      case 'viewdoc':
      case 'viewppt':
      case 'viewxls': {
        const file = findDescendant(node, ['ri:attachment']);
        return file ? attachmentLink(ctx, attr(file, 'ri:filename')) : '';
      }
      default: {
        const inner = renderRich();
        if (inner) return inner;
        return '<!-- Макрос Confluence "' + (name || 'unknown') + '" не конвертируется -->';
      }
    }
  }

  function buildFrontMatter(ctx) {
    const lines = ['---'];
    lines.push('title: "' + String(ctx.pageTitle || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
    if (ctx.pageUrl) lines.push('source: "' + String(ctx.pageUrl).replace(/"/g, '\\"') + '"');
    if (ctx.pageId) lines.push('page_id: "' + ctx.pageId + '"');
    if (ctx.spaceKey) lines.push('space: "' + ctx.spaceKey + '"');
    if (ctx.version) lines.push('version: "' + ctx.version + '"');
    lines.push('exported_at: "' + (ctx.exportedAt || new Date().toISOString()) + '"');
    lines.push('---');
    return lines.join('\n');
  }

  function convert(storageValue, context) {
    const ctx = Object.assign({
      pageTitle: '',
      pageUrl: '',
      pageId: '',
      spaceKey: '',
      version: '',
      baseUrl: '',
      includeAttachments: false,
      attachmentLookup: null,
      attachments: [],
      attachmentUrlBase: '',
      resolvePageLink: null,
      frontMatter: true,
      exportedAt: new Date().toISOString()
    }, context || {});

    const warnings = [];
    const root = parseStorage(storageValue);
    if (!root) {
      return { markdown: '', warnings: ['Не удалось разобрать содержимое страницы'] };
    }

    const state = { ctx: ctx, warnings: warnings };
    let body = '';
    try {
      body = renderChildren(root, state, 'block');
    } catch (error) {
      warnings.push('Ошибка конвертации содержимого: ' + (error && error.message ? error.message : String(error)));
    }

    const parts = [];
    if (ctx.frontMatter) parts.push(buildFrontMatter(ctx));
    const title = ctx.pageTitle ? '# ' + ctx.pageTitle : '';
    if (title) parts.push(title);
    if (body.trim()) parts.push(body);

    return { markdown: cleanup(parts.join('\n\n')) + '', warnings: warnings };
  }

  return {
    convert: convert,
    sanitizeFileName: sanitizeFileName,
    normalizeStorage: normalizeStorage,
    parseStorage: parseStorage,
    setDomParser: setDomParser
  };
});
