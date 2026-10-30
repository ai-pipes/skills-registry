import { useMemo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link } from 'react-router';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { fileUrl } from '@/api/queries.ts';
import { cn } from '@/lib/utils.ts';

const SAFE_SCHEME = /^(https?|mailto):$/i;
// A scheme is letters/digits/+.- before the first ':' that comes before any '/', '?' or '#'.
const SCHEME = /^([a-z][a-z\d+.-]*:)/i;

/**
 * Lets through `http:`, `https:`, `mailto:` and relative URLs; anything else (`javascript:`,
 * `data:`, `vbscript:`…) becomes an empty string. Control characters and spaces are stripped
 * first, the way browsers do before they parse the scheme.
 */
function safeUrl(url: string): string {
  const compact = url.replace(/[\s\p{Cc}]/gu, '');
  const scheme = SCHEME.exec(compact)?.[1];
  if (scheme === undefined) return url; // relative: path, ?query or #fragment
  return SAFE_SCHEME.test(scheme) ? url : '';
}

/** `http(s):` and protocol-relative `//host` links leave the registry. */
function isExternal(href: string | undefined): boolean {
  return href !== undefined && /^(https?:)?\/\//i.test(href);
}

/** Not empty, not `/…` (absolute or protocol-relative), not `#…`, no scheme. */
function isSkillRelative(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    url !== '' &&
    !url.startsWith('/') &&
    !url.startsWith('#') &&
    !SCHEME.test(url.replace(/[\s\p{Cc}]/gu, ''))
  );
}

/**
 * A link or image URL relative to the skill root (SKILL.md lives there), resolved to a file
 * path: `./` and `../` are applied, `?query` and `#fragment` dropped, segments percent-decoded.
 * `undefined` when it escapes the root or names no file.
 */
function skillRelativePath(url: string): string | undefined {
  const raw = url.split(/[?#]/, 1)[0] ?? '';
  const out: string[] = [];
  for (const segment of raw.split('/')) {
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (name === '' || name === '.') continue;
    if (name === '..') {
      if (out.pop() === undefined) return undefined;
      continue;
    }
    if (name.includes('/') || name.includes('\\')) return undefined;
    out.push(name);
  }
  return out.length === 0 ? undefined : out.join('/');
}

type NodeProps<T extends 'a' | 'img'> = ComponentProps<T> & { node?: unknown };

function makeComponents(slug: string, version: number | undefined): Components {
  function Anchor({ node: _node, href, children, ...props }: NodeProps<'a'>) {
    if (isExternal(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    }
    if (!isSkillRelative(href)) {
      return (
        <a href={href} {...props}>
          {children}
        </a>
      );
    }
    const path = skillRelativePath(href);
    if (path === undefined) return <span>{children}</span>; // escapes the skill root
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const query = `?file=${encoded}${version === undefined ? '' : `&version=${version}`}`;
    return (
      <Link to={query} {...props}>
        {children}
      </Link>
    );
  }

  function Image({ node: _node, src, alt, ...props }: NodeProps<'img'>) {
    if (!isSkillRelative(src)) {
      return <img src={src} alt={alt} {...props} />;
    }
    const path = skillRelativePath(src);
    return (
      <img
        src={path === undefined ? undefined : fileUrl(slug, path, version)}
        alt={alt}
        {...props}
      />
    );
  }

  return { a: Anchor, img: Image };
}

export interface MarkdownProps {
  /** Untrusted markdown (a skill's SKILL.md). */
  source: string;
  /** The skill the markdown belongs to: relative links open its files, relative images load them. */
  slug: string;
  /** The version being viewed; omitted for the current one. */
  version?: number | undefined;
  className?: string;
}

/**
 * Renders untrusted markdown: GFM, sanitized with the default `rehype-sanitize` (GitHub) schema,
 * raw HTML is never parsed (no `rehype-raw`), URLs pass `safeUrl`, external links open with
 * `rel="noopener noreferrer"`. A relative link (`references/x.md`) opens that file of the skill
 * (`?file=…`), a relative image loads from the files API; one escaping the skill root is dropped.
 * Styles: `.prose` in global.css.
 */
export function Markdown({ source, slug, version, className }: MarkdownProps) {
  const components = useMemo(() => makeComponents(slug, version), [slug, version]);
  return (
    <div className={cn('prose', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={safeUrl}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
