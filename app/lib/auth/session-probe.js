export const AUTH_SESSION_PROBE_TIMEOUT_MS = 1_800;

/**
 * Time-boxes the first auth snapshot without cancelling the underlying read.
 * A late valid result is still delivered so an already-signed-in operator can
 * upgrade from the honest wall without refreshing the page.
 */
export function startBoundedSessionProbe({
  probe,
  onDeadline,
  onResolved,
  timeoutMs = AUTH_SESSION_PROBE_TIMEOUT_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let active = true;
  let insideBudget = true;
  let deadlineEmitted = false;
  const releaseWall = () => {
    if (!active || deadlineEmitted) return;
    deadlineEmitted = true;
    onDeadline();
  };
  const timer = schedule(() => {
    if (!active) return;
    insideBudget = false;
    releaseWall();
  }, timeoutMs);

  Promise.resolve()
    .then(probe)
    .then((value) => {
      if (!active) return;
      cancel(timer);
      onResolved(value, { late: !insideBudget });
    })
    .catch(() => {
      if (!active) return;
      cancel(timer);
      releaseWall();
    });

  return () => {
    active = false;
    cancel(timer);
  };
}
