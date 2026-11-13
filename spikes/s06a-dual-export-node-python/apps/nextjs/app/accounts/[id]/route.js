// SPDX-License-Identifier: Apache-2.0
export async function GET(_req, { params }) {
  const { id } = await params;
  if (id === 'GMISSING') return Response.json({ error: 'account not found' }, { status: 404 });
  return Response.json({ id, balance: '100.0000000' });
}
