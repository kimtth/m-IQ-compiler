import { useCallback, useEffect, useRef } from "react";
import type { JSX, ReactNode } from "react";
import { X } from "lucide-react";

/**
 * A modal dialog.
 *
 * The app had none: every confirmation until now was an inline notice, which is
 * right for something that reports on work the user is watching. This is for
 * the other case — a result that arrives after the surface has moved on, and
 * that carries something to act on.
 *
 * Focus is moved into the dialog and put back where it was on close, because
 * the thing that opens one here is a delayed timer rather than a click: the
 * user may well be typing somewhere else when it appears, and a dialog that
 * steals the caret and does not give it back loses their place.
 *
 * Deliberately not `<dialog>`: `showModal()` has to be driven imperatively from
 * an effect, which puts the open state in two places at once (the DOM's and
 * React's) and they drift. The scrim is the same device `.menu-scrim` already
 * uses for the rail menu, so a click that dismisses cannot also press whatever
 * is underneath it.
 */

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional actions. The close button exists regardless. */
  footer?: ReactNode;
  /** Extra class on the card, for a dialog that needs a different width. */
  className?: string;
}

export function Modal({ title, onClose, children, footer, className }: ModalProps): JSX.Element {
  const card = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<Element | null>(null);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    restoreTo.current = document.activeElement;
    card.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const previous = restoreTo.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [close]);

  return (
    <>
      <div className="modal-scrim" onClick={close} />
      <div
        className={className ? `modal-card ${className}` : "modal-card"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={card}
      >
        <div className="modal-head">
          <strong>{title}</strong>
          <span className="spacer" />
          <button className="icon" onClick={close} aria-label="Close" title="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">
          {footer}
          <button className="primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}
