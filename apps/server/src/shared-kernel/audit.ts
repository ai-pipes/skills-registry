export interface AuditLog {
  record(entry: {
    actorId: string | null;
    action: string;
    target?: string;
    meta?: Record<string, unknown>;
  }): Promise<void>;
}
