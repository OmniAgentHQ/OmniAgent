import { useState, type ReactNode } from 'react';
import { Check, Copy, FolderOpen } from 'lucide-react';
import { omni } from './api';
import { imageSource, isPreviewImage, openImage } from './Images';
import { baseName } from './ui';

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
  }
  return false;
}

function OpenPathButton({ target, label }: { target: string; label?: string }) {
  const [missing, setMissing] = useState(false);
  return <button
    className="path-link"
    type="button"
    onClick={() => {
      setMissing(false);
      if (isPreviewImage(target)) { void omni.pathExists(target).then((exists) => exists ? openImage(imageSource(target, label)) : setMissing(true)).catch(() => setMissing(true)); return; }
      void omni.revealPath(target).catch(() => setMissing(true));
    }}
  ><FolderOpen size={12} />{missing ? `${label || baseName(target)} (not found)` : label || baseName(target)}</button>;
}

const WINDOWS_SEGMENT = String.raw`[^\\/\s:"'<>|?*\n` + '`]+';
const POSIX_SEGMENT = String.raw`[^/\s"'<>|?*\n` + '`]+';
const ABSOLUTE_PATH_PATTERN = omni.platform === 'win32'
  ? new RegExp(String.raw`[A-Za-z]:[\\/](?:${WINDOWS_SEGMENT}(?: ${WINDOWS_SEGMENT})*[\\/])*(?:${WINDOWS_SEGMENT})?`, 'g')
  : new RegExp(String.raw`(?<![\w.])/(?:Users|home|tmp|var|opt|mnt|media|Volumes|srv|private)/(?:${POSIX_SEGMENT}(?: ${POSIX_SEGMENT})*/)*(?:${POSIX_SEGMENT})?`, 'g');
const LOCAL_TARGET_PATTERN = omni.platform === 'win32' ? /^[A-Za-z]:[\\/]/ : /^\//;

function localTarget(raw: string) {
  const value = raw.trim().replace(/^<|>$/g, '').replace(/^file:\/\/\/?/i, '').replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/, '');
  if (!LOCAL_TARGET_PATTERN.test(value) || value.includes('\n')) return '';
  try { return decodeURI(value); } catch { return value; }
}

function linkifyPaths(text: string, keyPrefix: string): ReactNode[] {
  const output: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  ABSOLUTE_PATH_PATTERN.lastIndex = 0;
  while ((match = ABSOLUTE_PATH_PATTERN.exec(text))) {
    const target = match[0].replace(/[.,;:!)\]]+$/, '');
    if (target.length < 6) continue;
    if (match.index > cursor) output.push(text.slice(cursor, match.index));
    output.push(<OpenPathButton target={target} key={`${keyPrefix}-path-${match.index}`} />);
    const suffix = match[0].slice(target.length);
    if (suffix) output.push(suffix);
    cursor = match.index + match[0].length;
  }
  if (!output.length) return [text];
  if (cursor < text.length) output.push(text.slice(cursor));
  return output;
}

function renderInlineMarkdown(source: string, keyPrefix: string): ReactNode[] {
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<!\w)__[^_\n]+__(?!\w)|\[[^\]\n]+\]\(<[^>\n]+>\)|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*|(?<!\w)_[^_\n]+_(?!\w))/g;
  const output: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(source))) {
    if (match.index > cursor) output.push(...linkifyPaths(source.slice(cursor, match.index), `${keyPrefix}-${cursor}`));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith('`')) {
      const inner = token.slice(1, -1);
      const target = localTarget(inner);
      output.push(target ? <OpenPathButton target={target} key={key} /> : <code key={key}>{inner}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      output.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\((.+)\)$/);
      const target = link ? localTarget(link[2]) : '';
      output.push(link && /^https?:\/\//.test(link[2])
        ? <a href={link[2]} key={key} target="_blank" rel="noreferrer">{link[1]}</a>
        : link && target ? <OpenPathButton target={target} label={link[1]} key={key} /> : token);
    } else {
      output.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < source.length) output.push(...linkifyPaths(source.slice(cursor), `${keyPrefix}-${cursor}`));
  return output;
}

function looksLikeSourceCode(text: string) {
  const body = text.trim();
  if (body.length < 80) return false;
  const lines = body.split('\n').filter((line) => line.trim());
  if (lines.length < 4) return false;
  const codeish = lines.filter((line) => (
    /^\s*(?:\/\/|\/\*|\*(?!\*)|#|<!--)/.test(line)
    || /[;{}]\s*$/.test(line)
    || /^\s*(?:function|const|let|var|class|import|export|return|if|for|while|def|public|private|async)\b/.test(line)
    || /^\s*<\/?[a-z][\w-]*/i.test(line)
    || /\b\w+\s*\([^)]*\)\s*[{;]/.test(line)
    || /^\s*[.#@][\w-]+\s*\{/.test(line)
  )).length;
  return codeish / lines.length >= 0.5;
}

export function CodeBox({ code, language, title, prompt, limit }: { code: string; language?: string; title?: string; prompt?: string; limit?: number }) {
  const [copied, setCopied] = useState(false);
  const [all, setAll] = useState(false);
  const long = Boolean(limit && code.length > limit);
  const shown = long && !all ? `${code.slice(0, limit).replace(/\n[^\n]*$/, '')}\n…` : code;
  return <div className={`code-block ${prompt ? 'terminal' : ''}`}>
    <div className="code-block-head">
      <span className="code-block-title">{title || language || 'code'}</span>
      {title && language ? <span className="code-block-lang">{language}</span> : null}
      <button type="button" onClick={() => {
        void copyText(code).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}</button>
    </div>
    <pre>{prompt ? <span className="code-prompt">{prompt}</span> : null}<code>{shown}</code></pre>
    {long ? <button type="button" className="code-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${code.split('\n').length} lines`}</button> : null}
  </div>;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  return <CodeBox code={code} language={language} />;
}

export function Markdown({ content }: { content: string }) {
  if (!content.includes('```') && looksLikeSourceCode(content)) {
    return <div className="md"><CodeBlock code={content} language="" /></div>;
  }
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  const isTableDivider = (value: string | undefined) => value !== undefined && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(value);

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<CodeBlock code={code.join('\n')} language={language} key={`code-${index}`} />);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const Heading = heading[1].length <= 2 ? 'h3' : 'h4';
      blocks.push(<Heading key={`heading-${index}`}>{renderInlineMarkdown(heading[2], `heading-${index}`)}</Heading>);
      index += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        const value = lines[index].replace(/^\s*[-*+]\s+/, '');
        items.push(<li key={`bullet-${index}`}>{renderInlineMarkdown(value, `bullet-${index}`)}</li>);
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`}>{items}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const startsAt = Number(line.match(/^\s*(\d+)\./)?.[1] ?? 1);
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        const value = lines[index].replace(/^\s*\d+\.\s+/, '');
        items.push(<li key={`number-${index}`}>{renderInlineMarkdown(value, `number-${index}`)}</li>);
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`} start={Number.isFinite(startsAt) && startsAt > 0 ? startsAt : 1}>{items}</ol>);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`}>{quote.map((value, quoteIndex) => <span key={quoteIndex}>{renderInlineMarkdown(value, `quote-${index}-${quoteIndex}`)}{quoteIndex < quote.length - 1 ? <br /> : null}</span>)}</blockquote>);
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />);
      index += 1;
      continue;
    }
    if (line.includes('|') && isTableDivider(lines[index + 1])) {
      const cells = (value: string) => value.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const headers = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      blocks.push(<div className="md-table" key={`table-${index}`}><table><thead><tr>{headers.map((header, cellIndex) => <th key={cellIndex}>{renderInlineMarkdown(header, `table-head-${index}-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{renderInlineMarkdown(row[cellIndex] ?? '', `table-${index}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !lines[index].trimStart().startsWith('```')
      && !/^(#{1,4})\s+/.test(lines[index])
      && !/^\s*[-*+]\s+/.test(lines[index])
      && !/^\s*\d+\.\s+/.test(lines[index])
      && !/^\s*>\s?/.test(lines[index])
      && !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])
      && !(lines[index].includes('|') && isTableDivider(lines[index + 1]))
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`paragraph-${index}`}>{paragraph.map((value, paragraphIndex) => <span key={paragraphIndex}>{renderInlineMarkdown(value, `paragraph-${index}-${paragraphIndex}`)}{paragraphIndex < paragraph.length - 1 ? <br /> : null}</span>)}</p>);
  }

  return <div className="md">{blocks}</div>;
}
