import { redirect } from "@tanstack/react-router";

/**
 * beforeLoad guard for admin-only routes. Non-admins are bounced to /dashboard.
 * Reads `isAdmin` from _authenticated route context.
 */
export function requireAdminBeforeLoad({
  context,
}: {
  context: { isAdmin?: boolean };
}) {
  if (!context?.isAdmin) {
    throw redirect({ to: "/dashboard" });
  }
}