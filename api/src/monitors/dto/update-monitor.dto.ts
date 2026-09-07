import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Every field optional, validated by the same rules as creation.
 *
 * Written out rather than derived with PartialType from @nestjs/mapped-types: that
 * package is ESM-only, which the CommonJS test runner cannot load. Twenty lines of
 * duplication is a better trade than an ESM/CJS bridge in the build for one helper.
 */
export class UpdateMonitorDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: true,
  })
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(86_400)
  intervalSec?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(599)
  expectedStatus?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(30_000)
  timeoutMs?: number;

  @IsOptional()
  @IsBoolean()
  paused?: boolean;
}
