/* The scope policy, mirrored from internal/authz/scope.go.
 *
 * This is a mirror and not an approximation. The demo exists to show the
 * real flow, and the part of the flow a customer most needs to believe is
 * the part where the API says no -- a stub that returned a 200 for every
 * route would be a mock-up of a product that does not exist.
 *
 * A route with no entry here is refused, exactly as the Go router refuses
 * it. That is deliberate: adding a route to the demo without stating its
 * scope must make it unreachable rather than fleet-wide.
 *
 * KEEP IN STEP WITH internal/authz/scope.go. verify.mjs fails if a route
 * the recordings contain has no entry here.
 */

export const Scope = {
  PUBLIC: 'public',
  SELF: 'self',
  OPERATOR: 'operator',
  TENANT: 'tenant',
  TENANT_ADMIN: 'tenant-admin',
};

export const POLICY = {
  // Fleet-wide infrastructure. Operator only.
  '/fleet/clusters': Scope.OPERATOR,
  '/fleet/nodes': Scope.OPERATOR,
  '/fleet/compliance': Scope.OPERATOR,
  '/fleet/drift': Scope.OPERATOR,
  // The support timeline mixes node-level records with tenant-level ones
  // and cannot be narrowed by rewriting one query parameter.
  '/fleet/events': Scope.OPERATOR,

  // Has a tenant column, so it narrows.
  '/fleet/allocations': Scope.TENANT,
  '/fleet/usage': Scope.TENANT,
  '/fleet/jobs': Scope.TENANT,
  '/fleet/logs': Scope.TENANT,
  '/fleet/endpoints': Scope.TENANT,

  // Carries the billing account identifier.
  '/fleet/invoices': Scope.TENANT_ADMIN,
  '/fleet/entitlements': Scope.TENANT_ADMIN,
  '/fleet/periods': Scope.TENANT_ADMIN,
  '/fleet/statements': Scope.TENANT_ADMIN,
  '/fleet/billing-export': Scope.TENANT_ADMIN,
  '/fleet/audit': Scope.TENANT_ADMIN,

  // Verification reads the whole trail; there is no narrowing that
  // preserves the answer.
  '/fleet/audit/verify': Scope.OPERATOR,

  // The signed head and the proofs over it. Deliberately the widest scope:
  // a checkpoint is worth something only once people other than the
  // operator hold copies.
  '/fleet/audit/checkpoint': Scope.SELF,
  '/fleet/audit/proof': Scope.SELF,
  '/fleet/audit/consistency': Scope.SELF,
  '/fleet/audit/pubkey': Scope.SELF,

  '/fleet/ratecard': Scope.SELF,
  '/fleet/me': Scope.SELF,

  '/healthz': Scope.PUBLIC,
  '/fleet': Scope.PUBLIC,
  '/fleet/openapi': Scope.PUBLIC,
};

/* The tenant tree on the pilot. dc-shanghai is a data centre reselling to
 * acme and globex; acme resells again to acme-research. lab-co and maas-co
 * buy directly. This is what makes the recursive-billing story visible. */
export const TENANT_TREE = {
  'dc-shanghai': { parent: null, billedTo: 'dc-shanghai' },
  acme: { parent: 'dc-shanghai', billedTo: 'dc-shanghai' },
  globex: { parent: 'dc-shanghai', billedTo: 'dc-shanghai' },
  'acme-research': { parent: 'acme', billedTo: 'dc-shanghai' },
  'lab-co': { parent: null, billedTo: 'lab-co' },
  'maas-co': { parent: null, billedTo: 'maas-co' },
};

/** Every tenancy a principal reaches: their own, plus everything beneath
 *  them. A parent administers its sub-tenants -- it sold them the capacity
 *  and is liable for what they spend. Mirrors internal/tenancy. */
export function reach(tenants) {
  const out = new Set();
  const add = (name) => {
    if (out.has(name)) return;
    out.add(name);
    for (const [child, meta] of Object.entries(TENANT_TREE)) {
      if (meta.parent === name) add(child);
    }
  };
  for (const t of tenants) add(t);
  return [...out];
}

/** decide answers what the router does with this request.
 *
 *  Returns {allow, tenant, status, reason}. `tenant` is the narrowing the
 *  router REWRITES onto the query -- the handler downstream never sees the
 *  caller's own choice, which is what stops a caller naming someone else's
 *  tenancy. */
export function decide(path, principal, askedTenant) {
  const scope = POLICY[path];

  if (!scope) {
    return {
      allow: false,
      status: 403,
      reason: `no scope policy for ${path}; a route with no entry is refused`,
    };
  }
  if (scope === Scope.PUBLIC) return { allow: true, tenant: null };

  if (!principal) {
    return { allow: false, status: 401, reason: 'a valid bearer token is required' };
  }
  if (scope === Scope.SELF) return { allow: true, tenant: null };

  if (scope === Scope.OPERATOR) {
    if (!principal.operator) {
      return { allow: false, status: 403, reason: 'this endpoint is fleet-wide and requires the operator grant' };
    }
    return { allow: true, tenant: null };
  }

  const needsAdmin = scope === Scope.TENANT_ADMIN;
  if (needsAdmin && !principal.operator && !principal.tenantAdmin) {
    return {
      allow: false,
      status: 403,
      reason: 'this endpoint carries commercial data and requires the tenant administration grant',
    };
  }

  // An operator reads tenant-scoped routes unnarrowed, or narrowed to any
  // tenant they name.
  if (principal.operator) return { allow: true, tenant: askedTenant || null };

  const mine = reach(principal.tenants || []);
  if (mine.length === 0) {
    return { allow: false, status: 403, reason: 'the caller holds no tenancies' };
  }
  if (askedTenant) {
    if (!mine.includes(askedTenant)) {
      return {
        allow: false,
        status: 403,
        reason: `the caller does not hold tenancy ${askedTenant}`,
      };
    }
    return { allow: true, tenant: askedTenant };
  }
  // No tenant asked for: narrow to the caller's own. A caller holding
  // several reads the first; a UI names one explicitly.
  return { allow: true, tenant: mine[0] };
}
