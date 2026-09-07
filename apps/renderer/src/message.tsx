import type { JSX, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * One message in a transcript.
 *
 * Three surfaces hold a conversation — Chat, My IQ and Connectome IQ — and
 * each drew its own until this existed. They had drifted apart: one put the
 * question in a right-aligned bubble with no speaker on it at all, one set the
 * whole exchange a type size down, one boxed every answer in a left rule. The
 * same exchange looked like three different products depending on where it was
 * held, and a reader who had learnt to read one had to learn the next.
 *
 * Chat is the base, so this is Chat's markup with the two things that really
 * vary named as props: who is talking, and anything that hangs off the speaker
 * line. Everything else — the side each role sits on, the tint on the user's
 * bubble, the agent having no box at all — is in `message-body.css` and is now
 * decided in exactly one place.
 */
export function ChatMessage({
  role,
  name,
  icon: Icon,
  action,
  children,
}: {
  role: "user" | "agent";
  /**
   * The speaker, spelled out.
   *
   * Not derived from the role, because the agent is not always the same agent:
   * Chat's answers come from IQ Compiler, My IQ's from the analysis, and
   * Connectome IQ's from whichever published IQ answered. The badge says which
   * side is talking; the name says which voice.
   */
  name: string;
  icon: LucideIcon;
  /** Anything that belongs beside the name — Chat puts its Speak control here. */
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`msg from-${role}`}>
      <div className="who">
        <span className="avatar" aria-hidden>
          <Icon size={13} />
        </span>
        {name}
        {action}
      </div>
      <div className="bubble">{children}</div>
    </div>
  );
}
