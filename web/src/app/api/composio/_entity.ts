/**
 * Per-toolkit Composio entity (userId) resolver.
 *
 * Composio scopes connected accounts by (entityId, toolkit). When two
 * toolkits were connected under different entities (e.g. Sheets under
 * "cris-refire", Drive under "untown-sial"), a single COMPOSIO_USER_ID
 * env can only target one of them.
 *
 * Each toolkit can override the default with COMPOSIO_USER_ID_<TOOLKIT>:
 *   COMPOSIO_USER_ID            = default (fallback)
 *   COMPOSIO_USER_ID_GMAIL      = override for gmail toolkit
 *   COMPOSIO_USER_ID_SHEETS     = override for googlesheets
 *   COMPOSIO_USER_ID_CALENDAR   = override for googlecalendar
 *   COMPOSIO_USER_ID_DRIVE      = override for googledrive
 */
export function entityFor(toolkit: "gmail" | "sheets" | "calendar" | "drive"): string {
  const map: Record<string, string | undefined> = {
    gmail:    process.env.COMPOSIO_USER_ID_GMAIL,
    sheets:   process.env.COMPOSIO_USER_ID_SHEETS,
    calendar: process.env.COMPOSIO_USER_ID_CALENDAR,
    drive:    process.env.COMPOSIO_USER_ID_DRIVE,
  };
  return map[toolkit] ?? process.env.COMPOSIO_USER_ID ?? "default";
}
