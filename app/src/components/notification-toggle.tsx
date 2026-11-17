"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { signInWithGitHub } from "@/lib/sign-in";
import { extractErrorMessage } from "@/lib/fetch-error";
import { isValidLogin } from "@/lib/login";
import {
  ALLOWED_EVENT_TYPES,
  type AllowedEventType,
  eventTypeLabel,
  defaultEventTypes,
} from "./notification-helpers";

type NotificationRequestState =
  { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string };

/**
 * Subscribe/unsubscribe to GitHub Issues notifications for a repo,
 * with an event-type picker disclosure.
 */
export function NotificationToggle({
  repoId,
  repoFullName,
  initialSubscribed,
  initialEventTypes,
}: {
  repoId: string;
  /**
   * "owner/name" — same screen-reader rationale as BookmarkToggle's
   * repoFullName prop: a multi-repo page that rendered N of these would
   * otherwise announce N identical "Sign in with GitHub to subscribe
   * to notifications" labels with no way to tell them apart. The per-repo
   * page knows both already; RepoCard has them on the row's `repo`.
   */
  repoFullName: string;
  initialSubscribed: boolean;
  /** Initial event types from the server (when subscribed). */
  initialEventTypes: AllowedEventType[];
}): React.JSX.Element {
  const { data: session } = useSession();
  const rawLogin = session?.user?.login;
  const login = isValidLogin(rawLogin) ? rawLogin : undefined;
  const [subscribed, setSubscribed] = useState(initialSubscribed);
  const [eventTypes, setEventTypes] = useState<AllowedEventType[]>(
    initialSubscribed ? initialEventTypes : defaultEventTypes(),
  );
  const [request, setRequest] = useState<NotificationRequestState>({ kind: "idle" });
  const [isOpen, setIsOpen] = useState(false);
  const disclosureRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const checkboxRefs = useRef<Map<AllowedEventType, HTMLInputElement>>(new Map());

  const signedOutLabel = `Sign in with GitHub to subscribe to notifications for ${repoFullName}`;
  const signedInLabel = subscribed
    ? `Unsubscribe from notifications for ${repoFullName}`
    : `Subscribe to notifications for ${repoFullName}`;

  // Focus management: trap focus within disclosure when open
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDisclosure();
      } else if (event.key === "Tab") {
        const focusableElements = disclosureRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusableElements || focusableElements.length === 0) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        if (!firstElement || !lastElement) return;

        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        } else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    // Focus the first checkbox on open
    const firstCheckbox = checkboxRefs.current.get(ALLOWED_EVENT_TYPES[0]);
    firstCheckbox?.focus();

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Close disclosure when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (disclosureRef.current && !disclosureRef.current.contains(event.target as Node)) {
        closeDisclosure();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const closeDisclosure = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openDisclosure = useCallback(() => {
    setIsOpen(true);
  }, []);

  const toggleDisclosure = useCallback(() => {
    if (isOpen) {
      closeDisclosure();
    } else {
      openDisclosure();
    }
  }, [isOpen, closeDisclosure, openDisclosure]);

  async function handleSubscribe(): Promise<void> {
    setRequest({ kind: "pending" });
    try {
      const response = await fetch(`/api/repos/${repoId}/notifications/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventTypes }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        setRequest({
          kind: "error",
          message: extractErrorMessage(data) ?? "Something went wrong.",
        });
        return;
      }
      setRequest({ kind: "idle" });
      setSubscribed(true);
      closeDisclosure();
    } catch {
      setRequest({ kind: "error", message: "Network error — try again." });
    }
  }

  async function handleUnsubscribe(): Promise<void> {
    setRequest({ kind: "pending" });
    try {
      const response = await fetch(`/api/repos/${repoId}/notifications/unsubscribe`, {
        method: "POST",
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        setRequest({
          kind: "error",
          message: extractErrorMessage(data) ?? "Something went wrong.",
        });
        return;
      }
      setRequest({ kind: "idle" });
      setSubscribed(false);
      // Reset to defaults for next subscribe
      setEventTypes(defaultEventTypes());
    } catch {
      setRequest({ kind: "error", message: "Network error — try again." });
    }
  }

  function handleCheckboxChange(type: AllowedEventType, checked: boolean): void {
    setEventTypes((prev) =>
      checked
        ? [...prev, type].sort(
            (a, b) => ALLOWED_EVENT_TYPES.indexOf(a) - ALLOWED_EVENT_TYPES.indexOf(b),
          )
        : prev.filter((t) => t !== type),
    );
  }

  if (!isValidLogin(login)) {
    return (
      <button
        type="button"
        onClick={() => void signInWithGitHub()}
        title={signedOutLabel}
        aria-label={signedOutLabel}
        className="shrink-0 p-0.5 font-mono text-xs leading-none text-ink-muted hover:text-ink"
      >
        Notify
      </button>
    );
  }

  const pending = request.kind === "pending";
  const errorMessage = request.kind === "error" ? request.message : null;

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5" ref={disclosureRef}>
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          disabled={pending}
          onClick={subscribed ? handleUnsubscribe : toggleDisclosure}
          aria-pressed={subscribed}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label={signedInLabel}
          title={signedInLabel}
          // Same treatment as BookmarkToggle: `aria-pressed` is the
          // source of truth for the "on" state for both assistive tech
          // and sighted users (the active class changes the color). The
          // older "Notify ✓" added a redundant glyph and shifted the
          // screen-reader announcement between idle/active/pending.
          className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors disabled:opacity-50 ${
            subscribed
              ? "border-accent bg-accent/10 text-accent"
              : "border-border text-ink-muted hover:border-ink-muted hover:text-ink"
          }`}
        >
          {pending ? "..." : "Notify"}
        </button>

        {isOpen && (
          <div
            role="listbox"
            aria-label={`Notification event types for ${repoFullName}`}
            className="absolute right-0 top-full z-10 mt-1 w-64 rounded-md border border-border bg-surface p-2 shadow-lg"
          >
            <div role="group" aria-labelledby="event-types-label" className="flex flex-col gap-1.5">
              <p id="event-types-label" className="px-1 text-[11px] font-medium text-ink-muted">
                Notify me about…
              </p>
              {ALLOWED_EVENT_TYPES.map((type) => (
                <label
                  key={type}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent/5"
                >
                  <input
                    type="checkbox"
                    ref={(el) => {
                      if (el) checkboxRefs.current.set(type, el);
                      else checkboxRefs.current.delete(type);
                    }}
                    checked={eventTypes.includes(type)}
                    onChange={(e) => handleCheckboxChange(type, e.target.checked)}
                    disabled={pending}
                    className="rounded border-border text-accent focus-visible:outline-1 focus-visible:outline-accent"
                    aria-selected={eventTypes.includes(type)}
                  />
                  <span className="text-[11px] leading-none text-ink">{eventTypeLabel(type)}</span>
                </label>
              ))}
            </div>
            <div className="mt-2 flex justify-end gap-1.5 border-t border-border pt-2">
              <button
                type="button"
                onClick={closeDisclosure}
                disabled={pending}
                className="rounded-sm px-2 py-1 font-mono text-[11px] text-ink-muted hover:bg-border hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubscribe}
                disabled={pending || eventTypes.length === 0}
                className="rounded-sm bg-accent px-2 py-1 font-mono text-[11px] text-white disabled:opacity-50"
              >
                {pending ? "..." : "Subscribe"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div role="status" aria-live="polite">
        {errorMessage !== null && (
          <p className="text-[10px] leading-tight text-status-error">{errorMessage}</p>
        )}
      </div>
    </div>
  );
}
