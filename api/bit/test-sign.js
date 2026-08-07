// Disabled production debug route. The previous implementation made multiple
// credential-backed probe requests and returned signing preimages publicly.
export default function handler(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).json({ error: 'Not found' });
}
