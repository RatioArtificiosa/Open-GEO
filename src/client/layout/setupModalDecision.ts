/**
 * The setup-modal open/close decision, as a pure function.
 *
 * CL-106's modal re-opened after dismissal because the AppShell effect wrote
 * `setShow(!configured)` unconditionally: every refetch (a fresh object
 * identity) and every navigation re-ran the effect and overwrote the
 * dismissal. The fix guards on a session dismissal flag — and this module
 * exists so that contract is pinned without a DOM: the public vitest env is
 * node, and `src/client/layout/` previously had no test files at all.
 *
 * Three outcomes, never two: `true` opens, `false` closes, `null` leaves the
 * current visibility alone. Collapsing "leave alone" into either boolean is
 * the bug in miniature — a pending query is not evidence the key is missing,
 * and a configured key is not an instruction to close a modal the user never
 * saw.
 */
type SetupModalInput = {
  /** False on routes where the key status is never checked (billing). */
  shouldCheck: boolean;
  /** The status query errored: unknown status closes, never opens. */
  isError: boolean;
  /** The status query resolved (successfully or not). */
  isSuccess: boolean;
  /** The key is configured. Null while unresolved. */
  configured: boolean | null;
  /** The user dismissed the modal this session (never persisted). */
  dismissed: boolean;
};

export function resolveSetupModal(input: SetupModalInput): boolean | null {
  if (!input.shouldCheck) return false;
  if (input.isError) return false;
  if (!input.isSuccess) return null;
  if (!input.configured && !input.dismissed) return true;
  return null;
}
