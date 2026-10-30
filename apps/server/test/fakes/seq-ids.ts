import type { IdGenerator } from '../../src/modules/catalog/application/ports.ts';

export class SeqIds implements IdGenerator {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`;
  }
}
