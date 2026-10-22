const DAY = 86400000;
const { FAILING, SIGNIN_ERROR } = require('./validate');

// Errors that point at the machine (expired login, no network), not at the tunnel.
// Built from SIGNIN_ERROR so an expired sign-in can never be charged toward auto-archive.
const CREDENTIAL_ERROR = new RegExp(`${SIGNIN_ERROR.source}|credentials|Unable to locate|could not connect to the endpoint|Name or service not known`, 'i');

const failingDays = (t) => Math.floor((t.failingMs || 0) / DAY);

// Advance the failure clocks by dtMs and archive tunnels that crossed the limit.
// Returns the names archived on this tick. archiveDays 0 means never archive.
//
// Time is not charged when every tunnel in use is failing (or only one is in use):
// that pattern means expired AWS login or no network, not a bad tunnel, and a
// single tunnel cannot be told apart from a global outage. A credential or
// endpoint error on the tunnel itself is treated the same way.
function tick(tunnels, stateOf, dtMs, archiveDays, now = Date.now()) {
  const live = tunnels.filter((t) => !t.archived);
  const inUse = live.filter((t) => stateOf(t.name).state !== 'idle');
  // 'waiting' (needs sign-in) is an outage, never a failing tunnel, so it neither accrues time nor exposes its neighbours.
  const globalOutage = inUse.length < 2 || inUse.every((t) => { const s = stateOf(t.name).state; return FAILING.has(s) || s === 'waiting'; });
  const archived = [];

  for (const t of live) {
    const { state, error } = stateOf(t.name);
    if (state === 'active') { t.failingMs = 0; continue; }
    if (!FAILING.has(state) || globalOutage) continue;
    if (CREDENTIAL_ERROR.test(error || '')) continue;
    t.failingMs = (t.failingMs || 0) + dtMs;
    if (archiveDays && t.failingMs >= archiveDays * DAY) {
      t.archived = true;
      t.archivedAt = now;
      archived.push(t.name);
    }
  }
  return archived;
}

// Remove archived tunnels older than purgeDays, in place. Returns the purged names.
// Legacy archived rows without archivedAt start their clock now. purgeDays 0 means never.
function purge(tunnels, now, purgeDays) {
  const purged = [];
  for (const t of tunnels) {
    if (t.archived === true && t.archivedAt == null) t.archivedAt = now;
  }
  if (!purgeDays) return purged;
  for (let i = 0; i < tunnels.length;) {
    const t = tunnels[i];
    if (t.archived === true && now - t.archivedAt >= purgeDays * DAY) {
      purged.push(t.name);
      tunnels.splice(i, 1);
    } else i++;
  }
  return purged;
}

module.exports = { tick, purge, failingDays, DAY, CREDENTIAL_ERROR };
