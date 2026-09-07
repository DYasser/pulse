import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * Parses a `?limit=` query parameter, or rejects it.
 *
 * ParseIntPipe alone is not enough here: the global ValidationPipe runs with
 * enableImplicitConversion, which turns 'abc' into NaN before ParseIntPipe ever
 * sees a string to complain about. NaN then reaches Prisma's `take` and throws -
 * a 500 where a 400 belongs. A negative value is worse than an error: Prisma
 * reads backwards, so `?limit=-5` silently returns the oldest rows instead of the
 * newest.
 */
@Injectable()
export class ParseLimitPipe implements PipeTransform<unknown, number> {
  constructor(
    private readonly defaultValue: number,
    private readonly max: number,
  ) {}

  transform(value: unknown): number {
    if (value === undefined || value === null || value === '') {
      return this.defaultValue;
    }

    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new BadRequestException('limit must be a whole number');
    }

    if (parsed < 1) {
      throw new BadRequestException('limit must be at least 1');
    }

    return Math.min(parsed, this.max);
  }
}
