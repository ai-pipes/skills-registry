import { CopyIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { notify } from '@/lib/notify.ts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { strings } from '@/strings.ts';

export interface CopyFieldProps {
  label: string;
  value: string;
}

/**
 * Read-only value with a copy button. `navigator.clipboard` needs a secure context (HTTPS or
 * localhost); where it is missing or refuses, the text is selected and a hint says to copy it.
 */
export function CopyField({ label, value }: CopyFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const input = useRef<HTMLInputElement>(null);
  const [failed, setFailed] = useState(false);

  async function copy() {
    try {
      // `clipboard` is undefined outside secure contexts, which the try turns into a failure.
      await navigator.clipboard.writeText(value);
      setFailed(false);
      notify.success(strings.copy.copied);
    } catch {
      input.current?.focus();
      input.current?.select();
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          ref={input}
          readOnly
          value={value}
          className="font-mono text-xs"
          aria-describedby={failed ? hintId : undefined}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`${strings.copy.copy}: ${label}`}
          title={strings.copy.copy}
          onClick={() => void copy()}
        >
          <CopyIcon aria-hidden />
        </Button>
      </div>
      {failed && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {strings.copy.failed}
        </p>
      )}
    </div>
  );
}
