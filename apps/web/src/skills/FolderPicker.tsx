import type { FolderRef } from '@skills/contracts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { strings } from '@/strings.ts';

interface FolderPickerProps {
  folders: FolderRef[];
  value: string;
  onChange: (slug: string) => void;
  label: string;
}

/** Select of folders by name; value is the folder slug, '' means nothing chosen. */
export function FolderPicker({ folders, value, onChange, label }: FolderPickerProps) {
  const items = folders.map((f) => ({ value: f.slug, label: f.name }));
  return (
    <Select items={items} value={value} onValueChange={(v) => typeof v === 'string' && onChange(v)}>
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue placeholder={strings.skill.chooseFolder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
