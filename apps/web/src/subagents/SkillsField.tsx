import { XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSkills } from '@/api/queries.ts';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { strings } from '@/strings.ts';

const t = strings.subagentEditor;
const SEARCH_DEBOUNCE_MS = 200;

interface SkillsFieldProps {
  value: string[];
  onChange: (skills: string[]) => void;
  /** A server error (e.g. `unknown_skill`) to show under the field. */
  error?: string | null;
}

/** Chips of the chosen skills and a search box that suggests active skills by slug or text. */
export function SkillsField({ value, onChange, error }: SkillsFieldProps) {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);
  const skills = useSkills({ status: 'active', q, enabled: q !== '' });
  const searching = q !== '';
  const suggestions = (skills.data ?? []).filter((s) => !value.includes(s.slug)).slice(0, 8);

  function add(slug: string) {
    onChange([...value, slug]);
    setInput('');
    setQ('');
  }

  return (
    <div role="group" aria-label={t.skills} className="flex max-w-md flex-col gap-2">
      <Label htmlFor="subagent-skills-search">{t.skills}</Label>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {value.map((slug) => (
            <li key={slug}>
              <Badge variant="secondary" className="gap-1">
                {slug}
                <button
                  type="button"
                  aria-label={t.removeSkill(slug)}
                  onClick={() => onChange(value.filter((s) => s !== slug))}
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Input
        id="subagent-skills-search"
        value={input}
        placeholder={t.skillsSearch}
        autoComplete="off"
        spellCheck={false}
        aria-describedby="subagent-skills-hint"
        onChange={(e) => setInput(e.target.value)}
      />
      <p id="subagent-skills-hint" className="text-sm text-muted-foreground">
        {t.skillsHint}
      </p>
      {input.trim() !== '' && searching && skills.data !== undefined && (
        <ul aria-label={t.skillsSuggestions} className="flex flex-col divide-y rounded-lg border">
          {suggestions.length === 0 ? (
            <li className="p-2 text-sm text-muted-foreground">{t.skillsNone}</li>
          ) : (
            suggestions.map((s) => (
              <li key={s.slug}>
                <button
                  type="button"
                  className="flex w-full flex-col items-start gap-0.5 p-2 text-left text-sm hover:bg-muted"
                  onClick={() => add(s.slug)}
                >
                  <span className="font-mono">{s.slug}</span>
                  <span className="text-muted-foreground">{s.description}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
