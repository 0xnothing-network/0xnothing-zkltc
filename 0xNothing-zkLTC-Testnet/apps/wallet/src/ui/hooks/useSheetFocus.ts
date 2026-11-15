import { type RefObject, useEffect, useRef } from "react";
import { enterSheet, type FocusTarget } from "../lib/sheetFocus";

/**
 * Ref for a sheet's dialog element (give it tabIndex={-1}). While `open`, focus
 * moves into the sheet; when it closes or unmounts, focus goes back to the
 * control that had it before the sheet opened.
 */
export function useSheetFocus<T extends HTMLElement>(open = true): RefObject<T | null> {
  const sheetRef = useRef<T>(null);
  const openerRef = useRef<FocusTarget | null>(null);
  const wasOpenRef = useRef(false);
  // Read during the render that opens the sheet, before React commits it: an
  // autoFocus field inside takes focus during that commit, so an effect would
  // see the field instead of the control that opened the sheet.
  if (open && !wasOpenRef.current && typeof document !== "undefined") {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpenRef.current = open;

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!open || sheet === null) return undefined;
    return enterSheet(sheet, openerRef.current, document.activeElement);
  }, [open]);

  return sheetRef;
}
