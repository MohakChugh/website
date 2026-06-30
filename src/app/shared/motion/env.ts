/** Shared environment guards for motion effects. Browser-only callers. */

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function hasFinePointer(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches;
}

/** True when pointer-driven motion (tilt, magnetic, cursor) should run. */
export function pointerMotionEnabled(): boolean {
  return hasFinePointer() && !prefersReducedMotion();
}
