import { BUILTIN_TOOL_PATTERN, MCP_TOOL_PATTERN } from '@skills/contracts';
import { XIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { strings } from '@/strings.ts';

const t = strings.subagentEditor;

/** The built-in tools offered as checkboxes; any other tool is typed in. */
const COMMON_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash',
  'WebFetch',
  'WebSearch',
] as const;

interface ToolsFieldProps {
  /** `null`: inherit all tools. */
  value: string[] | null;
  onChange: (tools: string[] | null) => void;
  /** A server error to show under the field. */
  error?: string | null;
}

/** "Inherit all tools" toggle, checkboxes of the common tools and free entry for the rest. */
export function ToolsField({ value, onChange, error }: ToolsFieldProps) {
  const [entry, setEntry] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  const tools = value ?? [];
  const custom = tools.filter((tool) => !COMMON_TOOLS.some((c) => c === tool));
  const missing = value !== null && value.length === 0;
  const shownError = entryError ?? (missing ? t.toolsRequired : (error ?? null));

  function toggleTool(tool: string, on: boolean) {
    onChange(on ? [...tools, tool] : tools.filter((x) => x !== tool));
  }

  function addCustom(e: FormEvent) {
    e.preventDefault();
    const tool = entry.trim();
    if (tool === '') return;
    if (!BUILTIN_TOOL_PATTERN.test(tool) && !MCP_TOOL_PATTERN.test(tool)) {
      return setEntryError(t.toolInvalid);
    }
    if (tools.includes(tool)) return setEntryError(t.toolDuplicate);
    onChange([...tools, tool]);
    setEntry('');
    setEntryError(null);
  }

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">{t.tools}</legend>
      <Label className="flex items-center gap-2">
        <Checkbox checked={value === null} onCheckedChange={(on) => onChange(on ? null : [])} />
        {t.inheritTools}
      </Label>
      {value !== null && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {COMMON_TOOLS.map((tool) => (
              <Label key={tool} className="flex items-center gap-2 font-mono text-sm">
                <Checkbox
                  checked={tools.includes(tool)}
                  onCheckedChange={(on) => toggleTool(tool, on)}
                />
                {tool}
              </Label>
            ))}
          </div>
          {custom.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {custom.map((tool) => (
                <li key={tool}>
                  <Badge variant="secondary" className="gap-1 font-mono">
                    {tool}
                    <button
                      type="button"
                      aria-label={t.removeTool(tool)}
                      onClick={() => toggleTool(tool, false)}
                    >
                      <XIcon aria-hidden className="size-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="flex max-w-md flex-col gap-2">
            <Label htmlFor="subagent-other-tool">{t.otherTool}</Label>
            <div className="flex gap-2">
              <Input
                id="subagent-other-tool"
                value={entry}
                spellCheck={false}
                autoComplete="off"
                aria-describedby="subagent-other-tool-hint"
                onChange={(e) => {
                  setEntry(e.target.value);
                  setEntryError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addCustom(e);
                }}
              />
              <Button type="button" variant="outline" onClick={addCustom}>
                {t.addTool}
              </Button>
            </div>
            <p id="subagent-other-tool-hint" className="text-sm text-muted-foreground">
              {t.otherToolHint}
            </p>
          </div>
        </>
      )}
      {shownError && (
        <p role="alert" className="text-sm text-destructive">
          {shownError}
        </p>
      )}
    </fieldset>
  );
}

/** True when the form's tools cannot be published: the toggle is off and nothing is selected. */
export function toolsMissing(tools: string[] | null): boolean {
  return tools !== null && tools.length === 0;
}
