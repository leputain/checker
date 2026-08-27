import { NextResponse } from 'next/server';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET() {
  return NextResponse.json({ status: 'ok' }, { headers: NO_STORE });
}
