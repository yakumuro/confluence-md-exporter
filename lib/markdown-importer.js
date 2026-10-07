/*
 * Преобразование распространенного Markdown в Confluence storage format.
 * Поддерживает формат, создаваемый MD Exporter, и fenced code blocks.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.MDExporterMarkdownImporter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_MARKDOWN_LENGTH = 2 * 1024 * 1024;

  function escapeXml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function cdata(value) {
    return '<![CDATA[' + String(value == null ? '' : value).replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>';
  }

  function safeHref(value) {
    const href = String(value || '').trim();
    if (!href || /^(?:javascript|data|vbscript):/i.test(href)) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^(?:https?|mailto):/i.test(href)) return '';
    return href;
  }

  function macroParameter(name, value) {
    return '<ac:parameter ac:name="' + escapeXml(name) + '">' + escapeXml(value) + '</ac:parameter>';
  }

  function renderCode(code, language, wrapInExpand) {
    const params = [macroParameter('title', 'Блок кода')];
    const normalizedLanguage = String(language || '').trim().toLowerCase();
    if (normalizedLanguage && /^[a-z0-9+#._-]{1,40}$/.test(normalizedLanguage)) {
      params.push(macroParameter('language', normalizedLanguage));
    }
    const codeMacro = '<ac:structured-macro ac:name="code">' + params.join('')
      + '<ac:plain-text-body>' + cdata(String(code || '').replace(/\r\n?/g, '\n'))
      + '</ac:plain-text-body></ac:structured-macro>';
    if (wrapInExpand === false) return codeMacro;
    return '<ac:structured-macro ac:name="expand">' + macroParameter('title', 'Раскрыть')
      + '<ac:rich-text-body>' + codeMacro + '</ac:rich-text-body></ac:structured-macro>';
  }

  function renderPlantUml(source) {
    return '<ac:structured-macro ac:name="plantuml"><ac:plain-text-body>'
      + cdata(String(source || '').replace(/\r\n?/g, '\n'))
      + '</ac:plain-text-body></ac:structured-macro>';
  }


  function renderInline(value) {
    let text = String(value || '').replace(/<!--([\s\S]*?)-->/g, '');
    const tokens = [];
    function protect(html) {
      const token = '\u0000' + tokens.length + '\u0000';
      tokens.push(html);
      return token;
    }

    text = text.replace(/(`+)(.+?)\1/g, function (match, ticks, code) {
      return protect('<code>' + escapeXml(code.replace(/\n/g, ' ').trim()) + '</code>');
    });
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, function (match, alt, rawUrl) {
      const href = safeHref(rawUrl);
      if (!href) return escapeXml(alt);
      return protect('<ac:image ac:alt="' + escapeXml(alt) + '"><ri:url ri:value="'
        + escapeXml(href) + '" /></ac:image>');
    });
    text = text.replace(/\[([^\]]+)\]\((<[^>]+>|[^)\s]+)(?:\s+"([^"]*)")?\)/g, function (match, label, rawUrl) {
      const href = safeHref(rawUrl.replace(/^<|>$/g, ''));
      if (!href) return escapeXml(label);
      return protect('<a href="' + escapeXml(href) + '">' + renderInline(label) + '</a>');
    });

    text = escapeXml(text)
      .replace(/\\([\\`*_{}\[\]()#+.!|>~-])/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>')
      .replace(/&lt;(sub|sup)&gt;([\s\S]*?)&lt;\/\1&gt;/gi, '<$1>$2</$1>');

    return text.replace(/\u0000(\d+)\u0000/g, function (match, index) {
      return tokens[Number(index)] || '';
    });
  }

  function parseFrontMatter(markdown) {
    const match = String(markdown).match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (!match) return { body: String(markdown), title: '' };
    const titleMatch = match[1].match(/^title:\s*["']?([\s\S]*?)["']?\s*$/m);
    return {
      body: String(markdown).slice(match[0].length),
      title: titleMatch ? titleMatch[1].replace(/\\([\\"])/g, '$1').trim() : ''
    };
  }

  function parseTableRow(line) {
    let value = String(line || '').trim();
    if (value.charAt(0) === '|') value = value.slice(1);
    if (value.charAt(value.length - 1) === '|') value = value.slice(0, -1);
    const cells = [];
    let cell = '';
    let escaped = false;
    for (const char of value) {
      if (char === '|' && !escaped) {
        cells.push(cell.trim().replace(/\\\|/g, '|'));
        cell = '';
      } else {
        cell += char;
      }
      if (char === '\\' && !escaped) escaped = true;
      else escaped = false;
    }
    cells.push(cell.trim().replace(/\\\|/g, '|'));
    return cells;
  }

  function isTableSeparator(line) {
    const cells = parseTableRow(line);
    return cells.length > 0 && cells.every(function (cell) { return /^:?-{3,}:?$/.test(cell); });
  }

  function listMatch(line) {
    return String(line || '').match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
  }

  function parseList(lines, start) {
    const first = listMatch(lines[start]);
    const indent = first[1].length;
    const ordered = /^\d/.test(first[2]);
    const tag = ordered ? 'ol' : 'ul';
    const items = [];
    let index = start;

    while (index < lines.length) {
      const current = listMatch(lines[index]);
      if (!current || current[1].length !== indent || /^\d/.test(current[2]) !== ordered) break;
      let itemHtml = renderInline(current[3]);
      index += 1;

      while (index < lines.length) {
        if (!String(lines[index]).trim()) {
          let lookahead = index + 1;
          while (lookahead < lines.length && !String(lines[lookahead]).trim()) lookahead += 1;
          const next = lookahead < lines.length ? listMatch(lines[lookahead]) : null;
          if (!next || next[1].length <= indent) {
            index = lookahead;
            break;
          }
          index = lookahead;
          continue;
        }
        const nested = listMatch(lines[index]);
        if (nested && nested[1].length > indent) {
          const parsed = parseList(lines, index);
          itemHtml += parsed.html;
          index = parsed.next;
          continue;
        }
        if (nested && nested[1].length <= indent) break;
        const leading = (lines[index].match(/^\s*/) || [''])[0].length;
        if (leading > indent) {
          itemHtml += ' ' + renderInline(lines[index].trim());
          index += 1;
          continue;
        }
        break;
      }
      items.push('<li>' + itemHtml + '</li>');
      const nextItem = index < lines.length ? listMatch(lines[index]) : null;
      if (!nextItem || nextItem[1].length !== indent || /^\d/.test(nextItem[2]) !== ordered) break;
    }
    return { html: '<' + tag + '>' + items.join('') + '</' + tag + '>', next: index };
  }

  function renderFence(language, code, wrapCodeInExpand) {
    const lang = String(language || '').trim().split(/\s+/)[0].toLowerCase();
    if (/^(?:plantuml|puml|uml)$/.test(lang) || /^\s*@start(?:uml|mindmap|gantt|wbs|salt|ditaa|dot|regex|chronology|board|wireframe|math)\b/im.test(code)) {
      return renderPlantUml(code);
    }
    return renderCode(code, lang, wrapCodeInExpand);
  }

  const MAX_NESTING_DEPTH = 100;

  function parseBlocks(lines, options) {
    const settings = options || {};
    const nestingDepth = settings.nestingDepth || 0;
    if (nestingDepth > MAX_NESTING_DEPTH) {
      throw new Error('Слишком глубокая вложенность Markdown (максимум 100 уровней)');
    }
    const wrapCodeInExpand = settings.wrapCodeInExpand !== false;
    const out = [];
    let index = 0;

    while (index < lines.length) {
      const line = String(lines[index] || '');
      if (!line.trim()) {
        index += 1;
        continue;
      }

      if (/^\s*<!--/.test(line)) {
        while (index < lines.length && !String(lines[index]).includes('-->')) index += 1;
        index += 1;
        continue;
      }

      if (/^\s*<details\s*>\s*$/i.test(line)) {
        const details = [];
        index += 1;
        while (index < lines.length && !/^\s*<\/details\s*>\s*$/i.test(lines[index])) {
          details.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const summaryIndex = details.findIndex(function (entry) { return /^\s*<summary>/i.test(entry); });
        let title = 'Подробнее';
        if (summaryIndex >= 0) {
          title = details[summaryIndex].replace(/^\s*<summary>/i, '').replace(/<\/summary>\s*$/i, '').trim() || title;
          details.splice(summaryIndex, 1);
        }
        out.push('<ac:structured-macro ac:name="expand">' + macroParameter('title', title)
          + '<ac:rich-text-body>' + parseBlocks(details, {
            wrapCodeInExpand: false,
            nestingDepth: nestingDepth + 1
          }).join('') + '</ac:rich-text-body></ac:structured-macro>');
        continue;
      }

      const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
      if (fence) {
        const fenceMarker = fence[1];
        const language = String(fence[2] || '').trim();
        index += 1;
        const code = [];
        const closing = new RegExp('^\\s*' + (fenceMarker.charAt(0) === '`' ? '`' : '~')
          + '{' + fenceMarker.length + ',}\\s*$');
        while (index < lines.length && !closing.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        out.push(renderFence(language, code.join('\n'), wrapCodeInExpand));
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
        index += 1;
        continue;
      }

      if (/^\s*(?:-{3,}|(?:\*\s*){3,}|(?:_\s*){3,})\s*$/.test(line)) {
        out.push('<hr />');
        index += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ''));
          index += 1;
        }
        out.push('<blockquote>' + parseBlocks(quote, Object.assign({}, settings, {
          nestingDepth: nestingDepth + 1
        })).join('') + '</blockquote>');
        continue;
      }

      const item = listMatch(line);
      if (item) {
        const parsed = parseList(lines, index);
        out.push(parsed.html);
        index = parsed.next;
        continue;
      }

      if (index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]) && isTableSeparator(lines[index + 1])) {
        const header = parseTableRow(line);
        index += 2;
        const rows = [];
        while (index < lines.length && String(lines[index]).trim() && String(lines[index]).includes('|')) {
          rows.push(parseTableRow(lines[index]));
          index += 1;
        }
        const cells = header.map(function (cell) { return '<th><p>' + renderInline(cell) + '</p></th>'; }).join('');
        const bodyRows = rows.map(function (row) {
          return '<tr>' + header.map(function (_, cellIndex) {
            return '<td><p>' + renderInline(row[cellIndex] || '') + '</p></td>';
          }).join('') + '</tr>';
        }).join('');
        out.push('<table><tbody><tr>' + cells + '</tr>' + bodyRows + '</tbody></table>');
        continue;
      }

      const paragraph = [line.replace(/^\s+/, '')];
      index += 1;
      while (index < lines.length && lines[index].trim()) {
        const next = lines[index];
        if (/^\s*(?:#{1,6}\s|```|~~~|>|<details\s*>)/.test(next) || listMatch(next)) break;
        if (index + 1 < lines.length && isTableSeparator(lines[index + 1])) break;
        paragraph.push(next.replace(/^\s+/, ''));
        index += 1;
      }
      out.push('<p>' + paragraph.map(function (part, partIndex) {
        const hardBreak = partIndex > 0 && / {2,}$/.test(paragraph[partIndex - 1]);
        const content = renderInline(part.replace(/ {2,}$/, '').trimEnd());
        if (partIndex === 0) return content;
        return (hardBreak ? '<br />' : ' ') + content;
      }).join('') + '</p>');
    }
    return out;
  }

  function parseMarkdown(markdown, options) {
    const source = String(markdown == null ? '' : markdown).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (source.length > MAX_MARKDOWN_LENGTH) {
      throw new Error('Файл Markdown слишком большой (максимум 2 МБ)');
    }
    const frontMatter = parseFrontMatter(source);
    const targetTitle = String((options && options.pageTitle) || frontMatter.title || '').trim();
    const lines = frontMatter.body.split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    const firstHeading = lines[0] && lines[0].match(/^#\s+(.+?)\s*#*\s*$/);
    if (firstHeading && targetTitle && firstHeading[1].trim() === targetTitle) lines.shift();
    const storage = parseBlocks(lines).join('');
    if (!storage.trim()) throw new Error('В Markdown-файле не найдено содержимое для импорта');
    return { storage: storage, frontMatterTitle: frontMatter.title };
  }

  return {
    MAX_MARKDOWN_LENGTH: MAX_MARKDOWN_LENGTH,
    parseMarkdown: parseMarkdown
  };
});
