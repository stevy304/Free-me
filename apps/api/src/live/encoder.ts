import { BadRequestException } from '@nestjs/common';

/** nginx adds client metadata and encoder-specific arguments; validate only the fields we consume. */
export function encoderCallback(body: unknown): { name: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid encoder callback.');
  const name = (body as Record<string, unknown>).name;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new BadRequestException('Invalid stream name.');
  return { name };
}

export function validEncoderUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['rtmp:', 'rtmps:'].includes(url.protocol) && !!url.hostname && url.pathname.length > 1
      && !url.username && !url.password && !url.search && !url.hash && !/\s/.test(value);
  } catch { return false; }
}
