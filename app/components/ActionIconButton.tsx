"use client";

import type { ButtonHTMLAttributes } from "react";

type ActionIconName =
  | "copy"
  | "trash"
  | "minus"
  | "edit"
  | "export"
  | "restore"
  | "undo"
  | "redo"
  | "save"
  | "history"
  | "highlight"
  | "user"
  | "users"
  | "signIn"
  | "signOut"
  | "finish"
  | "wait"
  | "unlock"
  | "plus";

interface ActionIconProps {
  name: ActionIconName;
}

export function ActionIcon({ name }: ActionIconProps): React.JSX.Element {
  if (name === "user") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20 21a8 8 0 0 0-16 0" />
        <path d="M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" />
      </svg>
    );
  }

  if (name === "users") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M16 21a6 6 0 0 0-12 0" />
        <path d="M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
        <path d="M22 21a5 5 0 0 0-4-4.9" />
        <path d="M17 3.5a4 4 0 0 1 0 7" />
      </svg>
    );
  }

  if (name === "signIn") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M14 3h5v18h-5" />
        <path d="M4 12h11" />
        <path d="m11 8 4 4-4 4" />
      </svg>
    );
  }

  if (name === "signOut") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M10 3H5v18h5" />
        <path d="M9 12h11" />
        <path d="m16 8 4 4-4 4" />
      </svg>
    );
  }

  if (name === "finish") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m5 13 4 4L19 7" />
      </svg>
    );
  }

  if (name === "wait") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }

  if (name === "unlock") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="4" y="11" width="16" height="9" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 7.6-1.7" />
      </svg>
    );
  }

  if (name === "plus") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </svg>
    );
  }

  if (name === "undo") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h10a6 6 0 0 1 0 12h-4" />
      </svg>
    );
  }

  if (name === "redo") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m15 14 5-5-5-5" />
        <path d="M20 9H10a6 6 0 0 0 0 12h4" />
      </svg>
    );
  }

  if (name === "save") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M5 3h12l2 2v16H5Z" />
        <path d="M8 3v6h8V3" />
        <path d="M8 21v-7h8v7" />
      </svg>
    );
  }

  if (name === "history") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v6h6" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }

  if (name === "highlight") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m12 3 2.2 5.3L20 9l-4.4 3.7L17 18l-5-2.8L7 18l1.4-5.3L4 9l5.8-.7Z" />
      </svg>
    );
  }

  if (name === "edit") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
      </svg>
    );
  }

  if (name === "export") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3v12" />
        <path d="m7 8 5-5 5 5" />
        <path d="M5 15v4h14v-4" />
      </svg>
    );
  }

  if (name === "restore") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v6h6" />
      </svg>
    );
  }

  if (name === "copy") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </svg>
    );
  }

  if (name === "minus") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M5 12h14" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 6h18" />
      <path d="M8 6V4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v2" />
      <path d="M19 6l-1 14c-.1 1.1-1 2-2.1 2H8.1C7 22 6.1 21.1 6 20L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

interface ActionIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: ActionIconName;
  label: string;
}

export default function ActionIconButton({
  icon,
  label,
  className = "",
  type = "button",
  title,
  ...props
}: ActionIconButtonProps): React.JSX.Element {
  return (
    <button
      {...props}
      type={type}
      className={["btn", "action-icon-button", className].filter(Boolean).join(" ")}
      title={title ?? label}
      aria-label={label}
    >
      <ActionIcon name={icon} />
      <span className="action-icon-label">{label}</span>
    </button>
  );
}
