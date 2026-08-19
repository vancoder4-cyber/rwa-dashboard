import { validateDeploymentProvenance } from './_lib/deployment-provenance.js';

export function buildDeploymentProvenancePayload(env = process.env, now = new Date()) {
  const provenance = validateDeploymentProvenance(env, { requireProductionRef:true });
  const check = {
    name:'deployment-provenance',
    status:provenance.valid ? 'pass' : 'fail',
    critical:true,
    environment:provenance.environment,
    ref:provenance.ref,
    commit:provenance.commit,
    expectedRef:provenance.expectedRef,
    reason:provenance.reason,
  };
  return {
    httpStatus:provenance.valid ? 200 : 503,
    payload:{
      schemaVersion:'rwa-deployment-provenance/v1',
      service:'avenir-rwa-analyst',
      status:check.status,
      generatedAt:now.toISOString(),
      environment:provenance.environment,
      ref:provenance.ref,
      commit:provenance.commit,
      checks:[check],
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error:'Method not allowed' });
  }
  if (Object.keys(req.query || {}).length) return res.status(400).json({ error:'Query parameters are not supported' });

  const result = buildDeploymentProvenancePayload();
  return res.status(result.httpStatus).json(result.payload);
}
