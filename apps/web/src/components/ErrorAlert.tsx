import { CircleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { isApiError } from '@/api/errors.ts';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils.ts';
import { strings } from '@/strings.ts';

/**
 * Russian text for a failed call. The client's own codes (`network_error`, `bad_response`,
 * `http_<status>`) already carry Russian messages; a server `ErrorBody` message is English, so
 * it is replaced by the generic HTTP text. Callers that know a code pass their own `message`.
 */
function describeError(error: unknown): string {
  if (!isApiError(error)) return strings.errors.unknown;
  if (error.code === 'network_error' || error.code === 'bad_response') return error.message;
  return strings.errors.http(error.status);
}

export interface ErrorAlertProps {
  /** The failure; its text comes from `describeError` unless `message` is given. */
  error?: unknown;
  message?: ReactNode;
  title?: string;
  className?: string;
}

/** Page-level error (constraints: form errors go under the field, success into a toast). */
export function ErrorAlert({ error, message, title, className }: ErrorAlertProps) {
  return (
    <Card role="alert" className={cn('border-destructive/50', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <CircleAlertIcon aria-hidden className="size-4" />
          {title ?? strings.errors.title}
        </CardTitle>
        <CardDescription>{message ?? describeError(error)}</CardDescription>
      </CardHeader>
    </Card>
  );
}
