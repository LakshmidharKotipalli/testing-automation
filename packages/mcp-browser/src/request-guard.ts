import type { WorkPacket } from "@browserswarm/core";
/** Trusted host hook. Never accepts model supplied source or paths. CDP Fetch checks every redirect hop. */
export function guardSource(packet: WorkPacket, readyPath: string, readOnly: boolean): string {
  return `const fs = require('node:fs');
const scope = ${JSON.stringify({ domains: packet.allowedDomains, subdomains: packet.allowSubdomains, readOnly, hash: packet.workPacketHash, readyPath })};
exports.default = async ({ page }) => {
  const context = page.context();
  if (context.__bsGuardInstalled) { await page.close(); throw new Error('additional_tabs_blocked'); }
  context.__bsGuardInstalled = true;
  context.on('page', p => { if (p !== page) void p.close(); });
  page.on('download', d => void d.cancel());
  const cdp = await context.newCDPSession(page);
  const allowed = raw => { try { const u = new URL(raw); const h = u.hostname.toLowerCase().replace(/\\.$/, ''); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && scope.domains.some(d => h === d || (scope.subdomains && h.endsWith('.' + d))); } catch { return false; } };
  cdp.on('Fetch.requestPaused', async e => {
    const ok = allowed(e.request.url) && (!scope.readOnly || ['GET', 'HEAD'].includes(e.request.method));
    try {
      if (!ok) {
        fs.appendFileSync(scope.readyPath + '.blocked', JSON.stringify({ url:e.request.url, method:e.request.method, isNavigation:e.resourceType === 'Document', reason: 'request_scope' }) + '\\n');
        await cdp.send('Fetch.failRequest', { requestId:e.requestId, errorReason:'BlockedByClient' });
      } else await cdp.send('Fetch.continueRequest', { requestId:e.requestId });
    } catch { await page.close().catch(() => {}); }
  });
  await cdp.send('Fetch.enable', { patterns:[{ urlPattern:'*', requestStage:'Request' }] });
  fs.writeFileSync(scope.readyPath, scope.hash, { mode:0o600 });
};`;
}
