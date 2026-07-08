import { useSyncExternalStore } from "react";

type State = { open: boolean; target: string | null; accountId: string | null };
let state: State = { open: false, target: null, accountId: null };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const chatViewer = {
  open(target: string, accountId?: string | null) {
    state = { open: true, target, accountId: accountId ?? null };
    emit();
  },
  close() {
    state = { ...state, open: false };
    emit();
  },
  setAccount(id: string | null) {
    state = { ...state, accountId: id };
    emit();
  },
};

export function useChatViewer() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}