/**
 * Keyboard focus for the bottom sheets: into the sheet when it opens, back to
 * the control that opened it when it closes. No inert and no focus trap: the
 * sheet covers the screen, and Tab may still leave it as before.
 * Import-free (structural types only) so a test can drive it without a DOM.
 */
export interface FocusTarget {
  focus(options?: { preventScroll?: boolean }): void;
  /** False once the element left the document (its screen went away). */
  isConnected?: boolean;
}

export interface SheetElement extends FocusTarget {
  contains(node: unknown): boolean;
}

/**
 * Moves focus to the sheet itself unless something inside already has it (an
 * autoFocus field takes it while React commits the sheet). Returns the hand-back
 * to run when the sheet closes; an opener that is gone is left alone.
 */
export function enterSheet(sheet: SheetElement, opener: FocusTarget | null, active: unknown): () => void {
  if (!sheet.contains(active)) sheet.focus({ preventScroll: true });
  return () => {
    if (opener !== null && opener !== sheet && opener.isConnected !== false) {
      opener.focus({ preventScroll: true });
    }
  };
}
