// SPDX-License-Identifier: Apache-2.0
export const dynamic = 'force-dynamic';
export function GET() {
  throw new Error('boom');
}
