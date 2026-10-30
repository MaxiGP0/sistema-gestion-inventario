import { cn } from '@/components/ui/cn';

export interface SkeletonProps {
  className?: string;
}

/** Bloque de carga sin cifras ficticias; respeta prefers-reduced-motion. */
export default function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-border motion-reduce:animate-none', className)}
    />
  );
}
