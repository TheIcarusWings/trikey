import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A button's classes, split for the view that places it and the button inside (which shrinks when pressed): padding,
 * height and radius style the button itself; the rest (margins, flex, width, alignment) place it.
 */
export function splitButtonClasses(className: string | undefined): { place: string; own: string } {
  const place: string[] = [];
  const own: string[] = [];
  for (const c of (className ?? '').split(/\s+/).filter(Boolean)) {
    (/^(p[xytrbl]?-|h-|min-h-|rounded)/.test(c) ? own : place).push(c);
  }
  return { place: place.join(' '), own: own.join(' ') };
}
