import { useRef } from "react";
import { createActionGate, type ActionGate } from "../lib/actionGate";

/** Keep one synchronous action gate for the lifetime of a mounted screen. */
export function useActionGate(): ActionGate {
  const gateRef = useRef<ActionGate | null>(null);
  if (gateRef.current === null) gateRef.current = createActionGate();
  return gateRef.current;
}

