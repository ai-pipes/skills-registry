import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils.ts';

/**
 * Editor theme on the shadcn CSS variables. Custom properties inherit into the shadow tree (and
 * follow the `dark` class on <html>); Tailwind classes do not, so the editor is styled here.
 */
const theme = EditorView.theme({
  '&': {
    color: 'var(--foreground)',
    backgroundColor: 'var(--background)',
    border: '1px solid var(--input)',
    borderRadius: 'var(--radius)',
    fontSize: '0.875rem',
    height: '100%',
    minHeight: '20rem',
  },
  '&.cm-focused': {
    outline: '2px solid var(--ring)',
    outlineOffset: '1px',
  },
  '.cm-scroller': {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    lineHeight: '1.5',
  },
  '.cm-content': { caretColor: 'var(--foreground)', padding: '0.5rem 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'var(--accent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--muted)',
    color: 'var(--muted-foreground)',
    borderRight: '1px solid var(--border)',
    borderTopLeftRadius: 'var(--radius)',
    borderBottomLeftRadius: 'var(--radius)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--muted) 60%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' },
});

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: 'markdown' | 'text';
  /** Accessible name of the editing area (a <label> cannot point into the shadow tree). */
  label: string;
  className?: string;
}

/**
 * CodeMirror 6, mounted inside a shadow root (ADR 0006): there CodeMirror injects its styles as
 * constructable stylesheets (`adoptedStyleSheets`), not `<style>` elements the CSP blocks.
 * Uncontrolled inside, synced with `value` when it changes from outside. `language` and `label`
 * are read on mount: give the component a `key` per opened file.
 */
export function CodeEditor({ value, onChange, language, label, className }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const initialRef = useRef({ value, language, label });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    // StrictMode mounts twice: the second mount reuses the shadow root of the first.
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const initial = initialRef.current;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({ 'aria-label': initial.label }),
      theme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
    ];
    if (initial.language === 'markdown') extensions.push(markdown());
    const view = new EditorView({
      root,
      parent: root,
      state: EditorState.create({ doc: initial.value, extensions }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} data-testid="code-editor" className={cn('min-w-0', className)} />;
}
