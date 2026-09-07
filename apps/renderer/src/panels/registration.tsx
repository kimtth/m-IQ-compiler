import type { JSX } from "react";
import { useAction, type Action } from "../useAction.js";

/**
 * What the three registration cards genuinely share.
 *
 * Azure AI Speech, the Fabric project and the Fabric Data Agent are three
 * separate registrations and they are *not* one shape: different channels,
 * different status contracts, different fields, and one of them shows the
 * skill pack it depends on beside the form. Forcing them behind a single
 * generic `RegistrationForm<T>` would be an abstraction wider than the thing it
 * abstracts, which is the failure mode this whole exercise is trying to avoid.
 *
 * What *is* one shape is the envelope — and it is not shared by these three
 * cards alone, so it lives in {@link useAction} with every other surface's. What
 * remains here is the markup they share.
 */

export type Registration = Action;

export const useRegistration = useAction;


/**
 * One labelled input.
 *
 * `<label>` is inline and this app has no global `label` rule, so a bare
 * `label > text + input + hint` reflows into one paragraph and the hint of one
 * field lands on the caption line of the next. `.field` is the grid that fixes
 * it — stated once here rather than rediscovered per card.
 */
export function FormField({
  label,
  value,
  placeholder,
  hint,
  mono,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  /** For values that are identifiers rather than prose — a GUID, a URL. */
  mono?: boolean;
  onChange: (next: string) => void;
}): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className={mono === true ? "mono" : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint !== undefined && <span className="muted">{hint}</span>}
    </label>
  );
}
