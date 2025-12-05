/**
 * TransitionNavLink Component
 * A NavLink wrapper that integrates with the View Transition system
 * Provides smooth page transitions when clicking navigation links
 */

import { useCallback, useContext, type MouseEvent } from "react";
import { NavLink, useLocation, useNavigate, useResolvedPath } from "react-router-dom";
import { ViewTransitionContext } from "./provider";
import { startViewTransition } from "./transition-core";
import type { TransitionLinkProps } from "./types";

/**
 * TransitionNavLink - A NavLink with View Transition support
 *
 * @example
 * ```tsx
 * <TransitionNavLink to="/about" type="slide-left" duration={300}>
 *   About
 * </TransitionNavLink>
 * ```
 */
export function TransitionNavLink({
  to,
  type = "fade",
  duration = 300,
  children,
  className,
  end,
  ...rest
}: TransitionLinkProps) {
  const routerNavigate = useNavigate();
  const location = useLocation();
  const resolvedPath = useResolvedPath(to);
  const { setTransitionState, prefersReducedMotion } = useContext(ViewTransitionContext);

  // Check if we're already on the target route
  const isCurrentRoute = location.pathname === resolvedPath.pathname;

  const handleClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();

      // Skip navigation entirely if already on the same route
      if (isCurrentRoute) {
        return;
      }

      // Skip animation if reduced motion preference or type is 'none'
      if (prefersReducedMotion || type === "none") {
        routerNavigate(to);
        return;
      }

      startViewTransition({
        type,
        duration,
        onNavigate: () => routerNavigate(to),
        onStateChange: setTransitionState,
      });
    },
    [to, type, duration, routerNavigate, setTransitionState, prefersReducedMotion, isCurrentRoute]
  );

  return (
    <NavLink to={to} end={end} className={className} onClick={handleClick} {...rest}>
      {children}
    </NavLink>
  );
}
