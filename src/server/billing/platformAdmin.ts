/**
 * Who may change the operator billing settings.
 *
 * ## Why an allowlist rather than a role
 *
 * The admin surface this gates is an MVP: one dial, one owner. Adding a
 * `platform_admin` role to the schema means a migration, a role-assignment UI,
 * and a revival path through better-auth's organization plugin, all before the
 * first setting can be changed. The allowlist is one env binding and the same
 * shape of decision, and it is honest about what it is — a single deployment's
 * owner, named in its configuration.
 *
 * It is a *narrow* gate on purpose. The dial sets the platform's margin, which
 * is the one number a stranger must never reach, so an empty allowlist denies
 * everyone rather than failing open. A deployment that has not configured an
 * owner has no owner.
 */

/**
 * A comma-separated list of user ids. Note that this is the *user* id, not the
 * organization id: the markup is a property of the platform, not of a tenant,
 * so a tenant's administrator must never be able to reach it.
 */
export const PLATFORM_ADMIN_ENV_VAR = "PLATFORM_ADMIN_USER_IDS";

/**
 * Resolve the owner allowlist. Unparseable, empty and absent all mean "no
 * owners", which denies every request.
 */
export function listPlatformAdminUserIds(
  raw: string | undefined | null,
): string[] {
  if (raw === undefined || raw === null) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether this user may change the platform's operator settings.
 */
export function isPlatformAdmin(
  userId: string,
  raw: string | undefined | null,
): boolean {
  return listPlatformAdminUserIds(raw).includes(userId);
}
