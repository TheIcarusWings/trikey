import { AlertTriangle } from 'lucide-react';
import type { ApiError } from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function ErrorState({
  error,
  onRetry,
  title = "Couldn't load this page",
  className,
}: {
  error: ApiError | Error;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <Alert variant="destructive" role="alert" className={cn('max-w-3xl', className)}>
      <AlertTriangle aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </div>
        {onRetry && (
          <Button variant="outline" size="sm" className="w-fit" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </Alert>
  );
}

/** Placeholder blocks while a page loads. Announces "Loading" once to screen readers. */
export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="flex max-w-3xl flex-col gap-4">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-24 w-full rounded-xl" />
      ))}
    </div>
  );
}
