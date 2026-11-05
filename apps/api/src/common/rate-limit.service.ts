import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from '../database/redis.service';

/** Fixed-window limits shared by all API instances (Redis). Throws 429 with a Retry-After hint when exceeded. */
@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  async consume(key: string, limit: number, windowSec: number, message = 'Too many attempts. Please wait and try again.') {
    const { count, ttl } = await this.redis.hit(key, windowSec);
    if (count > limit) throw new HttpException({ statusCode: 429, error: 'Too Many Requests', message, retryAfterSeconds: Math.max(1, ttl) }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
