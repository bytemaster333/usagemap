// SPDX-License-Identifier: Apache-2.0
export async function GET(_req, { params }) {
  const { code, issuer } = await params;
  return Response.json({ code, issuer });
}
