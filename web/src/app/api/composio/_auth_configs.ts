/**
 * Per-toolkit Composio auth_config_id resolver.
 *
 * Composio v3 auth configs are pre-registered OAuth app templates created
 * in the Composio dashboard. Each toolkit can have its own:
 *   COMPOSIO_AUTH_CONFIG_GMAIL    = ac_xxx
 *   COMPOSIO_AUTH_CONFIG_SHEETS   = ac_xxx
 *   COMPOSIO_AUTH_CONFIG_CALENDAR = ac_xxx
 *   COMPOSIO_AUTH_CONFIG_DRIVE    = ac_xxx
 *
 * Returns undefined when not set — the SDK then falls back to Composio's
 * built-in default OAuth app.
 */
export function authConfigFor(
  toolkit: "gmail" | "sheets" | "calendar" | "drive",
): string | undefined {
  const map: Record<string, string | undefined> = {
    gmail:    process.env.COMPOSIO_AUTH_CONFIG_GMAIL,
    sheets:   process.env.COMPOSIO_AUTH_CONFIG_SHEETS,
    calendar: process.env.COMPOSIO_AUTH_CONFIG_CALENDAR,
    drive:    process.env.COMPOSIO_AUTH_CONFIG_DRIVE,
  };
  return map[toolkit];
}
