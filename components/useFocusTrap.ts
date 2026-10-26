import { useEffect, type RefObject } from "react";

/**
 * Trap Tab focus inside a container while `active` and restore focus to the
 * previously focused element on deactivation (WCAG 2.4.3): a keyboard user
 * must not be able to Tab behind an open modal, and focus must return to the
 * control that opened it when the modal closes.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Tab" || !node) return;
      const focusables = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      const inside = current instanceof Node && node.contains(current);
      if (event.shiftKey && (!inside || current === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || current === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    // Capture phase: the trap must answer before any inner handler stops the
    // event, and it applies whichever element inside the modal has focus.
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      // Restore the opener's focus; it may have scrolled away or unmounted.
      try { previouslyFocused?.focus(); } catch { /* detached node */ }
    };
  }, [ref, active]);
}
