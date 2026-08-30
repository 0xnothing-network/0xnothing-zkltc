/**
 * A synchronous companion to React's async `busy` state. State updates disable
 * the controls on the next render; this gate also rejects a second invocation
 * that reaches the handler before that render happens.
 */
export interface ActionGate {
  tryEnter: () => boolean;
  leave: () => void;
}

export function createActionGate(): ActionGate {
  let active = false;
  return {
    tryEnter() {
      if (active) return false;
      active = true;
      return true;
    },
    leave() {
      active = false;
    },
  };
}

