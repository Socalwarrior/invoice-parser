// api/parse-invoice/index.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import pdf from 'pdf-parse';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // basic CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const { fileUrl } = (req.body || {}) as { fileUrl?: string };
    if (!fileUrl) return res.status(400).json({ error: 'Missing fileUrl' });

    const r = await fetch(fileUrl);
    if (!r.ok) return res.status(400).json({ error: 'Could not fetch fileUrl' });

    const buf = Buffer.from(await r.arrayBuffer());
    const { text } = await pdf(buf);
    return res.status(200).json({ text });
  } catch (e: any) {
    return res.status(500).json({ error: e.message || 'Parser failed' });
  }
}
