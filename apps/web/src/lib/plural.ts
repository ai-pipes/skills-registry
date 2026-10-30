// No imports: strings.ts uses this module.
const rules = new Intl.PluralRules('en');

/** English plural forms: 1 file, 2 files. */
interface PluralForms {
  one: string;
  other: string;
}

/** The form that agrees with `n`: 1 → `one`; 0, 2, 1.5 → `other`. */
export function plural(n: number, forms: PluralForms): string {
  return rules.select(n) === 'one' ? forms.one : forms.other;
}
