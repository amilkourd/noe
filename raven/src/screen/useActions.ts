import { useCallback, useRef, useState } from "react";
import { useNotice } from "./notices";

export type ActionKey = "toggle" | "duty" | "available" | "standDown" | "advance" | "backup";
export type Run = (key: ActionKey, fn: () => Promise<void>, failLabel: string) => Promise<boolean>;

// One action at a time: the pressed control shows the spinner, the others stay disabled,
// and a failure (useRaven has already reverted its optimistic patch) becomes a danger toast.
export function useActions(): { pending: ActionKey | null; run: Run } {
  const notice = useNotice();
  const [pending, setPending] = useState<ActionKey | null>(null);
  const inFlight = useRef(false); // state lags a render behind a double tap

  const run = useCallback<Run>(async (key, fn, failLabel) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(key);
    try {
      await fn();
      return true;
    } catch (e) {
      notice.fail(failLabel, e instanceof Error && e.message ? e.message : "NOÉ could not be reached.");
      return false;
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }, [notice]);

  return { pending, run };
}
