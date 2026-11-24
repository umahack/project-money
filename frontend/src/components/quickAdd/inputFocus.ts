// A small registry of the mounted Quick Add inputs, so that code outside the input (a warning button that
// disappears after it saves, the floating action, the shortcut host, the undo action) can return keyboard focus to
// the input without a DOM query. Nothing here is state that survives a page load, and nothing reads the typed text.
//
// Requirements: 7.3 (focus stays in the input for the next entry), 8.7 (focus returns to the input after Undo).

const inputs = new Set<HTMLInputElement>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

/** Registers a mounted input. Returns the function that removes it. The newest registered input wins. */
export function registerQuickAddInput(input: HTMLInputElement | null): () => void {
  if (!input) return () => undefined;
  inputs.add(input);
  notify();
  return () => {
    inputs.delete(input);
    notify();
  };
}

/** For `useSyncExternalStore`: tells a component when a Quick Add input mounts or unmounts. */
export function subscribeQuickAddInputs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while at least one Quick Add input is mounted, which means a Quick Add surface is on screen. */
export function hasQuickAddInput(): boolean {
  return inputs.size > 0;
}

/** The input that `focusQuickAddInput` would focus: the newest mounted one that is still in the document. */
export function currentQuickAddInput(): HTMLInputElement | null {
  const mounted = [...inputs].reverse();
  return mounted.find((input) => input.isConnected && !input.disabled) ?? null;
}

/** Moves keyboard focus to the Quick Add input. Returns false when no input is mounted. */
export function focusQuickAddInput(options: FocusOptions = {}): boolean {
  const input = currentQuickAddInput();
  if (!input) return false;
  input.focus(options);
  return true;
}
