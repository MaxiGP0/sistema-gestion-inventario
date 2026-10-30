'use client';

import { Minus, Plus } from 'lucide-react';
import Button from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';

export interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  label?: string;
  decreaseLabel?: string;
  increaseLabel?: string;
  className?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Stepper de cantidad con entrada directa. Los controles mantienen 44 px en
 * mobile y 36 px en escritorio; el valor expone rol de spinbutton.
 */
export default function QuantityStepper({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  disabled = false,
  label = 'Cantidad',
  decreaseLabel = 'Restar una unidad',
  increaseLabel = 'Sumar una unidad',
  className,
}: QuantityStepperProps) {
  const clampedValue = clamp(value, min, max);
  const canDecrease = !disabled && clampedValue > min;
  const canIncrease = !disabled && clampedValue < max;

  const update = (next: number) => {
    onChange(clamp(next, min, max));
  };

  const handleInput = (raw: string) => {
    const digits = raw.replace(/[^\d]/g, '');
    update(digits ? Number.parseInt(digits, 10) : min);
  };

  return (
    <div
      className={cn(
        'inline-flex items-center overflow-hidden rounded-md border border-border-strong bg-field',
        disabled && 'opacity-60',
        className,
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="rounded-none border-r border-border"
        onClick={() => update(clampedValue - step)}
        disabled={!canDecrease}
        aria-label={decreaseLabel}
      >
        <Minus className="h-4 w-4" aria-hidden="true" />
      </Button>

      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={clampedValue}
        disabled={disabled}
        role="spinbutton"
        aria-label={label}
        aria-valuenow={clampedValue}
        aria-valuemin={min}
        aria-valuemax={max === Number.MAX_SAFE_INTEGER ? undefined : max}
        onChange={(event) => handleInput(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        className="h-9 w-10 border-0 bg-transparent text-center text-sm font-semibold tabular-nums text-foreground outline-none focus:ring-2 focus:ring-inset focus:ring-focus max-md:h-11 max-md:w-12 max-md:text-base"
      />

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="rounded-none border-l border-border"
        onClick={() => update(clampedValue + step)}
        disabled={!canIncrease}
        aria-label={increaseLabel}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
